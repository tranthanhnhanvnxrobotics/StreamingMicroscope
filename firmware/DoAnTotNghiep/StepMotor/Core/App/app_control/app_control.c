#include "app_control.h"

#include "../as5600/as5600.h"
#include "stepper_control.h"
#include "uart_protocol.h"
#include "../dc_motor_control/dc_motor_control.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#define APP_RX_LINE_MAX 80U
#define APP_RX_QUEUE_DEPTH 8U
#define APP_TX_LINE_MAX 96U
#define APP_TX_QUEUE_DEPTH 24U
#define APP_DEFAULT_STEP_HZ 500U

#define APP_FOCUS_MOTOR_FULL_STEPS_PER_REV 200U
#define APP_FOCUS_DRIVER_MICROSTEPS 8U
#define APP_FOCUS_KNOB_SMALL_TICKS_PER_REV 100U     
#define APP_FOCUS_MOTOR_REV_PER_KNOB_REV_NUM 1U
#define APP_FOCUS_MOTOR_REV_PER_KNOB_REV_DEN 1U
#define APP_FOCUS_STEP_MULTIPLIER_PERCENT 150U
#define APP_FOCUS_DIR_INVERT 1U
#define APP_FOCUS_POS_MIN 0
#define APP_FOCUS_POS_MAX_SAFE 420
#define APP_ENCODER_RAW_MAX 4095U
#define APP_ENCODER_COUNTS_PER_TURN (APP_ENCODER_RAW_MAX + 1U)
#define APP_ENCODER_INVERT 1U
#define APP_ENCODER_POS_INVERT 0U
#define APP_ENCODER_POS_MIN_SAFE 0
#define APP_ENCODER_POS_MIN_FOCUS_OUT_GUARD 50
/* Encoder travel after zero at MIN endstop (measured / default for this rig). */
#define APP_ENCODER_POS_MAX_CALIB 17480
#define APP_ENCODER_POS_MAX_SAFE 17450
#define APP_ENCODER_WRAP_THRESHOLD (APP_ENCODER_COUNTS_PER_TURN / 2U)
/*
 * Endstop electrical sense (must match wiring):
 * - main.c uses GPIO_PULLUP on ENDSTOP_MIN.
 * - Typical microswitch NC: COM→GND, NC→MCU pin. While NOT at limit, NC is closed → pin reads LOW.
 * When the carriage hits the stop, NC opens → pull-up → pin reads HIGH = "triggered".
 * - If you instead wire COM→3V3 / use NO contact, set this to GPIO_PIN_RESET or swap wires.
 */
#define APP_ENDSTOP_ACTIVE_LEVEL GPIO_PIN_SET

#ifndef APP_ENDSTOP_X_ACTIVE_LEVEL
#define APP_ENDSTOP_X_ACTIVE_LEVEL APP_ENDSTOP_ACTIVE_LEVEL
#endif

#ifndef ENDSTOP_MIN_GPIO_Port
#define ENDSTOP_MIN_GPIO_Port GPIOB
#endif

#ifndef ENDSTOP_MIN_Pin
#define ENDSTOP_MIN_Pin GPIO_PIN_12
#endif

#define APP_HOME_FAST_STEP_HZ 220U
#define APP_HOME_SLOW_STEP_HZ 120U
#define APP_HOME_BACKOFF_STEPS 24U
#define APP_HOME_SETTLE_MS 30U
#define APP_HOME_TIMEOUT_MS 120000U

#define APP_X_HOME_DUTY_PERCENT 80U
#define APP_X_HOME_TIMEOUT_MS 60000U
#define APP_X_MAX_COUNTS        (-7000)
/* Y homing: single-speed seek like X — stop immediately on endstop, reset encoder.
 * Overshoot drift is handled by process_xy_endstop_guard() clamp (yEncTotal < 0). */
#define APP_Y_HOME_DUTY_PERCENT APP_X_HOME_DUTY_PERCENT
#define APP_Y_HOME_TIMEOUT_MS 60000U
#define APP_Y_MAX_COUNTS        10000
#define APP_X_DIR_INVERT 1U
#define APP_Y_DIR_INVERT 1U
#define APP_XY_DUTY_SCALE_NUM 90U
#define APP_XY_DUTY_SCALE_DEN 100U

#define APP_PING_INTERVAL_MS 500U

#define APP_ENCODER_POLL_INTERVAL_MS 10U
#define APP_ENCODER_I2C_BACKOFF_MS 200U

#ifndef APP_AS5600_I2C_SCL_GPIO_Port
#define APP_AS5600_I2C_SCL_GPIO_Port GPIOB
#endif

#ifndef APP_AS5600_I2C_SCL_Pin
#define APP_AS5600_I2C_SCL_Pin GPIO_PIN_10
#endif

#ifndef APP_AS5600_I2C_SDA_GPIO_Port
#define APP_AS5600_I2C_SDA_GPIO_Port GPIOB
#endif

#ifndef APP_AS5600_I2C_SDA_Pin
#define APP_AS5600_I2C_SDA_Pin GPIO_PIN_3
#endif

/* Cruise duty: higher = farther nudge per press (same stop time). Shared default for X/Y. */
#define APP_XY_PWM_DUTY_PERCENT 32U
#define APP_XY_MIN_DUTY_PERCENT 28U
#define APP_Y_MIN_DUTY_PERCENT APP_XY_MIN_DUTY_PERCENT
/* Kick: higher/longer = less stall buzz; does not need to match cruise duty. */
#define APP_XY_KICK_DUTY_PERCENT 88U
#define APP_Y_KICK_DUTY_PERCENT APP_XY_KICK_DUTY_PERCENT
#define APP_XY_KICK_DURATION_MS 140U
/* Y axis: kick và auto-stop riêng vì Y encoder 40x nhanh hơn X.
 * X: 20 enc/195ms, Y: 800 enc/195ms → cần Y chạy ngắn hơn nhiều.
 * Tăng APP_Y_KICK_DURATION_MS/APP_Y_AUTO_STOP_MS nếu Y yếu/không chạy được.
 * Giảm nếu Y vẫn đi quá xa. Target: ~30-50 enc/nấc. */
#define APP_Y_KICK_DURATION_MS  15U
#define APP_Y_AUTO_STOP_MS      20U
/* Leaving Y_MIN while endstop still pressed — cần lâu hơn kick bình thường để thoát.
 * Nhưng phải tương đối với APP_Y_KICK_DURATION_MS (10ms) để không đi quá xa.
 * ~20ms = 2x kick bình thường, đủ lực thoát endstop mà không overshoot. */
#define APP_Y_ESCAPE_KICK_DUTY_PERCENT APP_XY_KICK_DUTY_PERCENT
#define APP_Y_ESCAPE_KICK_DURATION_MS  20U
/*
 * Y axis torque vs X (same PWM % can feel different due to load/gravity).
 * 100/100 = same duty as X. Y weak → raise NUM (e.g. 115/100). Y strong → lower (e.g. 90/100).
 */
#define APP_Y_DUTY_SCALE_NUM 100U
#define APP_Y_DUTY_SCALE_DEN 100U
#define APP_XY_MIN_RUN_MS 100U
/* Must be > KICK_DURATION so cruise duty runs before stop (avoids buzz-without-spin). */
#define APP_XY_AUTO_STOP_MS 195U

#ifndef APP_X_LIMITS_ENABLED
#define APP_X_LIMITS_ENABLED 1U
#endif

/* Y endstop/homing: PA11 wired and tested — enabled. */
#ifndef APP_Y_ENDSTOP_ENABLED
#define APP_Y_ENDSTOP_ENABLED 1U
#endif

#ifndef APP_Y_HOMING_ENABLED
#define APP_Y_HOMING_ENABLED APP_Y_ENDSTOP_ENABLED
#endif

#ifndef APP_Y_LIMITS_ENABLED
#define APP_Y_LIMITS_ENABLED APP_Y_ENDSTOP_ENABLED
#endif

typedef enum {
  APP_HOME_STATE_UNKNOWN = 0,
  APP_HOME_STATE_AUTO_HOMING,
  APP_HOME_STATE_READY,
  APP_HOME_STATE_FAULT,
} AppHomeState;

typedef enum {
  APP_HOMING_PHASE_IDLE = 0,
  APP_HOMING_PHASE_SEEK_MIN,
  APP_HOMING_PHASE_BACKOFF,
  APP_HOMING_PHASE_APPROACH_MIN_SLOW,
  APP_HOMING_PHASE_X_SEEK_MIN,
  APP_HOMING_PHASE_Y_SEEK_MIN,
  APP_HOMING_PHASE_DONE,
  APP_HOMING_PHASE_FAULT,
} AppHomingPhase;

static UART_HandleTypeDef *s_huart = NULL;
static StepperControl s_stepper;
static DcMotorControl s_dcMotors;
static bool s_dcMotorsReady = false;

static uint8_t s_rxByte = 0U;
static char s_rxLine[APP_RX_LINE_MAX];
static uint32_t s_rxLen = 0U;
static char s_rxQueue[APP_RX_QUEUE_DEPTH][APP_RX_LINE_MAX];
static volatile uint32_t s_rxQueueHead = 0U;
static volatile uint32_t s_rxQueueTail = 0U;
static volatile uint32_t s_rxQueueCount = 0U;
static volatile bool s_rxQueueOverflow = false;

static char s_txQueue[APP_TX_QUEUE_DEPTH][APP_TX_LINE_MAX];
static volatile uint32_t s_txQueueHead = 0U;
static volatile uint32_t s_txQueueTail = 0U;
static volatile uint32_t s_txQueueCount = 0U;
static volatile bool s_txQueueOverflow = false;
static volatile bool s_txOverflowReportPending = false;
static volatile bool s_txBusy = false;
static char s_txActiveLine[APP_TX_LINE_MAX];

static uint32_t s_focusStepsPerTick = 1U;
static volatile bool s_focusMoveInFlight = false;
static volatile int32_t s_focusClickPos = APP_FOCUS_POS_MIN;
static volatile int8_t s_focusPendingDelta = 0;
static volatile int8_t s_focusDoneReportDelta = 0;
static volatile uint16_t s_encoderZeroOffset = 0U;
static volatile bool s_encoderTrackReady = false;
static volatile uint16_t s_encoderTrackLastRaw = 0U;
static volatile int32_t s_encoderTrackAccum = 0;
static volatile int32_t s_encoderZeroPos = 0;
static uint32_t s_encoderPollLastMs = 0U;
static uint32_t s_encoderPollBackoffUntilMs = 0U;
static volatile AppHomeState s_homeState = APP_HOME_STATE_UNKNOWN;
static volatile AppHomingPhase s_homingPhase = APP_HOMING_PHASE_IDLE;

