/*
 * motor_map.c
 *
 *  Created on: Mar 29, 2026
 *      Author: User
 */
#include "main.h"
#include <stdbool.h>
#include <stdint.h>

/*
 * Placeholder for future dual-motor mapping.
 * Current firmware uses a single focus motor via STEP/DIR/EN in stepper_control.c
 */

typedef struct {
  GPIO_TypeDef *stepPort;
  uint16_t stepPin;
  GPIO_TypeDef *dirPort;
  uint16_t dirPin;
  GPIO_TypeDef *enPort;
  uint16_t enPin;
  bool enActiveLow;
} MotorPinMap;

MotorPinMap MotorMap_GetFocus(void) {
  MotorPinMap map = {
    .stepPort = STEP_GPIO_Port,
    .stepPin = STEP_Pin,
    .dirPort = DIR_GPIO_Port,
    .dirPin = DIR_Pin,
    .enPort = EN_GPIO_Port,
    .enPin = EN_Pin,
    .enActiveLow = true
  };
  return map;
}
