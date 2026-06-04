#ifndef APP_AS5600_AS5600_H_
#define APP_AS5600_AS5600_H_

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"

#include <stdbool.h>
#include <stdint.h>

#define AS5600_I2C_ADDR_7BIT 0x36U
#define AS5600_I2C_ADDR_8BIT (AS5600_I2C_ADDR_7BIT << 1)

typedef enum {
  AS5600_STATUS_OK = 0,
  AS5600_STATUS_ERR_ARG,
  AS5600_STATUS_ERR_NOT_READY,
  AS5600_STATUS_ERR_I2C,
} As5600Status;

typedef struct {
  I2C_HandleTypeDef *hi2c;
  uint16_t i2cAddress;
  uint32_t timeoutMs;
  bool ready;
  uint16_t lastRawAngle;
  uint8_t lastAgc;
  uint16_t lastMagnitude;
  As5600Status lastStatus;
  uint32_t lastReadAtMs;
} As5600Device;

void As5600_Init(As5600Device *dev, I2C_HandleTypeDef *hi2c);
void As5600_SetAddress(As5600Device *dev, uint16_t address8bit);
void As5600_SetTimeout(As5600Device *dev, uint32_t timeoutMs);

As5600Status As5600_ReadRawAngle(As5600Device *dev, uint16_t *outRawAngle);
As5600Status As5600_ReadDiagnostics(As5600Device *dev, uint8_t *outAgc, uint16_t *outMagnitude);

#ifdef __cplusplus
}
#endif

#endif /* APP_AS5600_AS5600_H_ */