// Các biến phục vụ lệnh GOTO
static volatile bool s_gotoInFlight = false;
static volatile int32_t s_gotoTargetPos = 0;
static volatile bool s_gotoDirectionIn = false;
static volatile uint32_t s_gotoDeadlineMs = 0U;

static volatile bool s_endstopMinTriggered = false;
static volatile bool s_endstopXMinTriggered = false;
static volatile bool s_endstopYMinTriggered = false;
static volatile bool s_xHomed = false;
static volatile bool s_xMaxValid = false;
static volatile int32_t s_xZeroOffset = 0;
static volatile int32_t s_xMax = 0;
/* Y encoder delta accumulator — tracks total displacement from homing zero. */
static volatile uint16_t s_yEncLastRaw = 0U;
static volatile bool s_yEncTrackReady = false;
static volatile int32_t s_yEncTotal = 0;
#if APP_Y_HOMING_ENABLED
static volatile bool s_chainXToYHoming = false;
#endif
static volatile bool s_posValid = false;
static volatile bool s_reportEndstopMinPending = true;
static volatile bool s_reportEndstopXPending = true;
static volatile bool s_reportEndstopYPending = true;
static volatile bool s_reportHomePending = true;
static volatile bool s_reportPosValidPending = true;
static volatile uint32_t s_homingDeadlineMs = 0U;
static volatile uint32_t s_homingSettleUntilMs = 0U;
static volatile uint32_t s_xHomingDeadlineMs = 0U;
static volatile uint32_t s_yHomingDeadlineMs = 0U;
static volatile uint32_t s_pingCounterMs = 0U;

static As5600Device s_as5600;
static I2C_HandleTypeDef *s_hi2c = NULL;
static uint32_t s_xyKickUntilMs[2] = {0U, 0U};
static uint32_t s_xyTargetDuty[2] = {0U, 0U};
static int8_t s_xyTargetDir[2] = {0, 0};
static uint32_t s_xyMoveStartedMs[2] = {0U, 0U};
static uint32_t s_xyStopAfterMs[2] = {0U, 0U};
static bool s_xyStopPending[2] = {false, false};

static TaskHandle_t s_controlTaskHandle = NULL;
static void uart_send_line(const char *line);
static As5600Status set_encoder_zero_from_current(void);
static void send_focus_position_message(void);
static void send_encoder_pos_message(void);
static void send_xy_position_message(void);
static void xy_stop_axis(uint32_t axisIndex, bool emit_done);
static void process_xy_kick(void);
static void begin_x_homing(void);
static void begin_y_homing(void);
static void complete_x_homing_success(void);
static void complete_y_homing_success(void);
static bool homing_phase_is_focus_only(AppHomingPhase phase);
static void update_y_encoder_tracking(void);
static int32_t get_y_enc_total_snapshot(void);
static void process_xy_endstop_guard(void);
static uint32_t pwm_duty_from_percent(uint32_t percent);
static void y_homing_drive(int8_t dir, uint32_t dutyPercent);
static void y_homing_stop(void);
static bool homing_phase_is_y_active(AppHomingPhase phase);

static void encoder_i2c_bus_recover(void) {
  if (s_hi2c == NULL) {
    return;
  }

  HAL_I2C_DeInit(s_hi2c);

  __HAL_RCC_GPIOB_CLK_ENABLE();

  GPIO_InitTypeDef GPIO_InitStruct = {0};
  GPIO_InitStruct.Pin = APP_AS5600_I2C_SCL_Pin | APP_AS5600_I2C_SDA_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_OD;
  GPIO_InitStruct.Pull = GPIO_PULLUP;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(APP_AS5600_I2C_SCL_GPIO_Port, &GPIO_InitStruct);

  HAL_GPIO_WritePin(APP_AS5600_I2C_SCL_GPIO_Port, APP_AS5600_I2C_SCL_Pin, GPIO_PIN_SET);
  HAL_GPIO_WritePin(APP_AS5600_I2C_SDA_GPIO_Port, APP_AS5600_I2C_SDA_Pin, GPIO_PIN_SET);
  HAL_Delay(1);

  for (uint32_t i = 0U; i < 16U; i++) {
    if (HAL_GPIO_ReadPin(APP_AS5600_I2C_SDA_GPIO_Port, APP_AS5600_I2C_SDA_Pin) == GPIO_PIN_SET) {
      break;
    }
    HAL_GPIO_WritePin(APP_AS5600_I2C_SCL_GPIO_Port, APP_AS5600_I2C_SCL_Pin, GPIO_PIN_RESET);
    HAL_Delay(1);
    HAL_GPIO_WritePin(APP_AS5600_I2C_SCL_GPIO_Port, APP_AS5600_I2C_SCL_Pin, GPIO_PIN_SET);
    HAL_Delay(1);
  }

  HAL_GPIO_WritePin(APP_AS5600_I2C_SDA_GPIO_Port, APP_AS5600_I2C_SDA_Pin, GPIO_PIN_RESET);
  HAL_Delay(1);
  HAL_GPIO_WritePin(APP_AS5600_I2C_SCL_GPIO_Port, APP_AS5600_I2C_SCL_Pin, GPIO_PIN_SET);
  HAL_Delay(1);
  HAL_GPIO_WritePin(APP_AS5600_I2C_SDA_GPIO_Port, APP_AS5600_I2C_SDA_Pin, GPIO_PIN_SET);
  HAL_Delay(1);

  HAL_I2C_Init(s_hi2c);
}

static void flush_focus_done_report(void) {
  int8_t doneDelta = 0;

  __disable_irq();
  doneDelta = s_focusDoneReportDelta;
  s_focusDoneReportDelta = 0;
  __enable_irq();

  if (doneDelta > 0) {
    uart_send_line("MOTOR_DONE:FOCUS_IN\n");
  } else if (doneDelta < 0) {
    uart_send_line("MOTOR_DONE:FOCUS_OUT\n");
  }
}

static uint32_t compute_focus_steps_per_small_tick(void) {
  uint64_t numerator = (uint64_t)APP_FOCUS_MOTOR_FULL_STEPS_PER_REV
    * (uint64_t)APP_FOCUS_DRIVER_MICROSTEPS
    * (uint64_t)APP_FOCUS_MOTOR_REV_PER_KNOB_REV_NUM;

  uint64_t denominator = (uint64_t)APP_FOCUS_KNOB_SMALL_TICKS_PER_REV
    * (uint64_t)APP_FOCUS_MOTOR_REV_PER_KNOB_REV_DEN;

  if (denominator == 0U) {
    return 1U;
  }

  uint64_t rounded = (numerator + (denominator / 2U)) / denominator;
  if (rounded == 0U) {
    rounded = 1U;
  }

  if (APP_FOCUS_STEP_MULTIPLIER_PERCENT > 0U) {
    rounded = (rounded * (uint64_t)APP_FOCUS_STEP_MULTIPLIER_PERCENT + 50ULL) / 100ULL;
    if (rounded == 0U) {
      rounded = 1U;
    }
  }

  return (uint32_t)rounded;
}

static bool focus_dir_for_command(bool isFocusIn) {
  bool directionCw = isFocusIn;
  if (APP_FOCUS_DIR_INVERT != 0U) {
    directionCw = !directionCw;
  }
  return directionCw;
}

void AppControl_SetControlTaskHandle(TaskHandle_t handle) {
  s_controlTaskHandle = handle;
}

static void notify_control_task_from_isr(void) {
  if (s_controlTaskHandle != NULL) {
    BaseType_t higherPriorityWoken = pdFALSE;
    vTaskNotifyGiveFromISR(s_controlTaskHandle, &higherPriorityWoken);
    portYIELD_FROM_ISR(higherPriorityWoken);
  }
}

static bool dequeue_line(char *outLine) {
  bool hasItem = false;

  __disable_irq();
  if (s_rxQueueCount > 0U) {
    strncpy(outLine, s_rxQueue[s_rxQueueTail], APP_RX_LINE_MAX);
    outLine[APP_RX_LINE_MAX - 1U] = '\0';
    s_rxQueueTail = (s_rxQueueTail + 1U) % APP_RX_QUEUE_DEPTH;
    s_rxQueueCount--;
    hasItem = true;
  }
  __enable_irq();

  return hasItem;
}

static void queue_line_from_isr(const char *line) {
  if (line == NULL) {
    return;
  }

  if (s_rxQueueCount >= APP_RX_QUEUE_DEPTH) {
    s_rxQueueOverflow = true;
    return;
  }

  strncpy(s_rxQueue[s_rxQueueHead], line, APP_RX_LINE_MAX);
  s_rxQueue[s_rxQueueHead][APP_RX_LINE_MAX - 1U] = '\0';
  s_rxQueueHead = (s_rxQueueHead + 1U) % APP_RX_QUEUE_DEPTH;
  s_rxQueueCount++;
}

static bool tx_pop_line_unlocked(char *outLine) {
  if (s_txQueueCount == 0U) {
    return false;
  }

  strncpy(outLine, s_txQueue[s_txQueueTail], APP_TX_LINE_MAX);
  outLine[APP_TX_LINE_MAX - 1U] = '\0';
  s_txQueueTail = (s_txQueueTail + 1U) % APP_TX_QUEUE_DEPTH;
  s_txQueueCount--;
  return true;
}

static bool tx_start_dma_line(const char *line) {
  if (s_huart == NULL || line == NULL) {
    return false;
  }

  uint16_t len = (uint16_t)strlen(line);
  if (len == 0U) {
    return true;
  }

  return (HAL_UART_Transmit_DMA(s_huart, (uint8_t *)line, len) == HAL_OK);
}

static void tx_kick_from_task(void) {
  bool shouldStart = false;

  __disable_irq();
  if (!s_txBusy && (s_txQueueCount > 0U)) {
    if (tx_pop_line_unlocked(s_txActiveLine)) {
      s_txBusy = true;
      shouldStart = true;
    }
  }
  __enable_irq();

  if (shouldStart) {
    if (!tx_start_dma_line(s_txActiveLine)) {
      __disable_irq();
      s_txBusy = false;
      s_txQueueOverflow = true;
      s_txOverflowReportPending = true;
      __enable_irq();
    }
  }
}

