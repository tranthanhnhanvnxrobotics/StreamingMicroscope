/*
 * app_control.h
 *
 *  Created on: Mar 28, 2026
 *      Author: User
 */

#ifndef APP_APP_CONTROL_APP_CONTROL_H_
#define APP_APP_CONTROL_APP_CONTROL_H_

#ifdef __cplusplus
extern "C" {
#endif
#include "main.h"
#include "FreeRTOS.h"
#include "task.h"

void AppControl_Init(
	UART_HandleTypeDef *huart,
	TIM_HandleTypeDef *stepperTimer,
	TIM_HandleTypeDef *pwmTimer,
	TIM_HandleTypeDef *encoderXTimer,
	TIM_HandleTypeDef *encoderYTimer,
	I2C_HandleTypeDef *hi2c,
	uint32_t timerTickHz
);
void AppControl_Start(void);
void AppControl_Task(void);
void AppControl_Task1ms(void);

void AppControl_OnTimerTickISR(void);
void AppControl_OnRxCpltISR(void);
void AppControl_OnTxCpltISR(UART_HandleTypeDef *huart);
void AppControl_OnEndstopEdgeISR(uint16_t gpioPin);

void AppControl_SetControlTaskHandle(TaskHandle_t handle);

#ifdef __cplusplus
}
#endif

#endif /* APP_APP_CONTROL_APP_CONTROL_H_ */
