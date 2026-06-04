require('dotenv').config({
  path: require('path').resolve(__dirname, '../.env')
});

const { io } = require('socket.io-client');
const { UartBridge } = require('../src/services/uartBridge');

const parseBool = (value, defaultValue = false) => {
  if (value === undefined) return defaultValue;
  return !['false', '0', 'off', 'no'].includes(String(value).toLowerCase());
};

const serverUrl = process.env.PI_AGENT_SERVER_URL;
const agentToken = process.env.PI_AGENT_TOKEN;
const agentName = process.env.PI_AGENT_NAME || 'pi-agent';
const focusOnlyMode = parseBool(process.env.PI_AGENT_FOCUS_ONLY, false);
const focusOnlyCommands = new Set(['focus_in', 'focus_out', 'stop', 'goto']);


if (!serverUrl) {
  console.error('Missing PI_AGENT_SERVER_URL');
  process.exit(1);
}

if (!agentToken) {
  console.error('Missing PI_AGENT_TOKEN');
  process.exit(1);
}

const uartBridge = new UartBridge({
  enabled: parseBool(process.env.PI_UART_ENABLED, true),
  path: process.env.PI_UART_PORT || '/dev/serial0',
  baudRate: Number(process.env.PI_UART_BAUD_RATE || 115200),
  timeoutMs: Number(process.env.PI_UART_ACK_TIMEOUT_MS || 800),
  watchdogEnabled: parseBool(process.env.PI_UART_WATCHDOG_ENABLED, false),
  watchdogIntervalMs: Number(process.env.PI_UART_WATCHDOG_INTERVAL_MS || 1500),
});

const socket = io(serverUrl, {
  transports: ['websocket'],
  auth: {
    role: 'pi-agent',
    token: agentToken,
    name: agentName,
  },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

socket.on('connect', () => {
  console.log(`[PI-AGENT] Connected to ${serverUrl} (socket: ${socket.id})`);
});

socket.on('connect_error', (error) => {
  console.error('[PI-AGENT] connect_error:', error.message);
});

socket.on('disconnect', (reason) => {
  console.warn('[PI-AGENT] disconnected:', reason);
});

uartBridge.on('feedback', (feedback) => {
  console.log(`[PI-AGENT][STM] ${feedback.line}`);
  socket.emit('pi_uart_feedback', {
    line: feedback.line,
    at: feedback.at,
  });
});

socket.on('pi_control_motor', async (payload, callback) => {
  const command = payload?.command;
  const normalizedCommand = String(command || '').trim().toLowerCase();
  const baseCommand = normalizedCommand.split(':')[0];

  if (!command) {
    callback?.({ status: 'rejected', reason: 'missing_command' });
    return;
  }

  if (focusOnlyMode && !focusOnlyCommands.has(baseCommand)) {
    console.warn('[PI-AGENT] focus-only mode, ignored:', command);
    callback?.({ status: 'rejected', reason: 'focus_only_mode', command, at: Date.now() });
    return;
  }

  // Clear pending aux writes — motor commands get priority.
  uartBridge.clearPendingWrites();

  try {
    const result = await uartBridge.sendControlCommand(command);
    if (result.status === 'skipped') {
      callback?.({ status: 'rejected', reason: 'uart_disabled' });
      return;
    }
    callback?.({ status: 'accepted', command, normalized: result.normalized, at: Date.now() });
  } catch (error) {
    console.error('[PI-AGENT] UART motor send failed:', error.message);
    callback?.({ status: 'rejected', reason: error.message, command, at: Date.now() });
  }
});

socket.on('pi_control_aux', (payload, callback) => {
  const command = String(payload?.command || '').trim().toUpperCase();

  if (!command) {
    callback?.({ status: 'rejected', reason: 'missing_command' });
    return;
  }

  if (!uartBridge.enabled) {
    callback?.({ status: 'rejected', reason: 'uart_disabled' });
    return;
  }

  // Ack ngay — không cần chờ UART write xong.
  // Aux queries (ENC_POS, XY_POS) là fire-and-forget: firmware trả lời qua feedback.
  callback?.({ status: 'accepted', command, at: Date.now() });

  const packet = `CMD:${command}:${Date.now()}\n`;
  uartBridge.sendRaw(packet).catch((err) => {
    console.warn('[PI-AGENT] Aux UART write failed (non-blocking):', err.message);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const start = async () => {
  try {
    await uartBridge.init();
    uartBridge.startWatchdog();
    console.log('[PI-AGENT] UART ready');
  } catch (error) {
    console.error('[PI-AGENT] UART init failed:', error.message);
  }
};

const shutdown = async () => {
  try {
    socket.disconnect();
    await uartBridge.shutdown();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();