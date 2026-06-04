/*
 * dc_motor_control.h
 *
 *  Created on: May 15, 2026
 */

#ifndef APP_DC_MOTOR_CONTROL_DC_MOTOR_CONTROL_H_
#define APP_DC_MOTOR_CONTROL_DC_MOTOR_CONTROL_H_

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"
#include <stdbool.h>
#include <stdint.h>

typedef enum {
  DC_MOTOR_AXIS_X = 0,
  DC_MOTOR_AXIS_Y
} DcMotorAxis;

typedef struct {
  TIM_HandleTypeDef *pwmTim;
  TIM_HandleTypeDef *encoderXTim;
  TIM_HandleTypeDef *encoderYTim;
  uint32_t pwmChannelX;
  uint32_t pwmChannelY;
  uint32_t pwmPeriod;
  bool ready;
} DcMotorControl;

void DcMotor_Init(
  DcMotorControl *ctrl,
  TIM_HandleTypeDef *pwmTim,
  TIM_HandleTypeDef *encoderXTim,
  TIM_HandleTypeDef *encoderYTim,
  uint32_t pwmChannelX,
  uint32_t pwmChannelY,
  uint32_t pwmPeriod
);

void DcMotor_Start(DcMotorControl *ctrl);
void DcMotor_StopAll(DcMotorControl *ctrl);
void DcMotor_SetAxis(DcMotorControl *ctrl, DcMotorAxis axis, int8_t direction, uint32_t duty);
int32_t DcMotor_GetEncoderX(const DcMotorControl *ctrl);
int32_t DcMotor_GetEncoderY(const DcMotorControl *ctrl);

#ifdef __cplusplus
}
#endif

#endif /* APP_DC_MOTOR_CONTROL_DC_MOTOR_CONTROL_H_ */
