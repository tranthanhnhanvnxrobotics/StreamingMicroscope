# Patch: 1 lần nhấn = đúng 1 vạch (NEMA17)

Áp dụng cho code bạn gửi (`app_control.c`, `stepper_control.c/.h`).

---

## 1) Sửa `stepper_control.h`

Thêm khả năng chạy theo **số step hữu hạn**:

```c
#pragma once

#include "main.h"

#include <stdbool.h>
#include <stdint.h>

typedef struct {
  TIM_HandleTypeDef *htim;
  uint32_t timerTickHz;
  uint32_t stepHz;
  uint32_t accumulator;
  bool running;
  bool pulseHighPending;
  bool directionCw;
  uint32_t stepsRemaining;
  bool finiteMove;
} StepperControl;

void Stepper_Init(StepperControl *ctrl, TIM_HandleTypeDef *htim, uint32_t timerTickHz);
void Stepper_EnableDriver(StepperControl *ctrl, bool enable);
void Stepper_Run(StepperControl *ctrl, bool directionCw, uint32_t stepHz);
void Stepper_RunSteps(StepperControl *ctrl, bool directionCw, uint32_t stepHz, uint32_t steps);
void Stepper_Stop(StepperControl *ctrl);
void Stepper_OnTimerTickISR(StepperControl *ctrl);
```

---

## 2) Sửa `stepper_control.c`

Thêm `Stepper_RunSteps(...)` và auto-stop khi đủ step:

```c
#include "stepper_control.h"

static void set_step_pin(GPIO_PinState state) {
  HAL_GPIO_WritePin(STEPPER_STEP_GPIO_PORT, STEPPER_STEP_PIN, state);
}

static void set_dir_pin(bool directionCw) {
  HAL_GPIO_WritePin(
    STEPPER_DIR_GPIO_PORT,
    STEPPER_DIR_PIN,
    directionCw ? GPIO_PIN_SET : GPIO_PIN_RESET
  );
}

void Stepper_Init(StepperControl *ctrl, TIM_HandleTypeDef *htim, uint32_t timerTickHz) {
  ctrl->htim = htim;
  ctrl->timerTickHz = timerTickHz;
  ctrl->stepHz = 0U;
  ctrl->accumulator = 0U;
  ctrl->running = false;
  ctrl->pulseHighPending = false;
  ctrl->directionCw = true;
  ctrl->stepsRemaining = 0U;
  ctrl->finiteMove = false;

  set_step_pin(GPIO_PIN_RESET);
  set_dir_pin(true);
  Stepper_EnableDriver(ctrl, false);
}

void Stepper_EnableDriver(StepperControl *ctrl, bool enable) {
  (void)ctrl;
  HAL_GPIO_WritePin(
    STEPPER_EN_GPIO_PORT,
    STEPPER_EN_PIN,
    enable ? GPIO_PIN_RESET : GPIO_PIN_SET
  );
}

void Stepper_Run(StepperControl *ctrl, bool directionCw, uint32_t stepHz) {
  if (stepHz == 0U || ctrl->timerTickHz == 0U) {
    Stepper_Stop(ctrl);
    return;
  }

  if (stepHz > ctrl->timerTickHz) {
    stepHz = ctrl->timerTickHz;
  }

  ctrl->directionCw = directionCw;
  ctrl->stepHz = stepHz;
  ctrl->running = true;
  ctrl->accumulator = 0U;
  ctrl->pulseHighPending = false;
  ctrl->stepsRemaining = 0U;
  ctrl->finiteMove = false;

  set_dir_pin(directionCw);
  Stepper_EnableDriver(ctrl, true);
}

void Stepper_RunSteps(StepperControl *ctrl, bool directionCw, uint32_t stepHz, uint32_t steps) {
  if (steps == 0U) {
    return;
  }

  Stepper_Run(ctrl, directionCw, stepHz);
  ctrl->finiteMove = true;
  ctrl->stepsRemaining = steps;
}

void Stepper_Stop(StepperControl *ctrl) {
  ctrl->running = false;
  ctrl->stepHz = 0U;
  ctrl->accumulator = 0U;
  ctrl->pulseHighPending = false;
  ctrl->stepsRemaining = 0U;
  ctrl->finiteMove = false;

  set_step_pin(GPIO_PIN_RESET);
  Stepper_EnableDriver(ctrl, false);
}

void Stepper_OnTimerTickISR(StepperControl *ctrl) {
  if (!ctrl->running) {
    return;
  }

  if (ctrl->pulseHighPending) {
    set_step_pin(GPIO_PIN_RESET);
    ctrl->pulseHighPending = false;
    return;
  }

  ctrl->accumulator += ctrl->stepHz;

  if (ctrl->accumulator >= ctrl->timerTickHz) {
    ctrl->accumulator -= ctrl->timerTickHz;
    set_step_pin(GPIO_PIN_SET);
    ctrl->pulseHighPending = true;

    if (ctrl->finiteMove) {
      if (ctrl->stepsRemaining > 0U) {
        ctrl->stepsRemaining--;
      }
      if (ctrl->stepsRemaining == 0U) {
        Stepper_Stop(ctrl);
      }
    }
  }
}
```

---

## 3) Sửa `app_control.c`

Đổi `FOCUS_IN/OUT` sang chạy số step cố định cho mỗi lần nhấn:

```c
#define APP_DEFAULT_STEP_HZ 800U
#define APP_FOCUS_STEPS_PER_CLICK 32U
```

Trong `execute_command(...)` thay 2 case:

```c
case UART_CMD_FOCUS_IN:
  Stepper_RunSteps(&s_stepper, true, APP_DEFAULT_STEP_HZ, APP_FOCUS_STEPS_PER_CLICK);
  s_isMoving = false;
  ack_command(name);
  break;

case UART_CMD_FOCUS_OUT:
  Stepper_RunSteps(&s_stepper, false, APP_DEFAULT_STEP_HZ, APP_FOCUS_STEPS_PER_CLICK);
  s_isMoving = false;
  ack_command(name);
  break;
```

`STOP` giữ nguyên.

> Gợi ý: vì giờ là one-shot, timeout trong `AppControl_Task()` gần như không còn cần cho FOCUS command.

---

## 4) Cách tính chuẩn `APP_FOCUS_STEPS_PER_CLICK`

Công thức tổng quát:

\[
\text{stepsPerClick} = \frac{\text{motorStepsPerRev} \times \text{microstep} \times \text{gearRatio}}{\text{ticksPerRevOnKnob}}
\]

Với NEMA17 thường: `motorStepsPerRev = 200`.

Ví dụ trực tiếp trục (`gearRatio = 1`), driver `1/16`, núm `100 vạch/vòng`:

\[
\text{stepsPerClick} = \frac{200 \times 16 \times 1}{100} = 32
\]

=> đặt `APP_FOCUS_STEPS_PER_CLICK = 32`.

---

## 5) Calib nhanh tại chỗ (2 phút)

1. Đánh dấu 1 vị trí trên núm.
2. Gửi 10 lệnh `FOCUS_IN` liên tiếp.
3. Đo số vạch thực tế đã đi (`actualTicks`).
4. Cập nhật:

\[
\text{newStepsPerClick} = \text{oldStepsPerClick} \times \frac{10}{actualTicks}
\]

5. Làm tròn số nguyên gần nhất, nạp lại firmware, test lại.

---

## 6) Lưu ý chiều quay

Nếu `FOCUS_IN` đang quay ngược ý muốn, chỉ cần đảo bool direction trong 2 case `FOCUS_IN/FOCUS_OUT`.