static void uart_send_line(const char *line) {
  if (s_huart == NULL || line == NULL) {
    return;
  }

  size_t len = strlen(line);
  if (len == 0U) {
    return;
  }

  if (len >= APP_TX_LINE_MAX) {
    len = APP_TX_LINE_MAX - 1U;
  }

  bool queued = false;

  __disable_irq();
  if (s_txQueueCount < APP_TX_QUEUE_DEPTH) {
    strncpy(s_txQueue[s_txQueueHead], line, len);
    s_txQueue[s_txQueueHead][len] = '\0';
    s_txQueueHead = (s_txQueueHead + 1U) % APP_TX_QUEUE_DEPTH;
    s_txQueueCount++;
    queued = true;
  } else {
    s_txQueueOverflow = true;
    s_txOverflowReportPending = true;
  }
  __enable_irq();

  if (queued) {
    tx_kick_from_task();
  }
}

static void ack_command(const char *name) {
  char buffer[48];
  snprintf(buffer, sizeof(buffer), "ACK:%s\n", name);
  uart_send_line(buffer);
}

static void err_message(const char *reason) {
  char buffer[64];
  snprintf(buffer, sizeof(buffer), "ERR:%s\n", reason);
  uart_send_line(buffer);
}

static const char *encoder_status_name(As5600Status status) {
  switch (status) {
    case AS5600_STATUS_OK:
      return "OK";
    case AS5600_STATUS_ERR_ARG:
      return "ARG";
    case AS5600_STATUS_ERR_NOT_READY:
      return "NOT_READY";
    case AS5600_STATUS_ERR_I2C:
      return "I2C";
    default:
      return "UNKNOWN";
  }
}

static void err_encoder_message(const char *phase, As5600Status status) {
  char buffer[64];
  snprintf(buffer, sizeof(buffer), "ENC_%s_FAIL_%s", phase, encoder_status_name(status));
  err_message(buffer);
}

static void motor_start_message(const char *name) {
  char buffer[64];
  snprintf(buffer, sizeof(buffer), "MOTOR_START:%s\n", name);
  uart_send_line(buffer);
}

static const char *home_state_wire_name(AppHomeState state) {
  switch (state) {
    case APP_HOME_STATE_AUTO_HOMING:
      return "STARTED";
    case APP_HOME_STATE_READY:
      return "DONE";
    case APP_HOME_STATE_FAULT:
      return "FAILED";
    default:
      return "FAILED";
  }
}

static bool read_endstop_min_triggered(void) {
  GPIO_PinState raw = HAL_GPIO_ReadPin(ENDSTOP_MIN_GPIO_Port, ENDSTOP_MIN_Pin);
  return (raw == APP_ENDSTOP_ACTIVE_LEVEL);
}

static bool read_endstop_x_min_triggered(void) {
#if defined(ENDSTOP_X_GPIO_Port) && defined(ENDSTOP_X_Pin)
  GPIO_PinState raw = HAL_GPIO_ReadPin(ENDSTOP_X_GPIO_Port, ENDSTOP_X_Pin);
  return (raw == APP_ENDSTOP_X_ACTIVE_LEVEL);
#else
  return false;
#endif
}

static bool read_endstop_y_min_triggered(void) {
#if APP_Y_ENDSTOP_ENABLED && defined(ENDSTOP_Y_GPIO_Port) && defined(ENDSTOP_Y_Pin)
  GPIO_PinState raw = HAL_GPIO_ReadPin(ENDSTOP_Y_GPIO_Port, ENDSTOP_Y_Pin);
  return (raw == APP_ENDSTOP_ACTIVE_LEVEL);
#else
  return false;
#endif
}

static void send_endstop_message(const char *axis, bool triggered) {
  char buffer[64];
  snprintf(buffer, sizeof(buffer), "ENDSTOP:%s:%s\n", axis, triggered ? "TRIGGERED" : "RELEASED");
  uart_send_line(buffer);
}

static void send_home_state_message(AppHomeState state) {
  char buffer[48];
  snprintf(buffer, sizeof(buffer), "HOME_STATE:%s\n", home_state_wire_name(state));
  uart_send_line(buffer);
}

static void send_pos_valid_message(bool valid) {
  char buffer[32];
  snprintf(buffer, sizeof(buffer), "POS_VALID:%u\n", valid ? 1U : 0U);
  uart_send_line(buffer);
}

static void set_home_state(AppHomeState state, bool forceReport) {
  bool changed = false;

  __disable_irq();
  if (s_homeState != state) {
    s_homeState = state;
    changed = true;
  }
  if (changed || forceReport) {
    s_reportHomePending = true;
  }
  __enable_irq();
}

static void set_pos_valid(bool valid, bool forceReport) {
  bool changed = false;

  __disable_irq();
  if (s_posValid != valid) {
    s_posValid = valid;
    changed = true;
  }
  if (changed || forceReport) {
    s_reportPosValidPending = true;
  }
  __enable_irq();
}

static void sample_endstop_min(bool forceReport) {
  bool triggered = read_endstop_min_triggered();
  bool changed = false;

  __disable_irq();
  if (s_endstopMinTriggered != triggered) {
    s_endstopMinTriggered = triggered;
    changed = true;
  }
  if (changed || forceReport) {
    s_reportEndstopMinPending = true;
  }
  __enable_irq();
}

static void sample_endstop_xy(bool forceReport) {
  bool xChanged = false;
  bool yChanged = false;
  bool xMin = read_endstop_x_min_triggered();
#if APP_Y_ENDSTOP_ENABLED
  bool yMin = read_endstop_y_min_triggered();
#else
  bool yMin = false;
#endif

  __disable_irq();
  if (s_endstopXMinTriggered != xMin) {
    s_endstopXMinTriggered = xMin;
    xChanged = true;
  }
#if APP_Y_ENDSTOP_ENABLED
  if (s_endstopYMinTriggered != yMin) {
    s_endstopYMinTriggered = yMin;
    yChanged = true;
  }
#else
  if (s_endstopYMinTriggered) {
    s_endstopYMinTriggered = false;
    yChanged = true;
  }
#endif
  if (xChanged || forceReport) {
    s_reportEndstopXPending = true;
  }
  if (yChanged || forceReport) {
    s_reportEndstopYPending = true;
  }
  __enable_irq();
}

static void flush_homing_reports(void) {
  bool reportEndstopMin = false;
  bool reportEndstopX = false;
  bool reportEndstopY = false;
  bool reportHome = false;
  bool reportPosValid = false;
  bool endstopMin = false;
  bool endstopXMin = false;
  bool endstopYMin = false;
  bool posValid = false;
  AppHomeState homeState = APP_HOME_STATE_UNKNOWN;

  __disable_irq();
  reportEndstopMin = s_reportEndstopMinPending;
  reportEndstopX = s_reportEndstopXPending;
  reportEndstopY = s_reportEndstopYPending;
  reportHome = s_reportHomePending;
  reportPosValid = s_reportPosValidPending;
  endstopMin = s_endstopMinTriggered;
  endstopXMin = s_endstopXMinTriggered;
  endstopYMin = s_endstopYMinTriggered;
  posValid = s_posValid;
  homeState = s_homeState;
  s_reportEndstopMinPending = false;
  s_reportEndstopXPending = false;
  s_reportEndstopYPending = false;
  s_reportHomePending = false;
  s_reportPosValidPending = false;
  __enable_irq();

  if (reportEndstopMin) {
    send_endstop_message("MIN", endstopMin);
  }
#if defined(ENDSTOP_X_GPIO_Port) && defined(ENDSTOP_X_Pin)
  if (reportEndstopX) {
    send_endstop_message("X_MIN", endstopXMin);
  }
#endif
#if APP_Y_ENDSTOP_ENABLED && defined(ENDSTOP_Y_GPIO_Port) && defined(ENDSTOP_Y_Pin)
  if (reportEndstopY) {
    send_endstop_message("Y_MIN", endstopYMin);
  }
#endif
  if (reportHome) {
    send_home_state_message(homeState);
  }
  if (reportPosValid) {
    send_pos_valid_message(posValid);
  }
}

static bool millis_elapsed(uint32_t now, uint32_t deadline) {
  return ((int32_t)(now - deadline) >= 0);
}

static void fail_homing(const char *reason) {
  Stepper_Stop(&s_stepper);
  DcMotor_StopAll(&s_dcMotors);
  s_gotoInFlight = false;
  s_homingPhase = APP_HOMING_PHASE_FAULT;
  set_pos_valid(false, true);
  set_home_state(APP_HOME_STATE_FAULT, true);
  err_message(reason);
}

static void begin_auto_homing(void) {
  Stepper_Stop(&s_stepper);
  DcMotor_StopAll(&s_dcMotors);
  s_focusMoveInFlight = false;
  s_focusPendingDelta = 0;
  s_focusDoneReportDelta = 0;
  s_gotoInFlight = false;      // ✅ thêm
  s_gotoTargetPos = 0;         // ✅ thêm
  s_gotoDirectionIn = false;   // ✅ thêm
  s_xHomed = false;
  s_xMaxValid = false;
  s_xZeroOffset = 0;
  s_xMax = 0;
  s_yEncLastRaw = 0U;
  s_yEncTrackReady = false;
  s_yEncTotal = 0;
#if APP_Y_HOMING_ENABLED
  s_chainXToYHoming = false;
#endif

  sample_endstop_min(true);
  sample_endstop_xy(true);
  set_pos_valid(false, true);
  set_home_state(APP_HOME_STATE_AUTO_HOMING, true);

  s_homingPhase = APP_HOMING_PHASE_SEEK_MIN;
  s_homingDeadlineMs = HAL_GetTick() + APP_HOME_TIMEOUT_MS;
  s_homingSettleUntilMs = 0U;

  if (s_endstopMinTriggered) {
    Stepper_MoveSteps(
      &s_stepper,
      focus_dir_for_command(true),
      APP_HOME_SLOW_STEP_HZ,
      APP_HOME_BACKOFF_STEPS
    );
    s_homingPhase = APP_HOMING_PHASE_BACKOFF;
    return;
  }

  Stepper_Run(&s_stepper, focus_dir_for_command(false), APP_HOME_FAST_STEP_HZ);
}

