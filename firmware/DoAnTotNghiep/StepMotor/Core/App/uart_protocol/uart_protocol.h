/*
 * uart_protocol.h
 *
 *  Created on: Mar 28, 2026
 *      Author: User
 */

#ifndef APP_UART_PROTOCOL_UART_PROTOCOL_H_
#define APP_UART_PROTOCOL_UART_PROTOCOL_H_

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>

typedef enum {
  UART_CMD_NONE = 0,
  UART_CMD_MOVE_LEFT,
  UART_CMD_MOVE_RIGHT,
  UART_CMD_MOVE_UP,
  UART_CMD_MOVE_DOWN,
  UART_CMD_FOCUS_IN,
  UART_CMD_FOCUS_OUT,
  UART_CMD_FOCUS_ZERO,
  UART_CMD_FOCUS_POS,
  UART_CMD_ENC_ZERO,
  UART_CMD_ENC_RAW,
  UART_CMD_ENC_POS,
  UART_CMD_HOME_MIN,
  UART_CMD_HOME_X,
  UART_CMD_HOME_Y,
  UART_CMD_GOTO,
  UART_CMD_X_MAX,
  UART_CMD_XY_POS,
  UART_CMD_STOP,
  UART_CMD_PING
} UartCommand;

bool UartProtocol_ParseCommand(const char *line, UartCommand *outCommand, const char **outName);

#ifdef __cplusplus
}
#endif

#endif /* APP_UART_PROTOCOL_UART_PROTOCOL_H_ */
