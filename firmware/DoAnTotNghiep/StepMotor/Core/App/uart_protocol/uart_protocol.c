#include "uart_protocol.h"

#include <stddef.h>
#include <string.h>

static bool starts_with(const char *value, const char *prefix) {
  return strncmp(value, prefix, strlen(prefix)) == 0;
}

bool UartProtocol_ParseCommand(const char *line, UartCommand *outCommand, const char **outName) {
  if (line == NULL || outCommand == NULL || outName == NULL) {
    return false;
  }

  *outCommand = UART_CMD_NONE;
  *outName = "NONE";

  if (starts_with(line, "CMD:MOVE_LEFT:")) {
    *outCommand = UART_CMD_MOVE_LEFT;
    *outName = "MOVE_LEFT";
    return true;
  }

  if (starts_with(line, "CMD:MOVE_RIGHT:")) {
    *outCommand = UART_CMD_MOVE_RIGHT;
    *outName = "MOVE_RIGHT";
    return true;
  }

  if (starts_with(line, "CMD:MOVE_UP:")) {
    *outCommand = UART_CMD_MOVE_UP;
    *outName = "MOVE_UP";
    return true;
  }

  if (starts_with(line, "CMD:MOVE_DOWN:")) {
    *outCommand = UART_CMD_MOVE_DOWN;
    *outName = "MOVE_DOWN";
    return true;
  }

  if (starts_with(line, "CMD:FOCUS_IN:")) {
    *outCommand = UART_CMD_FOCUS_IN;
    *outName = "FOCUS_IN";
    return true;
  }

  if (starts_with(line, "CMD:FOCUS_OUT:")) {
    *outCommand = UART_CMD_FOCUS_OUT;
    *outName = "FOCUS_OUT";
    return true;
  }

  if (starts_with(line, "CMD:FOCUS_ZERO:")) {
    *outCommand = UART_CMD_FOCUS_ZERO;
    *outName = "FOCUS_ZERO";
    return true;
  }

  if (starts_with(line, "CMD:FOCUS_POS:")) {
    *outCommand = UART_CMD_FOCUS_POS;
    *outName = "FOCUS_POS";
    return true;
  }

  if (starts_with(line, "CMD:ENC_ZERO:")) {
    *outCommand = UART_CMD_ENC_ZERO;
    *outName = "ENC_ZERO";
    return true;
  }

  if (starts_with(line, "CMD:ENC_RAW:")) {
    *outCommand = UART_CMD_ENC_RAW;
    *outName = "ENC_RAW";
    return true;
  }

  if (starts_with(line, "CMD:ENC_POS:")) {
    *outCommand = UART_CMD_ENC_POS;
    *outName = "ENC_POS";
    return true;
  }

  if (starts_with(line, "CMD:HOME_MIN:")) {
    *outCommand = UART_CMD_HOME_MIN;
    *outName = "HOME_MIN";
    return true;
  }

  if (starts_with(line, "CMD:HOME_X:")) {
    *outCommand = UART_CMD_HOME_X;
    *outName = "HOME_X";
    return true;
  }

  if (starts_with(line, "CMD:HOME_Y:")) {
    *outCommand = UART_CMD_HOME_Y;
    *outName = "HOME_Y";
    return true;
  }

  if (starts_with(line, "CMD:GOTO:") || starts_with(line, "CMD:GOTO=")) {
      *outCommand = UART_CMD_GOTO;
      *outName = "GOTO";
      return true;
    }

  if (starts_with(line, "CMD:X_MAX:") || starts_with(line, "CMD:X_MAX=")) {
    *outCommand = UART_CMD_X_MAX;
    *outName = "X_MAX";
    return true;
  }

  if (starts_with(line, "CMD:XY_POS:")) {
    *outCommand = UART_CMD_XY_POS;
    *outName = "XY_POS";
    return true;
  }

  if (strcmp(line, "PING") == 0) {
    *outCommand = UART_CMD_PING;
    *outName = "PING";
    return true;
  }

  if (starts_with(line, "CMD:STOP:")) {
    *outCommand = UART_CMD_STOP;
    *outName = "STOP";
    return true;
  }

  return false;
}