static void complete_homing_ready(void) {
  if (set_encoder_zero_from_current() != AS5600_STATUS_OK) {
    fail_homing("HOME_ENC_ZERO_FAIL");
    return;
  }

  __disable_irq();
  s_focusClickPos = APP_FOCUS_POS_MIN;
  s_focusPendingDelta = 0;
  __enable_irq();

  send_focus_position_message();
  send_encoder_pos_message();

  /* Homing order: Focus Z → X → Y */
#if APP_Y_HOMING_ENABLED
  s_chainXToYHoming = true;
#endif
  begin_x_homing();
}

static bool homing_phase_is_focus_only(AppHomingPhase phase) {
  return (phase == APP_HOMING_PHASE_SEEK_MIN)
    || (phase == APP_HOMING_PHASE_BACKOFF)
    || (phase == APP_HOMING_PHASE_APPROACH_MIN_SLOW);
}

static bool homing_phase_is_y_active(AppHomingPhase phase) {
  return phase == APP_HOMING_PHASE_Y_SEEK_MIN;
}

static uint32_t pwm_duty_from_percent(uint32_t percent) {
  if (!s_dcMotorsReady || s_dcMotors.pwmPeriod == 0U) {
    return 0U;
  }
  if (percent > 100U) {
    percent = 100U;
  }
  uint32_t duty = (s_dcMotors.pwmPeriod * percent + 50U) / 100U;
  if (duty > s_dcMotors.pwmPeriod) {
    duty = s_dcMotors.pwmPeriod;
  }
  return duty;
}

static void y_homing_drive(int8_t dir, uint32_t dutyPercent) {
  if (!s_dcMotorsReady) {
    return;
  }
  DcMotor_SetAxis(&s_dcMotors, DC_MOTOR_AXIS_Y, dir, pwm_duty_from_percent(dutyPercent));
}

static void y_homing_stop(void) {
  if (!s_dcMotorsReady) {
    return;
  }
  DcMotor_SetAxis(&s_dcMotors, DC_MOTOR_AXIS_Y, 0, 0U);
}

static void complete_x_homing_success(void) {
  DcMotor_SetAxis(&s_dcMotors, DC_MOTOR_AXIS_X, 0, 0U);

  __disable_irq();
  if (s_dcMotors.encoderXTim != NULL) {
    __HAL_TIM_SET_COUNTER(s_dcMotors.encoderXTim, 0U);
  }
  s_xZeroOffset = 0;
  s_xHomed = true;
  s_xMax = APP_X_MAX_COUNTS;
  s_xMaxValid = true;
  __enable_irq();

  send_xy_position_message();

#if APP_Y_HOMING_ENABLED
  if (s_chainXToYHoming) {
    s_chainXToYHoming = false;
    begin_y_homing();
    return;
  }
#endif

  set_pos_valid(true, true);
  set_home_state(APP_HOME_STATE_READY, true);
  s_homingPhase = APP_HOMING_PHASE_DONE;
}

static int8_t x_dir_left(void) {
  int8_t dir = -1;
  if (APP_X_DIR_INVERT != 0U) {
    dir = (int8_t)(-dir);
  }
  return dir;
}

static int8_t x_dir_right(void) {
  int8_t dir = 1;
  if (APP_X_DIR_INVERT != 0U) {
    dir = (int8_t)(-dir);
  }
  return dir;
}

static int8_t y_dir_up(void) {
  int8_t dir = 1;
  if (APP_Y_DIR_INVERT != 0U) {
    dir = (int8_t)(-dir);
  }
  return dir;
}

static int8_t y_dir_down(void) {
  return (int8_t)(-y_dir_up());
}

static bool get_x_pos_snapshot(int32_t *outPos) {
  if (outPos == NULL) {
    return false;
  }

  int32_t raw = DcMotor_GetEncoderX(&s_dcMotors);
  int32_t zero = 0;
  bool homed = false;

  __disable_irq();
  zero = s_xZeroOffset;
  homed = s_xHomed;
  __enable_irq();

  if (!homed) {
    *outPos = raw;
    return false;
  }

  int32_t delta = raw - zero;
  if (delta > 32767) {
    delta -= 65536;
  } else if (delta < -32768) {
    delta += 65536;
  }

  if (delta > 0) {
    delta = 0;
  }
  if (delta < APP_X_MAX_COUNTS) {
    delta = APP_X_MAX_COUNTS;
  }

  *outPos = delta;
  return true;
}

static void begin_x_homing(void) {
  if (!s_dcMotorsReady) {
    set_pos_valid(true, true);
    set_home_state(APP_HOME_STATE_READY, true);
    s_homingPhase = APP_HOMING_PHASE_DONE;
    return;
  }

  uint32_t now = HAL_GetTick();

  DcMotor_SetAxis(&s_dcMotors, DC_MOTOR_AXIS_X, 0, 0U);
  set_pos_valid(false, true);
  set_home_state(APP_HOME_STATE_AUTO_HOMING, true);
  sample_endstop_xy(true);
  s_homingDeadlineMs = now + APP_HOME_TIMEOUT_MS;
  s_xHomingDeadlineMs = now + APP_X_HOME_TIMEOUT_MS;
  s_homingPhase = APP_HOMING_PHASE_X_SEEK_MIN;

  if (read_endstop_x_min_triggered()) {
    complete_x_homing_success();
    return;
  }

  uint32_t duty = (s_dcMotors.pwmPeriod * APP_X_HOME_DUTY_PERCENT + 50U) / 100U;
  if (duty > s_dcMotors.pwmPeriod) {
    duty = s_dcMotors.pwmPeriod;
  }
  DcMotor_SetAxis(&s_dcMotors, DC_MOTOR_AXIS_X, x_dir_left(), duty);
}

static void complete_y_homing_success(void) {
  DcMotor_SetAxis(&s_dcMotors, DC_MOTOR_AXIS_Y, 0, 0U);

  __disable_irq();
  if (s_dcMotors.encoderYTim != NULL) {
    __HAL_TIM_SET_COUNTER(s_dcMotors.encoderYTim, 0U);
  }
  s_yEncLastRaw = 0U;
  s_yEncTotal = 0;
  s_yEncTrackReady = true;
  __enable_irq();

  set_pos_valid(true, true);
  set_home_state(APP_HOME_STATE_READY, true);
  s_homingPhase = APP_HOMING_PHASE_DONE;
  send_xy_position_message();
}

static void begin_y_homing(void) {
#if !APP_Y_HOMING_ENABLED
  set_pos_valid(true, true);
  set_home_state(APP_HOME_STATE_READY, true);
  s_homingPhase = APP_HOMING_PHASE_DONE;
  return;
#else
  if (!s_dcMotorsReady) {
    set_pos_valid(true, true);
    set_home_state(APP_HOME_STATE_READY, true);
    s_homingPhase = APP_HOMING_PHASE_DONE;
    return;
  }

  set_pos_valid(false, true);
  set_home_state(APP_HOME_STATE_AUTO_HOMING, true);
  sample_endstop_xy(true);
  s_yHomingDeadlineMs = HAL_GetTick() + APP_Y_HOME_TIMEOUT_MS;
  s_homingPhase = APP_HOMING_PHASE_Y_SEEK_MIN;

  if (s_endstopYMinTriggered) {
    complete_y_homing_success();
    return;
  }

  y_homing_drive(y_dir_up(), APP_Y_HOME_DUTY_PERCENT);
#endif /* APP_Y_HOMING_ENABLED */
}

static void process_auto_homing_task(void) {
  sample_endstop_min(false);
  sample_endstop_xy(false);

  if (s_homingPhase == APP_HOMING_PHASE_IDLE || s_homingPhase == APP_HOMING_PHASE_DONE || s_homingPhase == APP_HOMING_PHASE_FAULT) {
    return;
  }

  uint32_t now = HAL_GetTick();
  AppHomingPhase phase = s_homingPhase;

  if (homing_phase_is_focus_only(phase) && millis_elapsed(now, s_homingDeadlineMs)) {
    fail_homing("HOME_TIMEOUT");
    return;
  }

  switch (phase) {
    case APP_HOMING_PHASE_SEEK_MIN:
      if (s_endstopMinTriggered) {
        Stepper_Stop(&s_stepper);
        Stepper_MoveSteps(
          &s_stepper,
          focus_dir_for_command(true),
          APP_HOME_SLOW_STEP_HZ,
          APP_HOME_BACKOFF_STEPS
        );
        s_homingSettleUntilMs = now + APP_HOME_SETTLE_MS;
        s_homingPhase = APP_HOMING_PHASE_BACKOFF;
      }
      break;

    case APP_HOMING_PHASE_BACKOFF:
      if (!Stepper_IsRunning(&s_stepper) && millis_elapsed(now, s_homingSettleUntilMs)) {
        Stepper_Run(&s_stepper, focus_dir_for_command(false), APP_HOME_SLOW_STEP_HZ);
        s_homingPhase = APP_HOMING_PHASE_APPROACH_MIN_SLOW;
      }
      break;

    case APP_HOMING_PHASE_APPROACH_MIN_SLOW:
      if (s_endstopMinTriggered) {
        Stepper_Stop(&s_stepper);
        complete_homing_ready();
      }
      break;

    case APP_HOMING_PHASE_X_SEEK_MIN:
      if (read_endstop_x_min_triggered()) {
        complete_x_homing_success();
        break;
      }
      if (millis_elapsed(now, s_xHomingDeadlineMs)) {
#if defined(ENDSTOP_X_GPIO_Port) && defined(ENDSTOP_X_Pin)
        char buffer[64];
        snprintf(
          buffer,
          sizeof(buffer),
          "HOME_X_TIMEOUT:PIN:%u",
          (unsigned int)HAL_GPIO_ReadPin(ENDSTOP_X_GPIO_Port, ENDSTOP_X_Pin)
        );
        fail_homing(buffer);
#else
        fail_homing("HOME_X_TIMEOUT");
#endif
        break;
      }
      break;

#if APP_Y_HOMING_ENABLED
    case APP_HOMING_PHASE_Y_SEEK_MIN:
      if (millis_elapsed(now, s_yHomingDeadlineMs)) {
        fail_homing("HOME_Y_TIMEOUT");
        break;
      }
      if (s_endstopYMinTriggered) {
        complete_y_homing_success();
      }
      break;
#endif

    default:
      break;
  }
}

