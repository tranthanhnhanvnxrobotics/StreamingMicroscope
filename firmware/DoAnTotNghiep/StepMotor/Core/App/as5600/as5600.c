#include "as5600.h"

#define AS5600_REG_RAW_ANGLE 0x0CU
#define AS5600_REG_AGC 0x1AU
#define AS5600_REG_MAGNITUDE 0x1BU

static As5600Status as5600_read_mem(As5600Device *dev, uint8_t reg, uint8_t *buffer, uint16_t length) {
  if (dev == NULL || buffer == NULL || length == 0U) {
    return AS5600_STATUS_ERR_ARG;
  }

  if (!dev->ready || dev->hi2c == NULL) {
    return AS5600_STATUS_ERR_NOT_READY;
  }

  HAL_StatusTypeDef halStatus = HAL_I2C_Mem_Read(
    dev->hi2c,
    dev->i2cAddress,
    reg,
    I2C_MEMADD_SIZE_8BIT,
    buffer,
    length,
    dev->timeoutMs
  );

  if (halStatus != HAL_OK) {
    return AS5600_STATUS_ERR_I2C;
  }

  dev->lastReadAtMs = HAL_GetTick();
  return AS5600_STATUS_OK;
}

void As5600_Init(As5600Device *dev, I2C_HandleTypeDef *hi2c) {
  if (dev == NULL) {
    return;
  }

  dev->hi2c = hi2c;
  dev->i2cAddress = AS5600_I2C_ADDR_8BIT;
  dev->timeoutMs = 20U;
  dev->ready = (hi2c != NULL);
  dev->lastRawAngle = 0U;
  dev->lastAgc = 0U;
  dev->lastMagnitude = 0U;
  dev->lastStatus = dev->ready ? AS5600_STATUS_OK : AS5600_STATUS_ERR_NOT_READY;
  dev->lastReadAtMs = 0U;
}

void As5600_SetAddress(As5600Device *dev, uint16_t address8bit) {
  if (dev == NULL) {
    return;
  }

  dev->i2cAddress = address8bit;
}

void As5600_SetTimeout(As5600Device *dev, uint32_t timeoutMs) {
  if (dev == NULL) {
    return;
  }

  dev->timeoutMs = (timeoutMs == 0U) ? 20U : timeoutMs;
}

As5600Status As5600_ReadRawAngle(As5600Device *dev, uint16_t *outRawAngle) {
  if (dev == NULL || outRawAngle == NULL) {
    return AS5600_STATUS_ERR_ARG;
  }

  uint8_t raw[2] = {0U, 0U};
  As5600Status status = as5600_read_mem(dev, AS5600_REG_RAW_ANGLE, raw, 2U);
  dev->lastStatus = status;
  if (status != AS5600_STATUS_OK) {
    return status;
  }

  uint16_t rawAngle = (uint16_t)(((uint16_t)raw[0] << 8U) | raw[1]);
  rawAngle &= 0x0FFFU;
  dev->lastRawAngle = rawAngle;
  *outRawAngle = rawAngle;
  return AS5600_STATUS_OK;
}

As5600Status As5600_ReadDiagnostics(As5600Device *dev, uint8_t *outAgc, uint16_t *outMagnitude) {
  if (dev == NULL || outAgc == NULL || outMagnitude == NULL) {
    return AS5600_STATUS_ERR_ARG;
  }

  uint8_t agc = 0U;
  As5600Status status = as5600_read_mem(dev, AS5600_REG_AGC, &agc, 1U);
  if (status != AS5600_STATUS_OK) {
    dev->lastStatus = status;
    return status;
  }

  uint8_t magRaw[2] = {0U, 0U};
  status = as5600_read_mem(dev, AS5600_REG_MAGNITUDE, magRaw, 2U);
  dev->lastStatus = status;
  if (status != AS5600_STATUS_OK) {
    return status;
  }

  uint16_t magnitude = (uint16_t)(((uint16_t)magRaw[0] << 8U) | magRaw[1]);
  magnitude &= 0x0FFFU;

  dev->lastAgc = agc;
  dev->lastMagnitude = magnitude;
  *outAgc = agc;
  *outMagnitude = magnitude;

  return AS5600_STATUS_OK;
}
