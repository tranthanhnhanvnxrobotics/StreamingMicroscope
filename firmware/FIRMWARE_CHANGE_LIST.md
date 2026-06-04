# Firmware Change List (STM32 - 2 Motor Architecture)

## Mục tiêu
Tách điều khiển thành 2 motor độc lập:
- `motion motor`: xử lý `MOVE_LEFT`, `MOVE_RIGHT`, `MOVE_UP`, `MOVE_DOWN`
- `focus motor`: xử lý `FOCUS_IN`, `FOCUS_OUT`

`STOP` dừng cả hai (giai đoạn đầu).

---

## 1) File cần sửa

### A. `Core/App/stepper_control/stepper_control.h`
**Cần thêm:** cấu hình pin theo từng instance (không hardcode global macro)

- Thêm struct cấu hình pin:
  - `GPIO_TypeDef* stepPort`, `uint16_t stepPin`
  - `GPIO_TypeDef* dirPort`, `uint16_t dirPin`
  - `GPIO_TypeDef* enPort`, `uint16_t enPin`
  - (tuỳ chọn) `bool enActiveLow`
- Trong `StepperControl` thêm field `config`.
- Đổi API init thành kiểu:
  - `Stepper_Init(StepperControl* ctrl, TIM_HandleTypeDef* htim, uint32_t timerTickHz, StepperPinConfig config)`

### B. `Core/App/stepper_control/stepper_control.c`
**Cần sửa:** bỏ dùng macro `STEPPER_*` cố định, dùng `ctrl->config.*`

- `set_step_pin(...)` -> nhận `StepperControl* ctrl`
- `set_dir_pin(...)` -> nhận `StepperControl* ctrl`
- `Stepper_EnableDriver(...)` -> xuất chân EN theo `ctrl->config.enActiveLow`
- `Stepper_Init(...)` -> lưu config vào instance

### C. `Core/App/app_control/app_control.c`
**Cần sửa lớn:** tạo 2 đối tượng stepper và remap command

- Thêm 2 biến static:
  - `static StepperControl s_stepperMotion;`
  - `static StepperControl s_stepperFocus;`
- Trong `AppControl_Init(...)`:
  - tạo `StepperPinConfig motionConfig` (pin motor 1)
  - tạo `StepperPinConfig focusConfig` (pin motor 2)
  - gọi `Stepper_Init(...)` cho cả 2
- Trong `execute_command(...)` remap:
  - `MOVE_*` -> `Stepper_Run(&s_stepperMotion, ...)`
  - `FOCUS_*` -> `Stepper_Run(&s_stepperFocus, ...)`
  - `STOP` -> `Stepper_Stop(&s_stepperMotion); Stepper_Stop(&s_stepperFocus);`
- Trong timeout logic (`AppControl_Task`): nếu timeout thì stop cả hai.
- Trong ISR tick (`AppControl_OnTimerTickISR`): gọi tick cho cả hai.

### D. `Core/App/app_control/app_control.h`
**Kiểm tra/điều chỉnh:**
- Nếu header đang ràng buộc 1 stepper thì mở rộng API trung tính hơn.
- Có thể giữ nguyên nếu chỉ sửa nội bộ `.c`.

### E. `Core/Src/main.c`
**Kiểm tra pin output init:**
- Thêm GPIO output cho bộ pin motor 2 (`STEP2`, `DIR2`, `EN2`).
- Đảm bảo default state:
  - `STEP = LOW`
  - `DIR` theo default mong muốn
  - `EN = DISABLE`

> Nếu pin motor 2 chưa có trong CubeMX thì cần add ở `.ioc`, regenerate code rồi merge lại USER CODE sections.

### F. `Core/App/uart_protocol/uart_protocol.c`
**Có thể giữ nguyên** (vì parse command đã tách `MOVE_*`/`FOCUS_*` rõ ràng).

---

## 2) File có thể cần thêm mới

### A. `Core/App/app_control/motor_map.h` (khuyến nghị)
Tập trung map pin theo vai trò motor để dễ bảo trì:
- `MOTION_STEP_PORT/PIN`, `MOTION_DIR_PORT/PIN`, `MOTION_EN_PORT/PIN`
- `FOCUS_STEP_PORT/PIN`, `FOCUS_DIR_PORT/PIN`, `FOCUS_EN_PORT/PIN`

### B. `Core/App/app_control/motor_map.c` (tuỳ chọn)
Nếu muốn trả config bằng hàm:
- `StepperPinConfig MotorMap_GetMotionConfig(void)`
- `StepperPinConfig MotorMap_GetFocusConfig(void)`

---

## 3) Mapping command mục tiêu

- `CMD:MOVE_LEFT:*`  -> Motion motor (dir = CCW)
- `CMD:MOVE_RIGHT:*` -> Motion motor (dir = CW)
- `CMD:MOVE_UP:*`    -> Motion motor (dir = CW/CCW tuỳ cơ khí)
- `CMD:MOVE_DOWN:*`  -> Motion motor (dir đối nghịch UP)
- `CMD:FOCUS_IN:*`   -> Focus motor
- `CMD:FOCUS_OUT:*`  -> Focus motor
- `CMD:STOP:*`       -> Stop tất cả motor

---

## 3.1) UART feedback bắt buộc để web hiển thị viền đỏ/xanh

Để web biết lúc nào **đang chạy** (viền đỏ) và **hoàn tất** (viền xanh), firmware nên trả feedback theo dòng UART:

- Khi bắt đầu chạy lệnh:
  - `MOTOR_START:<COMMAND>`
  - ví dụ: `MOTOR_START:MOVE_UP`
- Khi chạy xong lệnh one-shot:
  - `MOTOR_DONE:<COMMAND>`
  - ví dụ: `MOTOR_DONE:MOVE_UP`

Backend hiện parse linh hoạt các từ khoá như `STARTED/RUNNING/BUSY` và `DONE/COMPLETE/IDLE/STOPPED`,
nhưng format khuyến nghị ổn định nhất vẫn là `MOTOR_START:*` và `MOTOR_DONE:*`.

> Nếu không gửi `MOTOR_DONE`, backend sẽ tự timeout để mở khoá lệnh sau vài giây,
> nhưng trải nghiệm realtime sẽ kém hơn.

---

## 4) Test checklist sau khi sửa

1. Gửi `FOCUS_IN/OUT` -> chỉ motor focus chạy.
2. Gửi `MOVE_LEFT/RIGHT/UP/DOWN` -> chỉ motor motion chạy.
3. Gửi `STOP` khi mỗi motor đang chạy -> cả hai dừng.
4. Bỏ gửi lệnh > timeout -> motor đang chạy tự dừng.
5. Kiểm tra nhiệt driver + chiều quay đúng theo cơ khí.

---

## 5) Ghi chú triển khai an toàn

- Không cắm/rút motor khi driver đang cấp nguồn.
- Luôn chung GND giữa MCU và driver logic.
- Với TMC2208, xác nhận mức logic EN active-low.
- Đặt dòng ban đầu thấp rồi tăng dần sau khi chạy ổn.
