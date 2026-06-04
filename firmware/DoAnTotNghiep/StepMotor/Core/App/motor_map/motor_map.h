/*
 * motor_map.h
 *
 *  Created on: Mar 29, 2026
 *      Author: User
 */

#ifndef APP_MOTOR_MAP_MOTOR_MAP_H_
#define APP_MOTOR_MAP_MOTOR_MAP_H_


#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"
#include <stdbool.h>
#include <stdint.h>

/*
 * Placeholder for future dual-motor phase.
 * Current firmware does not consume this map in app_control.c yet.
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

MotorPinMap MotorMap_GetFocus(void);

#ifdef __cplusplus
}
#endif


#endif /* APP_MOTOR_MAP_MOTOR_MAP_H_ */
