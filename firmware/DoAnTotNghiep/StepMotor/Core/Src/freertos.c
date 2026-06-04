/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * File Name          : freertos.c
  * Description        : Code for __freertos__ applications
  ******************************************************************************
  */
/* USER CODE END Header */

/* Includes ------------------------------------------------------------------*/
#include "FreeRTOS.h"
#include "task.h"
#include "main.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include "app_control.h"
/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */
/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */
/* USER CODE END PD */

/* Private macro -------------------------------------------------------------*/
/* USER CODE BEGIN PM */
/* USER CODE END PM */

/* Private variables ---------------------------------------------------------*/
/* USER CODE BEGIN Variables */
extern TIM_HandleTypeDef htim2;
extern TIM_HandleTypeDef htim3;
extern TIM_HandleTypeDef htim1;
extern TIM_HandleTypeDef htim5;
extern UART_HandleTypeDef huart2;
extern I2C_HandleTypeDef hi2c2;
#define APP_CONTROL_TIMER_TICK_HZ 20000U

/* USER CODE END Variables */

/* Private function prototypes -----------------------------------------------*/
/* USER CODE BEGIN FunctionPrototypes */
void StartDefaultTask(void *argument);
void StartControlTask(void *argument);
/* USER CODE END FunctionPrototypes */

/* Private application code --------------------------------------------------*/
/* USER CODE BEGIN Application */
void StartDefaultTask(void *argument)
{
  (void)argument;
  for(;;)
  {
    osDelay(1);
  }
}

void StartControlTask(void *argument)
{
  (void)argument;

  AppControl_Init(&huart2, &htim5, &htim3, &htim2, &htim1, &hi2c2, APP_CONTROL_TIMER_TICK_HZ);
  AppControl_Start();
  AppControl_SetControlTaskHandle(xTaskGetCurrentTaskHandle());

  uint32_t lastTickMs = HAL_GetTick();

  for (;;)
  {
    /* Chờ notification tối đa 1ms */
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1));

    uint32_t now = HAL_GetTick();
    if ((int32_t)(now - lastTickMs) >= 1)
    {
      lastTickMs = now;
      AppControl_Task1ms();
    }
    else
    {
      /* Notification đến trước 1ms: xử lý task nhẹ (không tăng ping counter) */
      AppControl_Task();
    }
  }
}
/* USER CODE END Application */