static int32_t get_focus_click_pos_snapshot(void) {
  int32_t snapshot = 0;
  __disable_irq();
  snapshot = s_focusClickPos;
  __enable_irq();
  return snapshot;
}

static void send_focus_position_message(void) {
  char buffer[64];
  int32_t position = get_focus_click_pos_snapshot();
  snprintf(buffer, sizeof(buffer), "POS:%ld/%d\n", (long)position, APP_FOCUS_POS_MAX_SAFE);
  uart_send_line(buffer);
}

static uint16_t get_encoder_zero_offset_snapshot(void) {
  uint16_t offset = 0U;
  __disable_irq();
  offset = s_encoderZeroOffset;
  __enable_irq();
  return offset;
}

static int32_t update_encoder_tracking(uint16_t rawCorrected) {
  int32_t accumSnapshot = 0;

  __disable_irq();
  if (!s_encoderTrackReady) {
    s_encoderTrackReady = true;
    s_encoderTrackLastRaw = rawCorrected;
  } else {
    int32_t delta = (int32_t)rawCorrected - (int32_t)s_encoderTrackLastRaw;

    if (delta > (int32_t)APP_ENCODER_WRAP_THRESHOLD) {
      delta -= (int32_t)APP_ENCODER_COUNTS_PER_TURN;
    } else if (delta < -(int32_t)APP_ENCODER_WRAP_THRESHOLD) {
      delta += (int32_t)APP_ENCODER_COUNTS_PER_TURN;
    }

    s_encoderTrackAccum += delta;
    s_encoderTrackLastRaw = rawCorrected;
  }

  accumSnapshot = s_encoderTrackAccum;
  __enable_irq();

  return accumSnapshot;
}

static int32_t get_encoder_zero_pos_snapshot(void) {
  int32_t zeroPos = 0;
  __disable_irq();
  zeroPos = s_encoderZeroPos;
  __enable_irq();
  return zeroPos;
}

static bool get_encoder_pos_snapshot(int32_t *outEncoderPos) {
  if (outEncoderPos == NULL) {
    return false;
  }

  bool trackReady = false;
  int32_t accum = 0;
  int32_t zeroPos = 0;

  __disable_irq();
  trackReady = s_encoderTrackReady;
  accum = s_encoderTrackAccum;
  zeroPos = s_encoderZeroPos;
  __enable_irq();

  if (!trackReady) {
    return false;
  }

  int32_t encoderPos = accum - zeroPos;
  if (APP_ENCODER_POS_INVERT != 0U) {
    encoderPos = -encoderPos;
  }

  if (encoderPos < APP_ENCODER_POS_MIN_SAFE) {
    encoderPos = APP_ENCODER_POS_MIN_SAFE;
  }
  if (encoderPos > APP_ENCODER_POS_MAX_CALIB) {
    encoderPos = APP_ENCODER_POS_MAX_CALIB;
  }

  *outEncoderPos = encoderPos;
  return true;
}

static As5600Status read_encoder_raw_corrected(uint16_t *outRaw) {
  if (outRaw == NULL) {
    return AS5600_STATUS_ERR_ARG;
  }

  uint16_t raw = 0U;
  As5600Status status = As5600_ReadRawAngle(&s_as5600, &raw);
  if (status != AS5600_STATUS_OK) {
    return status;
  }

  if (APP_ENCODER_INVERT != 0U) {
    raw = (uint16_t)(APP_ENCODER_RAW_MAX - raw);
  }

  *outRaw = raw;
  return AS5600_STATUS_OK;
}

static As5600Status read_encoder_raw_normalized(uint16_t *outRawNormalized) {
  if (outRawNormalized == NULL) {
    return AS5600_STATUS_ERR_ARG;
  }

  uint16_t rawCorrected = 0U;
  As5600Status status = read_encoder_raw_corrected(&rawCorrected);
  if (status != AS5600_STATUS_OK) {
    return status;
  }

  update_encoder_tracking(rawCorrected);

  uint16_t zeroOffset = get_encoder_zero_offset_snapshot();
  uint16_t normalized = (uint16_t)((rawCorrected + APP_ENCODER_COUNTS_PER_TURN - zeroOffset)
    % APP_ENCODER_COUNTS_PER_TURN);

  *outRawNormalized = normalized;
  return AS5600_STATUS_OK;
}

static void poll_encoder_tracking_from_task(void) {
  uint32_t now = HAL_GetTick();
  if ((int32_t)(now - s_encoderPollLastMs) < (int32_t)APP_ENCODER_POLL_INTERVAL_MS) {
    return;
  }
  s_encoderPollLastMs = now;

  if ((int32_t)(now - s_encoderPollBackoffUntilMs) < 0) {
    return;
  }

  uint16_t rawCorrected = 0U;
  if (read_encoder_raw_corrected(&rawCorrected) != AS5600_STATUS_OK) {
    s_encoderPollBackoffUntilMs = now + APP_ENCODER_I2C_BACKOFF_MS;
    return;
  }

  update_encoder_tracking(rawCorrected);
}

static As5600Status set_encoder_zero_from_current(void) {
  uint16_t rawCorrected = 0U;
  As5600Status status = read_encoder_raw_corrected(&rawCorrected);
  if (status != AS5600_STATUS_OK) {
    return status;
  }

  int32_t accumSnapshot = update_encoder_tracking(rawCorrected);

  __disable_irq();
  s_encoderZeroOffset = rawCorrected;
  s_encoderZeroPos = accumSnapshot;
  __enable_irq();

  return AS5600_STATUS_OK;
}

static uint32_t encoder_percent_from_pos(int32_t encoderPos) {
  if (encoderPos <= APP_ENCODER_POS_MIN_SAFE) {
    return 0U;
  }
  if (encoderPos >= APP_ENCODER_POS_MAX_CALIB) {
    return 100U;
  }

  uint32_t numerator = (uint32_t)encoderPos * 100U + (uint32_t)(APP_ENCODER_POS_MAX_CALIB / 2);
  uint32_t percent = numerator / (uint32_t)APP_ENCODER_POS_MAX_CALIB;
  if (percent > 100U) {
    percent = 100U;
  }
  return percent;
}

static void send_encoder_pos_message(void) {
  uint16_t rawCorrected = 0U;
  As5600Status status = read_encoder_raw_corrected(&rawCorrected);

  if (status != AS5600_STATUS_OK) {
    err_encoder_message("POS", status);
    return;
  }

  update_encoder_tracking(rawCorrected);

  int32_t encoderPos = 0;
  if (!get_encoder_pos_snapshot(&encoderPos)) {
    err_message("ENC_NOT_READY");
    return;
  }

  char buffer[64];
  snprintf(buffer, sizeof(buffer), "ENC_POS:%ld\n", (long)encoderPos);
  uart_send_line(buffer);

  snprintf(buffer, sizeof(buffer), "ENC_PCT:%u\n", (unsigned int)encoder_percent_from_pos(encoderPos));
  uart_send_line(buffer);
}

static uint32_t xy_default_duty(void) {
  if (!s_dcMotorsReady || s_dcMotors.pwmPeriod == 0U) {
    return 0U;
  }
  uint32_t duty = (s_dcMotors.pwmPeriod * APP_XY_PWM_DUTY_PERCENT + 50U) / 100U;
  uint32_t minDuty = (s_dcMotors.pwmPeriod * APP_XY_MIN_DUTY_PERCENT + 50U) / 100U;
  if (duty > s_dcMotors.pwmPeriod) {
    duty = s_dcMotors.pwmPeriod;
  }
  if (APP_XY_DUTY_SCALE_DEN > 0U) {
    duty = (duty * APP_XY_DUTY_SCALE_NUM) / APP_XY_DUTY_SCALE_DEN;
  }
  if (minDuty > s_dcMotors.pwmPeriod) {
    minDuty = s_dcMotors.pwmPeriod;
  }
  if (duty < minDuty) {
    duty = minDuty;
  }
  return duty;
}

static uint32_t xy_apply_axis_scale(uint32_t duty, DcMotorAxis axis) {
  if (axis == DC_MOTOR_AXIS_Y && APP_Y_DUTY_SCALE_DEN > 0U) {
    duty = (duty * APP_Y_DUTY_SCALE_NUM) / APP_Y_DUTY_SCALE_DEN;
  }
  return duty;
}

static uint32_t xy_axis_min_duty(uint32_t pwmPeriod, DcMotorAxis axis) {
  uint32_t percent = (axis == DC_MOTOR_AXIS_Y) ? APP_Y_MIN_DUTY_PERCENT : APP_XY_MIN_DUTY_PERCENT;
  uint32_t minDuty = (pwmPeriod * percent + 50U) / 100U;
  if (minDuty > pwmPeriod) {
    minDuty = pwmPeriod;
  }
  return minDuty;
}

static uint32_t xy_parse_duty(const char *line) {
  if (line == NULL) {
    return xy_default_duty();
  }

  const char *colon = strrchr(line, ':');
  if (colon == NULL || *(colon + 1) == '\0') {
    return xy_default_duty();
  }

  long long value = 0;
  if (sscanf(colon + 1, "%lld", &value) != 1) {
    return xy_default_duty();
  }
  if (value < 0) {
    value = 0;
  }
  if (value > 100) {
    value = APP_XY_PWM_DUTY_PERCENT;
  }

  if (!s_dcMotorsReady || s_dcMotors.pwmPeriod == 0U) {
    return 0U;
  }
  uint32_t duty = (s_dcMotors.pwmPeriod * (uint32_t)value + 50U) / 100U;
  uint32_t minDuty = (s_dcMotors.pwmPeriod * APP_XY_MIN_DUTY_PERCENT + 50U) / 100U;
  if (duty > s_dcMotors.pwmPeriod) {
    duty = s_dcMotors.pwmPeriod;
  }
  if (APP_XY_DUTY_SCALE_DEN > 0U) {
    duty = (duty * APP_XY_DUTY_SCALE_NUM) / APP_XY_DUTY_SCALE_DEN;
  }
  if (minDuty > s_dcMotors.pwmPeriod) {
    minDuty = s_dcMotors.pwmPeriod;
  }
  if (duty < minDuty) {
    duty = minDuty;
  }
  return duty;
}

