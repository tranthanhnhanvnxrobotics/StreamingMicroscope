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

static void stop_internal(StepperControl *ctrl) {
  ctrl->running = false;
  ctrl->stepHz = 0U;
  ctrl->accumulator = 0U;
  ctrl->targetSteps = 0U;
  ctrl->emittedSteps = 0U;
  ctrl->pulseHighPending = false;
  ctrl->autoStopAfterPulse = false;

  set_step_pin(GPIO_PIN_RESET);
  if (STEPPER_HOLD_ON_STOP == 0U) {
    ctrl->holdTicksRemaining = 0U;
    Stepper_EnableDriver(ctrl, false);
  } else {
    if (STEPPER_HOLD_MS_AFTER_STOP == 0U) {
      ctrl->holdTicksRemaining = 0U;
      Stepper_EnableDriver(ctrl, true);
    } else if (ctrl->timerTickHz == 0U) {
      ctrl->holdTicksRemaining = 0U;
      Stepper_EnableDriver(ctrl, false);
    } else {
      Stepper_EnableDriver(ctrl, true);
      uint64_t ticks = ((uint64_t)STEPPER_HOLD_MS_AFTER_STOP * (uint64_t)ctrl->timerTickHz + 999ULL) / 1000ULL;
      if (ticks == 0ULL) {
        ticks = 1ULL;
      }
      if (ticks > 0xFFFFFFFFULL) {
        ticks = 0xFFFFFFFFULL;
      }
      ctrl->holdTicksRemaining = (uint32_t)ticks;
    }
  }
}

void Stepper_Init(StepperControl *ctrl, TIM_HandleTypeDef *htim, uint32_t timerTickHz) {
  ctrl->htim = htim;
  ctrl->timerTickHz = timerTickHz;
  ctrl->stepHz = 0U;
  ctrl->accumulator = 0U;
  ctrl->targetSteps = 0U;
  ctrl->emittedSteps = 0U;
  ctrl->running = false;
  ctrl->pulseHighPending = false;
  ctrl->autoStopAfterPulse = false;
  ctrl->directionCw = true;
  ctrl->holdTicksRemaining = 0U;

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
  Stepper_MoveSteps(ctrl, directionCw, stepHz, 0U);
}

void Stepper_MoveSteps(StepperControl *ctrl, bool directionCw, uint32_t stepHz, uint32_t steps) {
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
  ctrl->targetSteps = steps;
  ctrl->emittedSteps = 0U;
  ctrl->pulseHighPending = false;
  ctrl->autoStopAfterPulse = false;
  ctrl->holdTicksRemaining = 0U;

  set_dir_pin(directionCw);
  Stepper_EnableDriver(ctrl, true);
}

void Stepper_Stop(StepperControl *ctrl) {
  stop_internal(ctrl);
}

bool Stepper_IsRunning(const StepperControl *ctrl) {
  return (ctrl != NULL) ? ctrl->running : false;
}

void Stepper_OnTimerTickISR(StepperControl *ctrl) {
  if (!ctrl->running) {
    if (ctrl->holdTicksRemaining > 0U) {
      ctrl->holdTicksRemaining--;
      if (ctrl->holdTicksRemaining == 0U) {
        Stepper_EnableDriver(ctrl, false);
      }
    }
    return;
  }

  if (ctrl->pulseHighPending) {
    set_step_pin(GPIO_PIN_RESET);
    ctrl->pulseHighPending = false;

    if (ctrl->autoStopAfterPulse) {
      stop_internal(ctrl);
    }

    return;
  }

  ctrl->accumulator += ctrl->stepHz;

  if (ctrl->accumulator >= ctrl->timerTickHz) {
    ctrl->accumulator -= ctrl->timerTickHz;
    set_step_pin(GPIO_PIN_SET);
    ctrl->pulseHighPending = true;

    if (ctrl->targetSteps > 0U) {
      ctrl->emittedSteps++;
      if (ctrl->emittedSteps >= ctrl->targetSteps) {
        ctrl->autoStopAfterPulse = true;
      }
    }
  }
}
