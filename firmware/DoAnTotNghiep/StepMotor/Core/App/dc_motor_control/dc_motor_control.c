#include "dc_motor_control.h"

static void set_in_pins_x(int8_t direction) {
  if (direction > 0) {
    HAL_GPIO_WritePin(INN1_GPIO_Port, INN1_Pin, GPIO_PIN_SET);
    HAL_GPIO_WritePin(INN2_GPIO_Port, INN2_Pin, GPIO_PIN_RESET);
  } else if (direction < 0) {
    HAL_GPIO_WritePin(INN1_GPIO_Port, INN1_Pin, GPIO_PIN_RESET);
    HAL_GPIO_WritePin(INN2_GPIO_Port, INN2_Pin, GPIO_PIN_SET);
  } else {
    HAL_GPIO_WritePin(INN1_GPIO_Port, INN1_Pin, GPIO_PIN_RESET);
    HAL_GPIO_WritePin(INN2_GPIO_Port, INN2_Pin, GPIO_PIN_RESET);
  }
}

static void set_in_pins_y(int8_t direction) {
  if (direction > 0) {
    HAL_GPIO_WritePin(INN3_GPIO_Port, INN3_Pin, GPIO_PIN_SET);
    HAL_GPIO_WritePin(INN4_GPIO_Port, INN4_Pin, GPIO_PIN_RESET);
  } else if (direction < 0) {
    HAL_GPIO_WritePin(INN3_GPIO_Port, INN3_Pin, GPIO_PIN_RESET);
    HAL_GPIO_WritePin(INN4_GPIO_Port, INN4_Pin, GPIO_PIN_SET);
  } else {
    HAL_GPIO_WritePin(INN3_GPIO_Port, INN3_Pin, GPIO_PIN_RESET);
    HAL_GPIO_WritePin(INN4_GPIO_Port, INN4_Pin, GPIO_PIN_RESET);
  }
}

void DcMotor_Init(
  DcMotorControl *ctrl,
  TIM_HandleTypeDef *pwmTim,
  TIM_HandleTypeDef *encoderXTim,
  TIM_HandleTypeDef *encoderYTim,
  uint32_t pwmChannelX,
  uint32_t pwmChannelY,
  uint32_t pwmPeriod
) {
  if (ctrl == NULL) {
    return;
  }

  ctrl->pwmTim = pwmTim;
  ctrl->encoderXTim = encoderXTim;
  ctrl->encoderYTim = encoderYTim;
  ctrl->pwmChannelX = pwmChannelX;
  ctrl->pwmChannelY = pwmChannelY;
  ctrl->pwmPeriod = pwmPeriod;
  ctrl->ready = (pwmTim != NULL && encoderXTim != NULL && encoderYTim != NULL && pwmPeriod > 0U);

  set_in_pins_x(0);
  set_in_pins_y(0);
}

void DcMotor_Start(DcMotorControl *ctrl) {
  if (ctrl == NULL || !ctrl->ready) {
    return;
  }

  HAL_TIM_PWM_Start(ctrl->pwmTim, ctrl->pwmChannelX);
  HAL_TIM_PWM_Start(ctrl->pwmTim, ctrl->pwmChannelY);
  HAL_TIM_Encoder_Start(ctrl->encoderXTim, TIM_CHANNEL_ALL);
  HAL_TIM_Encoder_Start(ctrl->encoderYTim, TIM_CHANNEL_ALL);
  __HAL_TIM_SET_COMPARE(ctrl->pwmTim, ctrl->pwmChannelX, 0U);
  __HAL_TIM_SET_COMPARE(ctrl->pwmTim, ctrl->pwmChannelY, 0U);
}

void DcMotor_StopAll(DcMotorControl *ctrl) {
  if (ctrl == NULL || !ctrl->ready) {
    return;
  }

  set_in_pins_x(0);
  set_in_pins_y(0);
  __HAL_TIM_SET_COMPARE(ctrl->pwmTim, ctrl->pwmChannelX, 0U);
  __HAL_TIM_SET_COMPARE(ctrl->pwmTim, ctrl->pwmChannelY, 0U);
}

void DcMotor_SetAxis(DcMotorControl *ctrl, DcMotorAxis axis, int8_t direction, uint32_t duty) {
  if (ctrl == NULL || !ctrl->ready) {
    return;
  }

  if (duty > ctrl->pwmPeriod) {
    duty = ctrl->pwmPeriod;
  }

  if (axis == DC_MOTOR_AXIS_X) {
    set_in_pins_x(direction);
    __HAL_TIM_SET_COMPARE(ctrl->pwmTim, ctrl->pwmChannelX, duty);
  } else {
    set_in_pins_y(direction);
    __HAL_TIM_SET_COMPARE(ctrl->pwmTim, ctrl->pwmChannelY, duty);
  }
}

int32_t DcMotor_GetEncoderX(const DcMotorControl *ctrl) {
  if (ctrl == NULL || ctrl->encoderXTim == NULL) {
    return 0;
  }
  return (int32_t)__HAL_TIM_GET_COUNTER(ctrl->encoderXTim);
}

int32_t DcMotor_GetEncoderY(const DcMotorControl *ctrl) {
  if (ctrl == NULL || ctrl->encoderYTim == NULL) {
    return 0;
  }
  return (int32_t)__HAL_TIM_GET_COUNTER(ctrl->encoderYTim);
}