static void xy_stop_axis(uint32_t axisIndex, bool emit_done) {
  if (!s_dcMotorsReady || axisIndex >= 2U) {
    return;
  }

  DcMotorAxis axis = (axisIndex == 0U) ? DC_MOTOR_AXIS_X : DC_MOTOR_AXIS_Y;
  DcMotor_SetAxis(&s_dcMotors, axis, 0, 0U);
  s_xyKickUntilMs[axisIndex] = 0U;
  s_xyTargetDir[axisIndex] = 0;
  s_xyTargetDuty[axisIndex] = 0U;
  s_xyStopPending[axisIndex] = false;
  s_xyStopAfterMs[axisIndex] = 0U;
  s_xyMoveStartedMs[axisIndex] = 0U;

  if (emit_done) {
    uart_send_line("MOTOR_DONE\n");
  }
}

static void process_xy_kick(void) {
  if (!s_dcMotorsReady || s_dcMotors.pwmPeriod == 0U) {
    return;
  }

  uint32_t now = HAL_GetTick();
  for (uint32_t axisIndex = 0U; axisIndex < 2U; axisIndex++) {
    if (s_xyKickUntilMs[axisIndex] == 0U) {
      continue;
    }
    if ((int32_t)(now - s_xyKickUntilMs[axisIndex]) < 0) {
      continue;
    }

    DcMotorAxis axis = (axisIndex == 0U) ? DC_MOTOR_AXIS_X : DC_MOTOR_AXIS_Y;
    DcMotor_SetAxis(&s_dcMotors, axis, s_xyTargetDir[axisIndex], s_xyTargetDuty[axisIndex]);
    s_xyKickUntilMs[axisIndex] = 0U;
  }
}

static void process_xy_stop_pending(void) {
  if (!s_dcMotorsReady) {
    return;
  }

  uint32_t now = HAL_GetTick();
  for (uint32_t axisIndex = 0U; axisIndex < 2U; axisIndex++) {
    if (!s_xyStopPending[axisIndex]) {
      continue;
    }
    if ((int32_t)(now - s_xyStopAfterMs[axisIndex]) < 0) {
      continue;
    }

    xy_stop_axis(axisIndex, true);
  }
}

/* Sample the Y encoder timer and accumulate delta into s_yEncTotal.
 * Must be called at a regular interval (≤1ms) to avoid missing a half-revolution wrap. */
static void update_y_encoder_tracking(void) {
  if (!s_dcMotorsReady || s_dcMotors.encoderYTim == NULL) {
    return;
  }
  uint16_t nowRaw = (uint16_t)__HAL_TIM_GET_COUNTER(s_dcMotors.encoderYTim);
  __disable_irq();
  if (!s_yEncTrackReady) {
    s_yEncLastRaw = nowRaw;
    s_yEncTrackReady = true;
  } else {
    int32_t delta = (int32_t)nowRaw - (int32_t)s_yEncLastRaw;
    if (delta > 32767)  { delta -= 65536; }
    else if (delta < -32768) { delta += 65536; }
    s_yEncTotal += delta;
    s_yEncLastRaw = nowRaw;
  }
  __enable_irq();
}

static int32_t get_y_enc_total_snapshot(void) {
  int32_t val;
  __disable_irq();
  val = s_yEncTotal;
  __enable_irq();
  return val;
}

static void send_xy_position_message(void) {
  char buffer[64];
  int32_t xPos = 0;
  if (!get_x_pos_snapshot(&xPos)) {
    xPos = DcMotor_GetEncoderX(&s_dcMotors);
  }
  int32_t yPos = get_y_enc_total_snapshot();
  snprintf(buffer, sizeof(buffer), "XY_POS:%ld,%ld\n", (long)xPos, (long)yPos);
  uart_send_line(buffer);
}

static void send_encoder_raw_message(void) {
  uint16_t raw = 0U;
  As5600Status status = read_encoder_raw_normalized(&raw);

  if (status != AS5600_STATUS_OK) {
    err_encoder_message("RAW", status);
    return;
  }

  char buffer[64];
  snprintf(buffer, sizeof(buffer), "ENC_RAW:%u\n", (unsigned int)raw);
  uart_send_line(buffer);
}

static void start_focus_move(bool isFocusIn, const char *name) {
  if (Stepper_IsRunning(&s_stepper)) {
    Stepper_Stop(&s_stepper);
  }

  Stepper_MoveSteps(
    &s_stepper,
    focus_dir_for_command(isFocusIn),
    APP_DEFAULT_STEP_HZ,
    s_focusStepsPerTick
  );

  s_focusMoveInFlight = true;
  s_focusPendingDelta = isFocusIn ? 1 : -1;
  s_focusDoneReportDelta = 0;

  motor_start_message(name);
  ack_command(name);
}

// ---------------------------------------------------------
// Xử lý motor chạy trong chế độ GOTO (ĐÃ DỜI XUỐNG DƯỚI)
// ---------------------------------------------------------
static void process_goto_task(void) {
  if (!s_gotoInFlight) {
    return;
  }

  if (HAL_GetTick() >= s_gotoDeadlineMs) {
    Stepper_Stop(&s_stepper);
    s_gotoInFlight = false;
    uart_send_line("MOTOR_DONE\n");
    send_encoder_pos_message();
    return;
  }

  int32_t currentPos = 0;
  if (!get_encoder_pos_snapshot(&currentPos)) {
    return; // Đợi encoder sẵn sàng
  }

  bool reached = false;

  // Kiểm tra xem đã đến đích chưa
  if (s_gotoDirectionIn) {
    if (currentPos >= s_gotoTargetPos) reached = true;
    if (currentPos >= APP_ENCODER_POS_MAX_SAFE) reached = true; // An toàn
  } else {
    if (currentPos <= s_gotoTargetPos) reached = true;
    if (currentPos <= APP_ENCODER_POS_MIN_SAFE) reached = true; // An toàn

    // Đang chạy lùi (ra ngoài) mà đụng endstop thì phải dừng ngay
    sample_endstop_min(false);
    if (s_endstopMinTriggered) reached = true;
  }

  if (reached) {
    Stepper_Stop(&s_stepper);
    s_gotoInFlight = false;
    uart_send_line("MOTOR_DONE\n");
    send_encoder_pos_message(); // Báo cáo vị trí cuối cùng cho Node.js
  }
}

