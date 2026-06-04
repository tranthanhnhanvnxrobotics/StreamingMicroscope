/*
 * stepper_control.h
 *
 *  Created on: Mar 28, 2026
 *      Author: User
 */

#ifndef APP_STEPPER_CONTROL_STEPPER_CONTROL_H_
#define APP_STEPPER_CONTROL_STEPPER_CONTROL_H_

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"
#include <stdbool.h>
#include <stdint.h>

/*
 * Current phase: single motor (focus) uses STEP/DIR/EN macros from main.h
 * STEP_PIN  -> PB0
 * DIR_PIN   -> PB1
 * EN_PIN    -> PA4  (active LOW)
 */
#ifndef STEPPER_STEP_GPIO_PORT
#define STEPPER_STEP_GPIO_PORT STEP_GPIO_Port
#endif

#ifndef STEPPER_STEP_PIN
#define STEPPER_STEP_PIN STEP_Pin
#endif

#ifndef STEPPER_DIR_GPIO_PORT
#define STEPPER_DIR_GPIO_PORT DIR_GPIO_Port
#endif

#ifndef STEPPER_DIR_PIN
#define STEPPER_DIR_PIN DIR_Pin
#endif

#ifndef STEPPER_EN_GPIO_PORT
#define STEPPER_EN_GPIO_PORT EN_GPIO_Port
#endif

#ifndef STEPPER_EN_PIN
#define STEPPER_EN_PIN EN_Pin
#endif

#ifndef STEPPER_HOLD_ON_STOP
#define STEPPER_HOLD_ON_STOP 1U
#endif

#ifndef STEPPER_HOLD_MS_AFTER_STOP
/* 0U = keep holding indefinitely; >0U = hold for N ms then release */
#define STEPPER_HOLD_MS_AFTER_STOP 0U
#endif

typedef struct {
  TIM_HandleTypeDef *htim;
  uint32_t timerTickHz;
  uint32_t stepHz;
  uint32_t accumulator;
  uint32_t targetSteps;
  uint32_t emittedSteps;
  bool running;
  bool pulseHighPending;
  bool autoStopAfterPulse;
  bool directionCw;
  uint32_t holdTicksRemaining;
} StepperControl;

void Stepper_Init(StepperControl *ctrl, TIM_HandleTypeDef *htim, uint32_t timerTickHz);
void Stepper_EnableDriver(StepperControl *ctrl, bool enable);
void Stepper_Run(StepperControl *ctrl, bool directionCw, uint32_t stepHz);
void Stepper_MoveSteps(StepperControl *ctrl, bool directionCw, uint32_t stepHz, uint32_t steps);
void Stepper_Stop(StepperControl *ctrl);
bool Stepper_IsRunning(const StepperControl *ctrl);
void Stepper_OnTimerTickISR(StepperControl *ctrl);

#ifdef __cplusplus
}
#endif

#endif
