/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.h
  * @brief          : Header for main.c file.
  *                   This file contains the common defines of the application.
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2026 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
/* USER CODE END Header */

/* Define to prevent recursive inclusion -------------------------------------*/
#ifndef __MAIN_H
#define __MAIN_H

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "stm32f4xx_hal.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */

/* USER CODE END Includes */

/* Exported types ------------------------------------------------------------*/
/* USER CODE BEGIN ET */

/* USER CODE END ET */

/* Exported constants --------------------------------------------------------*/
/* USER CODE BEGIN EC */

/* USER CODE END EC */

/* Exported macro ------------------------------------------------------------*/
/* USER CODE BEGIN EM */

/* USER CODE END EM */

void HAL_TIM_MspPostInit(TIM_HandleTypeDef *htim);

/* Exported functions prototypes ---------------------------------------------*/
void Error_Handler(void);

/* USER CODE BEGIN EFP */

/* USER CODE END EFP */

/* Private defines -----------------------------------------------------------*/
#define EN_Pin GPIO_PIN_4
#define EN_GPIO_Port GPIOA
#define INN1_Pin GPIO_PIN_5
#define INN1_GPIO_Port GPIOA
#define STEP_Pin GPIO_PIN_0
#define STEP_GPIO_Port GPIOB
#define DIR_Pin GPIO_PIN_1
#define DIR_GPIO_Port GPIOB
#define ENDSTOP_MIN_Pin GPIO_PIN_12
#define ENDSTOP_MIN_GPIO_Port GPIOB
#define ENDSTOP_MIN_EXTI_IRQn EXTI15_10_IRQn
#define INN2_Pin GPIO_PIN_13
#define INN2_GPIO_Port GPIOB
#define INN3_Pin GPIO_PIN_14
#define INN3_GPIO_Port GPIOB
#define INN4_Pin GPIO_PIN_15
#define INN4_GPIO_Port GPIOB
#define ENDSTOP_X_Pin GPIO_PIN_10
#define ENDSTOP_X_GPIO_Port GPIOA
#define ENDSTOP_X_EXTI_IRQn EXTI15_10_IRQn
#define ENDSTOP_Y_Pin GPIO_PIN_11
#define ENDSTOP_Y_GPIO_Port GPIOA
#define ENDSTOP_Y_EXTI_IRQn EXTI15_10_IRQn

/* USER CODE BEGIN Private defines */

/* USER CODE END Private defines */

#ifdef __cplusplus
}
#endif

#endif /* __MAIN_H */