// Hàm xử lý lệnh cập nhật để lấy tham số chuỗi dòng lệnh (line)
static void execute_command(UartCommand command, const char *name, const char *line) {
  switch (command) {
    case UART_CMD_MOVE_LEFT:
    case UART_CMD_MOVE_RIGHT:
    case UART_CMD_MOVE_UP:
    case UART_CMD_MOVE_DOWN: {
      if (!s_dcMotorsReady) {
        err_message("XY_NOT_READY");
        break;
      }

      sample_endstop_xy(false);

      uint32_t duty = xy_parse_duty(line);
      int8_t dir = 0;
      DcMotorAxis axis = DC_MOTOR_AXIS_X;

      if (command == UART_CMD_MOVE_LEFT) {
        axis = DC_MOTOR_AXIS_X;
        dir = -1;
      } else if (command == UART_CMD_MOVE_RIGHT) {
        axis = DC_MOTOR_AXIS_X;
        dir = 1;
      } else if (command == UART_CMD_MOVE_UP) {
        axis = DC_MOTOR_AXIS_Y;
        dir = 1;
      } else if (command == UART_CMD_MOVE_DOWN) {
        axis = DC_MOTOR_AXIS_Y;
        dir = -1;
      }

      if (axis == DC_MOTOR_AXIS_X && APP_X_DIR_INVERT != 0U) {
        dir = (int8_t)(-dir);
      }
      if (axis == DC_MOTOR_AXIS_Y && APP_Y_DIR_INVERT != 0U) {
        dir = (int8_t)(-dir);
      }

      if (axis == DC_MOTOR_AXIS_X && APP_X_LIMITS_ENABLED != 0U) {
        int32_t xPos = 0;
        bool xHomed = get_x_pos_snapshot(&xPos);
        bool xMaxValid = false;

        __disable_irq();
        xMaxValid = s_xMaxValid;
        __enable_irq();

        if (dir == x_dir_left()) {
          if (s_endstopXMinTriggered || (xHomed && xPos >= 0)) {
            err_message("LIMIT_X_MIN");
            break;
          }
        } else if (dir == x_dir_right()) {
          if (xMaxValid && xHomed && xPos <= APP_X_MAX_COUNTS) {
            err_message("LIMIT_X_MAX");
            break;
          }
        }
      }

      if (axis == DC_MOTOR_AXIS_Y && APP_Y_LIMITS_ENABLED != 0U) {
        /* UP (MOVE_UP) goes toward Y_MIN; DOWN moves away. Block the inward direction only. */
        if (dir == y_dir_up() && s_endstopYMinTriggered) {
          err_message("LIMIT_Y_MIN");
          break;
        }
        if (dir == y_dir_down()) {
          int32_t yPos = get_y_enc_total_snapshot();
          if (yPos >= APP_Y_MAX_COUNTS) {
            err_message("LIMIT_Y_MAX");
            break;
          }
        }
      }

      uint32_t kickPercent = (axis == DC_MOTOR_AXIS_Y) ? APP_Y_KICK_DUTY_PERCENT : APP_XY_KICK_DUTY_PERCENT;
      uint32_t kickDurationMs = (axis == DC_MOTOR_AXIS_Y) ? APP_Y_KICK_DURATION_MS : APP_XY_KICK_DURATION_MS;
      if (axis == DC_MOTOR_AXIS_Y && dir == y_dir_down() && s_endstopYMinTriggered) {
        kickPercent = APP_Y_ESCAPE_KICK_DUTY_PERCENT;
        kickDurationMs = APP_Y_ESCAPE_KICK_DURATION_MS;
      }
      uint32_t kickDuty = pwm_duty_from_percent(kickPercent);
      uint32_t minDuty = xy_axis_min_duty(s_dcMotors.pwmPeriod, axis);
      duty = xy_apply_axis_scale(duty, axis);
      if (duty < minDuty) {
        duty = minDuty;
      }

      kickDuty = xy_apply_axis_scale(kickDuty, axis);
      if (kickDuty < duty) {
        kickDuty = duty;
      }

      uint32_t axisIndex = (axis == DC_MOTOR_AXIS_X) ? 0U : 1U;
      uint32_t now = HAL_GetTick();
      s_xyMoveStartedMs[axisIndex] = now;
      uint32_t autoStopMs = (axis == DC_MOTOR_AXIS_Y) ? APP_Y_AUTO_STOP_MS : APP_XY_AUTO_STOP_MS;
      if (autoStopMs > 0U) {
        s_xyStopPending[axisIndex] = true;
        uint32_t runMs = autoStopMs;
        if (kickDurationMs > runMs) {
          runMs = kickDurationMs + 10U;
        }
        s_xyStopAfterMs[axisIndex] = now + runMs;
      } else {
        s_xyStopPending[axisIndex] = false;
        s_xyStopAfterMs[axisIndex] = 0U;
      }
      s_xyTargetDuty[axisIndex] = duty;
      s_xyTargetDir[axisIndex] = dir;
      s_xyKickUntilMs[axisIndex] = now + kickDurationMs;

      DcMotor_SetAxis(&s_dcMotors, axis, dir, kickDuty);
      motor_start_message(name);
      ack_command(name);
      break;
    }

    case UART_CMD_FOCUS_IN:
      if (s_homeState != APP_HOME_STATE_READY || !s_posValid) {
        err_message("NOT_READY");
        break;
      }

      if (s_focusMoveInFlight || s_gotoInFlight) {
        err_message("BUSY");
        break;
      }

      {
        int32_t encoderPos = 0;
        bool encoderReady = get_encoder_pos_snapshot(&encoderPos);

        if (encoderReady) {
          if (encoderPos >= APP_ENCODER_POS_MAX_SAFE) {
            err_message("LIMIT_MAX");
            send_focus_position_message();
            break;
          }
        } else if (get_focus_click_pos_snapshot() >= APP_FOCUS_POS_MAX_SAFE) {
          err_message("LIMIT_MAX");
          send_focus_position_message();
          break;
        }
      }

      start_focus_move(true, name);
      break;

    case UART_CMD_FOCUS_OUT:
      if (s_homeState != APP_HOME_STATE_READY || !s_posValid) {
        err_message("NOT_READY");
        break;
      }

      if (s_focusMoveInFlight || s_gotoInFlight) {
        err_message("BUSY");
        break;
      }

      if (s_endstopMinTriggered) {
        err_message("LIMIT_MIN");
        send_focus_position_message();
        break;
      }

      {
        int32_t encoderPos = 0;
        bool encoderReady = get_encoder_pos_snapshot(&encoderPos);

        if (encoderReady) {
          if (encoderPos < APP_ENCODER_POS_MIN_FOCUS_OUT_GUARD) {
            err_message("LIMIT_MIN");
            send_focus_position_message();
            break;
          }
        } else if (get_focus_click_pos_snapshot() <= APP_FOCUS_POS_MIN) {
          err_message("LIMIT_MIN");
          send_focus_position_message();
          break;
        }
      }

      start_focus_move(false, name);
      break;

    case UART_CMD_FOCUS_ZERO:
      if (s_focusMoveInFlight || s_gotoInFlight) {
        err_message("BUSY");
        break;
      }

      __disable_irq();
      s_focusClickPos = APP_FOCUS_POS_MIN;
      s_focusPendingDelta = 0;
      __enable_irq();

      ack_command(name);
      send_focus_position_message();
      break;

    case UART_CMD_FOCUS_POS:
      ack_command(name);
      send_focus_position_message();
      break;

    case UART_CMD_ENC_ZERO:
      {
        As5600Status status = set_encoder_zero_from_current();
        if (status != AS5600_STATUS_OK) {
          err_encoder_message("ZERO", status);
          break;
        }
      }

      ack_command(name);
      send_encoder_raw_message();
      send_encoder_pos_message();
      break;

    case UART_CMD_ENC_RAW:
      ack_command(name);
      send_encoder_raw_message();
      break;

    case UART_CMD_ENC_POS:
      ack_command(name);
      send_encoder_pos_message();
      break;

    case UART_CMD_HOME_MIN:
      if (s_homeState == APP_HOME_STATE_AUTO_HOMING) {
        err_message("HOME_BUSY");
        break;
      }

      ack_command(name);
      begin_auto_homing();
      flush_homing_reports();
      break;

    case UART_CMD_HOME_X:
      if (s_homeState == APP_HOME_STATE_AUTO_HOMING ||
          s_homingPhase == APP_HOMING_PHASE_X_SEEK_MIN
#if APP_Y_HOMING_ENABLED
          || homing_phase_is_y_active(s_homingPhase)
#endif
      ) {
        err_message("HOME_BUSY");
        break;
      }
      if (!s_dcMotorsReady) {
        err_message("XY_NOT_READY");
        break;
      }
      ack_command(name);
      begin_x_homing();
      flush_homing_reports();
      break;

    case UART_CMD_HOME_Y:
      if (!s_dcMotorsReady) {
        err_message("XY_NOT_READY");
        break;
      }
#if APP_Y_HOMING_ENABLED
      if (s_homeState == APP_HOME_STATE_AUTO_HOMING ||
          s_homingPhase == APP_HOMING_PHASE_X_SEEK_MIN ||
          homing_phase_is_y_active(s_homingPhase)) {
        err_message("HOME_BUSY");
        break;
      }
      ack_command(name);
      begin_y_homing();
      flush_homing_reports();
#else
      ack_command(name);
      send_xy_position_message();
#endif
      break;

    case UART_CMD_GOTO: {
      if (s_homeState != APP_HOME_STATE_READY || !s_posValid) {
        err_message("NOT_READY");
        break;
      }

      bool homingBusy =
        (s_homingPhase == APP_HOMING_PHASE_SEEK_MIN) ||
        (s_homingPhase == APP_HOMING_PHASE_BACKOFF) ||
        (s_homingPhase == APP_HOMING_PHASE_APPROACH_MIN_SLOW);

      if (s_focusMoveInFlight || s_gotoInFlight || homingBusy) {
        err_message("BUSY");
        break;
      }

      int32_t targetPos = 0;
      if (sscanf(line, "CMD:GOTO:%ld", (long*)&targetPos) != 1 &&
          sscanf(line, "CMD:GOTO=%ld", (long*)&targetPos) != 1) {
        err_message("BAD_ARG");
        break;
      }

      if (targetPos < APP_ENCODER_POS_MIN_SAFE || targetPos > APP_ENCODER_POS_MAX_SAFE) {
        err_message("LIMIT_ERR");
        break;
      }

      int32_t currentPos = 0;
      if (!get_encoder_pos_snapshot(&currentPos)) {
        err_message("ENC_NOT_READY");
        break;
      }

      int32_t error = targetPos - currentPos;
      if (error > -20 && error < 20) {
        uart_send_line("MOTOR_DONE\n");
        send_encoder_pos_message();
        ack_command(name);
        break;
      }

      s_gotoDirectionIn = (error > 0);

      if (!s_gotoDirectionIn && s_endstopMinTriggered) {
        err_message("LIMIT_MIN");
        break;
      }

      s_gotoTargetPos = targetPos;
      s_gotoInFlight = true;
      s_gotoDeadlineMs = HAL_GetTick() + 30000U;

      Stepper_Run(&s_stepper, focus_dir_for_command(s_gotoDirectionIn), APP_DEFAULT_STEP_HZ);

      motor_start_message(name);
      ack_command(name);
      break;
    }

    case UART_CMD_X_MAX: {
      if (!s_dcMotorsReady) {
        err_message("XY_NOT_READY");
        break;
      }
      int32_t maxPos = 0;
      if (sscanf(line, "CMD:X_MAX:%ld", (long*)&maxPos) != 1 &&
          sscanf(line, "CMD:X_MAX=%ld", (long*)&maxPos) != 1) {
        err_message("BAD_ARG");
        break;
      }
      if (maxPos < 0) {
        err_message("LIMIT_ERR");
        break;
      }

      __disable_irq();
      s_xMax = maxPos;
      s_xMaxValid = true;
      __enable_irq();

      ack_command(name);
      break;
    }

    case UART_CMD_PING:
      ack_command(name);
      break;

    case UART_CMD_STOP: {
      Stepper_Stop(&s_stepper);
      if (s_dcMotorsReady) {
        bool xyWasActive = (s_xyMoveStartedMs[0] != 0U || s_xyMoveStartedMs[1] != 0U ||
                            s_xyKickUntilMs[0] != 0U || s_xyKickUntilMs[1] != 0U ||
                            s_xyStopPending[0] || s_xyStopPending[1]);
        xy_stop_axis(0U, false);
        xy_stop_axis(1U, false);
        if (xyWasActive) {
          uart_send_line("MOTOR_DONE\n");
        }
      }
      s_focusMoveInFlight = false;
      s_focusPendingDelta = 0;
      s_focusDoneReportDelta = 0;
      s_gotoInFlight = false;
      if (s_homingPhase == APP_HOMING_PHASE_X_SEEK_MIN || homing_phase_is_y_active(s_homingPhase)) {
        y_homing_stop();
        s_homingPhase = APP_HOMING_PHASE_FAULT;
        set_pos_valid(false, true);
        set_home_state(APP_HOME_STATE_FAULT, true);
      }

      if (s_homeState == APP_HOME_STATE_AUTO_HOMING) {
        fail_homing("HOME_ABORTED");
      }

      ack_command(name);
      break;
    }

    case UART_CMD_XY_POS:
      if (!s_dcMotorsReady) {
        err_message("XY_NOT_READY");
        break;
      }
      ack_command(name);
      send_xy_position_message();
      break;

    default:
      err_message("UNKNOWN_COMMAND");
      break;
  }
}

static void process_line(const char *line) {
  UartCommand command;
  const char *name;

  if (!UartProtocol_ParseCommand(line, &command, &name)) {
    err_message("BAD_FORMAT");
    return;
  }

  execute_command(command, name, line);
}

void AppControl_Init(
  UART_HandleTypeDef *huart,
  TIM_HandleTypeDef *stepperTimer,
  TIM_HandleTypeDef *pwmTimer,
  TIM_HandleTypeDef *encoderXTimer,
  TIM_HandleTypeDef *encoderYTimer,
  I2C_HandleTypeDef *hi2c,
  uint32_t timerTickHz
) {
  s_hi2c = hi2c;
  s_huart = huart;

  s_rxByte = 0U;
  s_rxLen = 0U;
  s_rxQueueHead = 0U;
  s_rxQueueTail = 0U;
  s_rxQueueCount = 0U;
  s_rxQueueOverflow = false;

  s_txQueueHead = 0U;
  s_txQueueTail = 0U;
  s_txQueueCount = 0U;
  s_txQueueOverflow = false;
  s_txOverflowReportPending = false;
  s_txBusy = false;

  s_focusStepsPerTick = compute_focus_steps_per_small_tick();
  s_focusMoveInFlight = false;
  s_focusClickPos = APP_FOCUS_POS_MIN;
  s_focusPendingDelta = 0;
  s_focusDoneReportDelta = 0;
  s_encoderZeroOffset = 0U;
  s_encoderTrackReady = false;
  s_encoderTrackLastRaw = 0U;
  s_encoderTrackAccum = 0;
  s_encoderZeroPos = 0;
  s_yEncLastRaw = 0U;
  s_yEncTrackReady = false;
  s_yEncTotal = 0;
  s_homeState = APP_HOME_STATE_UNKNOWN;
  s_homingPhase = APP_HOMING_PHASE_IDLE;
  s_gotoInFlight = false;
  s_gotoTargetPos = 0;
  s_gotoDirectionIn = false;
  s_endstopMinTriggered = false;
  s_posValid = false;
  s_reportEndstopMinPending = true;
  s_reportEndstopXPending = true;
  s_reportEndstopYPending = true;
  s_reportHomePending = true;
  s_reportPosValidPending = true;
  s_homingDeadlineMs = 0U;
  s_homingSettleUntilMs = 0U;
  s_xHomed = false;
  s_xMaxValid = false;
  s_xZeroOffset = 0;
  s_xMax = 0;
#if APP_Y_HOMING_ENABLED
  s_chainXToYHoming = false;
#endif
  s_xHomingDeadlineMs = 0U;
  s_yHomingDeadlineMs = 0U;
  s_controlTaskHandle = NULL;
  As5600_Init(&s_as5600, hi2c);

  memset(s_rxLine, 0, sizeof(s_rxLine));
  memset(s_rxQueue, 0, sizeof(s_rxQueue));
  memset(s_txQueue, 0, sizeof(s_txQueue));
  memset(s_txActiveLine, 0, sizeof(s_txActiveLine));

  Stepper_Init(&s_stepper, stepperTimer, timerTickHz);

  DcMotor_Init(
    &s_dcMotors,
    pwmTimer,
    encoderXTimer,
    encoderYTimer,
    TIM_CHANNEL_1,
    TIM_CHANNEL_2,
    (pwmTimer != NULL) ? pwmTimer->Init.Period : 0U
  );
  s_dcMotorsReady = s_dcMotors.ready;
}

void AppControl_Start(void) {
  encoder_i2c_bus_recover();
  if (s_stepper.htim != NULL) {
    HAL_TIM_Base_Start_IT(s_stepper.htim);
  }

  if (s_dcMotorsReady) {
    DcMotor_Start(&s_dcMotors);
  }

  if (s_huart != NULL) {
    HAL_UART_Receive_IT(s_huart, &s_rxByte, 1U);
  }

  begin_auto_homing();
  flush_homing_reports();
}

/* Stop an XY motor and zero its encoder when the physical endstop is hit during normal
 * operation (after homing is done). Only fires when the motor is actively moving TOWARD
 * the endstop — prevents false-trigger when the carriage is sitting at home (endstop
 * stays triggered briefly while motor starts moving away). */
static void process_xy_endstop_guard(void) {
  if (!s_dcMotorsReady || s_homeState != APP_HOME_STATE_READY) {
    return;
  }

  bool posChanged = false;

  /* X: endstop is at home (X=0, left side). Guard only when moving LEFT (toward home). */
  bool xActive = (s_xyMoveStartedMs[0] != 0U || s_xyKickUntilMs[0] != 0U || s_xyStopPending[0]);
  bool xMovingTowardHome = (s_xyTargetDir[0] == x_dir_left());
  if (s_endstopXMinTriggered && xActive && xMovingTowardHome) {
    xy_stop_axis(0U, true);
    __disable_irq();
    if (s_dcMotors.encoderXTim != NULL) {
      __HAL_TIM_SET_COUNTER(s_dcMotors.encoderXTim, 0U);
    }
    s_xZeroOffset = 0;
    __enable_irq();
    posChanged = true;
  }

  /* Y: endstop is at home (Y=0, up side). Guard only when moving UP (toward home). */
  bool yActive = (s_xyMoveStartedMs[1] != 0U || s_xyKickUntilMs[1] != 0U || s_xyStopPending[1]);
  bool yMovingTowardHome = (s_xyTargetDir[1] == y_dir_up());
  if (s_endstopYMinTriggered && yActive && yMovingTowardHome) {
    xy_stop_axis(1U, true);
    __disable_irq();
    if (s_dcMotors.encoderYTim != NULL) {
      __HAL_TIM_SET_COUNTER(s_dcMotors.encoderYTim, 0U);
    }
    s_yEncLastRaw = 0U;
    s_yEncTotal = 0;
    s_yEncTrackReady = true;
    __enable_irq();
    posChanged = true;
  }

  /* Clamp Y to 0 bất cứ khi nào endstop triggered và encoder != 0.
   * Bug cũ: chỉ clamp khi yNow < 0. Nhưng khi auto-stop xóa yActive trước
   * (process_xy_stop_pending chạy trước process_xy_endstop_guard), encoder
   * có thể bị kẹt ở giá trị dương (ví dụ 200) dù endstop đã trigger.
   * Endstop = Y là 0 theo định nghĩa → luôn reset khi trigger. */
  if (s_endstopYMinTriggered && !yActive) {
    __disable_irq();
    int32_t yNow = s_yEncTotal;
    __enable_irq();
    if (yNow != 0) {
      __disable_irq();
      if (s_dcMotors.encoderYTim != NULL) {
        __HAL_TIM_SET_COUNTER(s_dcMotors.encoderYTim, 0U);
      }
      s_yEncLastRaw = 0U;
      s_yEncTotal = 0;
      s_yEncTrackReady = true;
      __enable_irq();
      posChanged = true;
    }
  }

  if (posChanged) {
    send_xy_position_message();
  }
}

void AppControl_Task(void) {
  char lineBuffer[APP_RX_LINE_MAX];

  process_xy_kick();
  process_xy_stop_pending();
  process_xy_endstop_guard();
  poll_encoder_tracking_from_task();
  process_auto_homing_task();
  process_goto_task();
  flush_focus_done_report();

  while (dequeue_line(lineBuffer)) {
    process_line(lineBuffer);
  }

  flush_homing_reports();

  tx_kick_from_task();

  if (s_rxQueueOverflow) {
    s_rxQueueOverflow = false;
    err_message("RX_QUEUE_OVERFLOW");
  }

  if (s_txQueueOverflow) {
    s_txQueueOverflow = false;
  }

  if (s_txOverflowReportPending) {
    bool canReport = false;

    __disable_irq();
    if (s_txQueueCount + 1U < APP_TX_QUEUE_DEPTH) {
      s_txOverflowReportPending = false;
      canReport = true;
    }
    __enable_irq();

    if (canReport) {
      err_message("TX_QUEUE_OVERFLOW");
    }
  }
}

void AppControl_Task1ms(void) {
  update_y_encoder_tracking();
  AppControl_Task();
  s_pingCounterMs++;
   if (s_pingCounterMs >= APP_PING_INTERVAL_MS) {
     s_pingCounterMs = 0U;
     uart_send_line("PING\n");
   }
}

void AppControl_OnTimerTickISR(void) {
  bool wasFocusInFlight = s_focusMoveInFlight;

  Stepper_OnTimerTickISR(&s_stepper);

  if (wasFocusInFlight && !Stepper_IsRunning(&s_stepper)) {
    int8_t completedDelta = s_focusPendingDelta;
    int32_t nextPos = s_focusClickPos + (int32_t)s_focusPendingDelta;
    if (nextPos < APP_FOCUS_POS_MIN) {
      nextPos = APP_FOCUS_POS_MIN;
    }
    if (nextPos > APP_FOCUS_POS_MAX_SAFE) {
      nextPos = APP_FOCUS_POS_MAX_SAFE;
    }
    s_focusClickPos = nextPos;
    s_focusPendingDelta = 0;
    s_focusDoneReportDelta = completedDelta;
    s_focusMoveInFlight = false;
    notify_control_task_from_isr();
  }
}

void AppControl_OnRxCpltISR(void) {
  uint8_t value = s_rxByte;

  if (value == '\n' || value == '\r') {
    if (s_rxLen > 0U) {
      s_rxLine[s_rxLen] = '\0';
      queue_line_from_isr(s_rxLine);
      s_rxLen = 0U;
      memset(s_rxLine, 0, sizeof(s_rxLine));
      notify_control_task_from_isr();
    }
  } else if (s_rxLen < (APP_RX_LINE_MAX - 1U)) {
    s_rxLine[s_rxLen] = (char)value;
    s_rxLen++;
  } else {
    s_rxLen = 0U;
    memset(s_rxLine, 0, sizeof(s_rxLine));
    s_rxQueueOverflow = true;
  }

  if (s_huart != NULL) {
    HAL_UART_Receive_IT(s_huart, &s_rxByte, 1U);
  }
}

void AppControl_OnTxCpltISR(UART_HandleTypeDef *huart) {
  if (huart == NULL || huart != s_huart) {
    return;
  }

  if (tx_pop_line_unlocked(s_txActiveLine)) {
    if (!tx_start_dma_line(s_txActiveLine)) {
      s_txBusy = false;
      s_txQueueOverflow = true;
      s_txOverflowReportPending = true;
    }
  } else {
    s_txBusy = false;
  }
}

void AppControl_OnEndstopEdgeISR(uint16_t gpioPin) {
  if (gpioPin == ENDSTOP_MIN_Pin) {
    sample_endstop_min(false);
    notify_control_task_from_isr();
    return;
  }

#if defined(ENDSTOP_X_Pin)
  if (gpioPin == ENDSTOP_X_Pin) {
    sample_endstop_xy(false);
    notify_control_task_from_isr();
    return;
  }
#endif
#if APP_Y_ENDSTOP_ENABLED && defined(ENDSTOP_Y_Pin)
  if (gpioPin == ENDSTOP_Y_Pin) {
    sample_endstop_xy(false);
    if (s_dcMotorsReady && s_endstopYMinTriggered) {
      AppHomingPhase phase = s_homingPhase;
      if (phase == APP_HOMING_PHASE_Y_SEEK_MIN) {
        y_homing_stop();
      }
    }
    notify_control_task_from_isr();
    return;
  }
#endif
}
