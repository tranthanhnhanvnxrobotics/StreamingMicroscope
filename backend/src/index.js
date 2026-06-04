require('dotenv').config({
  path: require('path').resolve(__dirname, '../.env')
});
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const healthRouter = require('./routes/health');
const itemsRouter = require('./routes/items');
const { createPool, connectWithRetry, initDb } = require('./config/db');
const { UartBridge } = require('./services/uartBridge');
const EventEmitter = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const parseBool = (value, defaultValue = false) => {
  if (value === undefined) return defaultValue;
  return !['false', '0', 'off', 'no'].includes(String(value).toLowerCase());
};

const parseAllowedOrigins = () => {
  const rawOrigins = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';
  return rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
};

const allowedOrigins = parseAllowedOrigins();
const socketAuthToken = process.env.SOCKET_AUTH_TOKEN || '';
const piAgentEnabled = parseBool(process.env.PI_AGENT_ENABLED, false);
const piAgentToken = process.env.PI_AGENT_TOKEN || '';
const piAgentAckTimeoutMs = Number(process.env.PI_AGENT_ACK_TIMEOUT_MS || 1800);
const requireHttpsInProduction = process.env.REQUIRE_HTTPS === 'true';
const controlEnabled = process.env.CONTROL_ENABLED !== 'false';
const controlFocusOnly = parseBool(process.env.CONTROL_FOCUS_ONLY, false);
const controlFailsafeOnDisconnect = parseBool(process.env.CONTROL_FAILSAFE_ON_DISCONNECT, true);
const controlFailsafeGraceMs = Number(process.env.CONTROL_FAILSAFE_GRACE_MS || 2500);
const controlFailsafeCooldownMs = Number(process.env.CONTROL_FAILSAFE_COOLDOWN_MS || 4000);
const focusOnlyAllowedCommands = new Set(['focus_in', 'focus_out', 'stop', 'goto']);
const focusPosMin = Number(process.env.FOCUS_POS_MIN || 0);
const focusPosMax = Number(process.env.FOCUS_POS_MAX || 420);
const encoderPosMin = Number(process.env.ENC_POS_MIN || 0);
const encoderPosMax = Number(process.env.ENC_POS_MAX || 17480);
const encoderPosMaxSafe = Number(process.env.ENC_POS_MAX_SAFE || 17450);
const encoderQuerySettleMs = Number(process.env.ENC_QUERY_SETTLE_MS || 180);
const allowManualZeroCommand = parseBool(process.env.ALLOW_MANUAL_ZERO_COMMAND, false);
const encoderStaleTimeoutMs = Number(process.env.ENCODER_STALE_TIMEOUT_MS || 8000);
const positioningMonitorIntervalMs = Number(process.env.POSITIONING_MONITOR_INTERVAL_MS || 1000);
const returnEncoderTolerance = Number(process.env.RETURN_ENCODER_TOLERANCE || 24);
const returnEncoderStepPauseMs = Number(process.env.RETURN_ENCODER_STEP_PAUSE_MS || 120);
const returnEncoderMaxIterations = Number(process.env.RETURN_ENCODER_MAX_ITERATIONS || 600);
const autofocusTimeoutDoneTolerance = Number(
  process.env.AUTOFOCUS_TIMEOUT_DONE_TOLERANCE || returnEncoderTolerance || 24
);
const autofocusEncoderDefaultTarget = Number(
  process.env.AUTOFOCUS_ENCODER_TARGET || 12500
);
const afEnabled = parseBool(process.env.AUTOFOCUS_HC_ENABLED, true);
const afRtspUrl = process.env.AUTOFOCUS_RTSP_URL || 'rtsp://localhost:8554/cam1';
const afFrameWidth = Number(process.env.AUTOFOCUS_FRAME_WIDTH || 320);
const afFrameHeight = Number(process.env.AUTOFOCUS_FRAME_HEIGHT || 240);
const afCoarseStep = Number(process.env.AUTOFOCUS_COARSE_STEP || 400);
const afFineStep = Number(process.env.AUTOFOCUS_FINE_STEP || 100);
const afSweepStep = Number(process.env.AUTOFOCUS_SWEEP_STEP || 150);
const afSweepBelow = Number(process.env.AUTOFOCUS_SWEEP_BELOW || 750);
const afSweepAbove = Number(process.env.AUTOFOCUS_SWEEP_ABOVE || 150);
const afSweepAbsMin = Number(process.env.AUTOFOCUS_SWEEP_MIN || 0);
const afSweepAbsMax = Number(process.env.AUTOFOCUS_SWEEP_MAX || 0);
const afPreGotoThreshold = Number(process.env.AUTOFOCUS_PREGOTO_THRESHOLD || 800);
const afWarmStartMaxDelta = Number(process.env.AUTOFOCUS_WARM_START_MAX_DELTA || 800);
const afCoarseSettleMs = Number(process.env.AUTOFOCUS_COARSE_SETTLE_MS || 220);
const afFineSettleMs = Number(process.env.AUTOFOCUS_FINE_SETTLE_MS || 320);
const afSettleMs = Number(process.env.AUTOFOCUS_SETTLE_MS || afFineSettleMs);
const afPeakDropSteps = Number(process.env.AUTOFOCUS_PEAK_DROP_STEPS || 3);
const afPeakDropRatio = Number(process.env.AUTOFOCUS_PEAK_DROP_RATIO || 0.90);
const afSamples = Number(process.env.AUTOFOCUS_SAMPLES || 2);
const afTimeoutMs = Number(process.env.AUTOFOCUS_TIMEOUT_MS || 60000);
const motorInProgressTimeoutMs = Number(process.env.MOTOR_IN_PROGRESS_TIMEOUT_MS || 7000);
const motorMaxPendingDone = Number(process.env.MOTOR_MAX_PENDING_DONE || 24);

// Đã thêm 'goto' vào danh sách các lệnh hợp lệ
const knownMotorCommands = ['up', 'down', 'left', 'right', 'focus_in', 'focus_out', 'stop', 'goto'];

// ─── STM32 Watchdog ───────────────────────────────────────────────────────────
const stm32WatchdogTimeoutMs = Number(process.env.STM32_WATCHDOG_TIMEOUT_MS || 4000);
// Grace period sau reconnect: nếu firmware không tự gửi HOME_STATE trong khoảng này,
// backend sẽ gửi HOME_MIN (trường hợp STM32 không reboot, chỉ mất UART).
const stm32ReconnectHomingGraceMs = Number(process.env.STM32_RECONNECT_HOMING_GRACE_MS || 3000);
// ─────────────────────────────────────────────────────────────────────────────

const POSITIONING_STATE_UNKNOWN = 'UNKNOWN';
const POSITIONING_STATE_TRACKING = 'TRACKING';
const POSITIONING_STATE_STALE = 'STALE';
const POSITIONING_STATE_REHOME_REQUIRED = 'REHOME_REQUIRED';
const HOMING_STATE_UNKNOWN = 'UNKNOWN';
const HOMING_STATE_AUTO_HOMING = 'AUTO_HOMING';
const HOMING_STATE_READY = 'READY';
const HOMING_STATE_FAULT = 'FAULT';

// ─── STM32 Watchdog state ─────────────────────────────────────────────────────
const STM32_STATUS_CONNECTED = 'connected';
const STM32_STATUS_DISCONNECTED = 'disconnected';
let stm32LastPingAt = 0;
let stm32WasConnected = false;
let stm32WatchdogTimerId = null;
// Timer chờ HOME_STATE từ firmware sau khi reconnect
let stm32ReconnectHomingTimerId = null;
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ─── Autofocus warm-start: lưu vị trí focus tốt nhất để lần sau bắt đầu gần đó ──
const afMemoryFile = path.resolve(__dirname, '../.af_best_pos.json');
let afBestPosMemory = null;

const loadAfBestPos = () => {
  try {
    const raw = fs.readFileSync(afMemoryFile, 'utf8');
    const data = JSON.parse(raw);
    if (Number.isFinite(data?.pos) && data.pos > 0) {
      afBestPosMemory = data.pos;
      console.log(`[AUTOFOCUS] Loaded warm-start pos=${afBestPosMemory} from memory`);
    }
  } catch (_) {
    // file chưa tồn tại hoặc invalid → dùng default
  }
};

const saveAfBestPos = (pos) => {
  if (!Number.isFinite(pos) || pos <= 0) return;
  const bounds = computeAutofocusSweepBounds(autofocusEncoderDefaultTarget);
  if (pos < bounds.start || pos > bounds.end) {
    console.warn(
      `[AUTOFOCUS] Skip save pos=${pos} (outside sweep window ${bounds.start}..${bounds.end})`
    );
    return;
  }
  afBestPosMemory = pos;
  try {
    fs.writeFileSync(afMemoryFile, JSON.stringify({ pos, savedAt: Date.now() }), 'utf8');
  } catch (err) {
    console.warn('[AUTOFOCUS] Could not save warm-start pos:', err.message);
  }
};
// ─────────────────────────────────────────────────────────────────────────────

const motorDoneEmitter = new EventEmitter();
motorDoneEmitter.setMaxListeners(50);

const isOriginAllowed = (origin) => {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
};

const normalizeControlPayload = (payload) => {
  const normalizeCommand = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return raw;
    const tokens = raw.split(/[\s,|]+/).filter(Boolean);
    return tokens[0] || '';
  };

  if (typeof payload === 'string') {
    return { command: normalizeCommand(payload), mode: 'coarse', timestamp: Date.now() };
  }

  return {
    command: normalizeCommand(payload?.command),
    mode: payload?.mode || 'coarse',
    timestamp: Date.now(),
  };
};

const extractCommandFromFeedbackLine = (line) => {
  const upperLine = String(line || '').toUpperCase();

  if (upperLine.includes('MOVE_UP') || /\bUP\b/.test(upperLine)) return 'up';
  if (upperLine.includes('MOVE_DOWN') || /\bDOWN\b/.test(upperLine)) return 'down';
  if (upperLine.includes('MOVE_LEFT') || /\bLEFT\b/.test(upperLine)) return 'left';
  if (upperLine.includes('MOVE_RIGHT') || /\bRIGHT\b/.test(upperLine)) return 'right';
  if (upperLine.includes('FOCUS_IN')) return 'focus_in';
  if (upperLine.includes('FOCUS_OUT')) return 'focus_out';
  if (upperLine.includes('STOP')) return 'stop';
  if (upperLine.includes('GOTO')) return 'goto';

  return null;
};

const parseMotorStateFromFeedback = (line) => {
  const upperLine = String(line || '').toUpperCase();

  // Bug #4 fix: ERR: lines (e.g. ERR:HOME_BUSY, ERR:GOTO_REJECTED) should not
  // trigger motor started/done — they contain keywords like BUSY, GOTO that
  // would falsely match the isStarted regex.
  if (/^\s*ERR[:\s]/.test(upperLine)) return null;

  // Homing / telemetry lines must never mutate motor task confirmation state.
  if (/^\s*(HOME_STATE|POS_VALID|ENDSTOP|ENC_(POS|PCT|RAW)|XY_POS|ACK|PING)\b/.test(upperLine)) {
    return null;
  }

  const command = extractCommandFromFeedbackLine(upperLine);

  // Strong-path parser for current firmware protocol.
  if (/^\s*MOTOR_DONE\b/.test(upperLine)) {
    return { status: 'done', command };
  }

  if (/^\s*MOTOR_START\b/.test(upperLine)) {
    return { status: 'started', command };
  }

  // Legacy fallback for older firmware logs.
  const isDone =
    /\b(DONE|COMPLETE|COMPLETED|IDLE|STOPPED|FINISHED)\b/.test(upperLine) ||
    /^OK[:\s]/.test(upperLine);
  const isStarted =
    /\b(STARTED|RUNNING|BUSY|EXECUTING)\b/.test(upperLine);

  if ((isDone || isStarted) && !command) {
    return null;
  }

  if (isDone) {
    return { status: 'done', command };
  }

  if (isStarted) {
    return { status: 'started', command };
  }

  return null;
};

const parseFocusPositionFromFeedbackLine = (line) => {
  const match = String(line || '').match(/\bPOS\s*:\s*(-?\d+)\s*\/\s*(\d+)\b/i);
  if (!match) return null;

  const current = Number(match[1]);
  const max = Number(match[2]);

  if (!Number.isFinite(current) || !Number.isFinite(max)) return null;

  return { current, max };
};

const parseFocusLimitFromFeedbackLine = (line) => {
  const upper = String(line || '').toUpperCase();
  if (upper.includes('ERR:LIMIT_MAX')) return 'max';
  if (upper.includes('ERR:LIMIT_MIN')) return 'min';
  return null;
};

const parseEncoderPosFromFeedbackLine = (line) => {
  const match = String(line || '').match(/\bENC_POS\s*:\s*(-?\d+)\b/i);
  if (!match) return null;

  const current = Number(match[1]);
  if (!Number.isFinite(current)) return null;

  return { current };
};

const parseEncoderPctFromFeedbackLine = (line) => {
  const match = String(line || '').match(/\bENC_PCT\s*:\s*(\d+)\b/i);
  if (!match) return null;

  const pct = Number(match[1]);
  if (!Number.isFinite(pct)) return null;

  return { pct: Math.max(0, Math.min(100, pct)) };
};

const parseXyPosFromFeedbackLine = (line) => {
  const match = String(line || '').match(/\bXY_POS\s*:\s*(-?\d+)\s*,\s*(-?\d+)\b/i);
  if (!match) return null;

  const x = Number(match[1]);
  const y = Number(match[2]);

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return { x, y };
};

const parseEndstopFeedbackLine = (line) => {
  const match = String(line || '').match(/\bENDSTOP\s*:\s*(MIN|MAX|X_MIN|Y_MIN)\s*:\s*(TRIGGERED|RELEASED)\b/i);
  if (!match) return null;

  return {
    axis: String(match[1] || '').toUpperCase(),
    state: String(match[2] || '').toUpperCase(),
    triggered: String(match[2] || '').toUpperCase() === 'TRIGGERED',
  };
};

const parseHomeStateFeedbackLine = (line) => {
  const match = String(line || '').match(/\bHOME_STATE\s*:\s*(STARTED|DONE|FAILED)\b/i);
  if (!match) return null;

  const raw = String(match[1] || '').toUpperCase();
  if (raw === 'STARTED') return { raw, state: HOMING_STATE_AUTO_HOMING };
  if (raw === 'DONE') return { raw, state: HOMING_STATE_READY };
  return { raw, state: HOMING_STATE_FAULT };
};

const parsePosValidFeedbackLine = (line) => {
  const match = String(line || '').match(/\bPOS_VALID\s*:\s*([01])\b/i);
  if (!match) return null;

  return { value: Number(match[1]) === 1 };
};

const parseEndstopFaultFromFeedbackLine = (line) => {
  const upper = String(line || '').toUpperCase();
  return upper.includes('ERR:ENDSTOP_FAULT');
};

// ─── STM32 PING parser ────────────────────────────────────────────────────────
const isStm32HeartbeatPing = (line) => /^\s*PING\s*$/i.test(String(line || ''));
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('CORS origin not allowed'));
    },
  },
});

const piAgents = new Map();
let motorTaskTimeoutId = null;
let disconnectFailsafeTimeoutId = null;
let lastFailsafeStopAt = 0;
let positioningMonitorTimerId = null;
let returnToTargetTask = null;
let positioningRefreshInFlight = false;
let positioningRefreshMissCount = 0;
let positioningRefreshLastAt = 0;
let lastFocusLimitMinAt = 0;
let autofocusTask = null;
let hillClimbCancelFlag = false;

const positioningRefreshCooldownMs = Number(process.env.POSITIONING_REFRESH_COOLDOWN_MS || 1200);
const positioningRefreshMaxMisses = Number(process.env.POSITIONING_REFRESH_MAX_MISSES || 2);

const clearDisconnectFailsafeTimeout = () => {
  if (!disconnectFailsafeTimeoutId) return;
  clearTimeout(disconnectFailsafeTimeoutId);
  disconnectFailsafeTimeoutId = null;
};

const triggerDisconnectFailsafeStop = () => {
  if (!controlEnabled || !controlFailsafeOnDisconnect) return;
  const now = Date.now();
  if (now - lastFailsafeStopAt < Math.max(500, controlFailsafeCooldownMs)) return;

  // Không gửi STOP khi STM32 đang homing — STOP sẽ khiến firmware gọi
  // fail_homing("HOME_ABORTED") → HOME_STATE:FAILED → backend FAULT state
  // → frontend hiển thị "ENDSTOP FAULT - RUN RECOVERY"
  const homingNow = app.locals.controlState.homing || {};
  if (homingNow.state === HOMING_STATE_AUTO_HOMING) {
    console.log('Failsafe stop skipped — STM32 is homing, aborting would cause FAULT');
    return;
  }

  lastFailsafeStopAt = now;
  app.locals.controlState.lastCommand = {
    command: 'stop',
    mode: 'failsafe',
    timestamp: now,
  };

  sendControlFallback('stop').catch(() => undefined);
  console.log('Failsafe stop triggered on disconnect (grace elapsed)');
};

const scheduleDisconnectFailsafe = () => {
  if (!controlEnabled || !controlFailsafeOnDisconnect) return;

  clearDisconnectFailsafeTimeout();
  disconnectFailsafeTimeoutId = setTimeout(() => {
    disconnectFailsafeTimeoutId = null;
    if (app.locals.controlState.connectedClients > 0) return;
    triggerDisconnectFailsafeStop();
  }, Math.max(0, controlFailsafeGraceMs));
};

const emitFocusPosition = (source = 'backend') => {
  const focusPosition = app.locals.controlState.focusPosition;
  io.emit('focus_position', { ...focusPosition, source, at: Date.now() });
};

const setFocusPosition = (nextState, source = 'backend') => {
  app.locals.controlState.focusPosition = {
    ...app.locals.controlState.focusPosition,
    ...nextState,
    updatedAt: Date.now(),
  };
  emitFocusPosition(source);
};

const applyFocusPositionDelta = (command, source = 'backend-delta') => {
  const focusState = app.locals.controlState.focusPosition;
  if (!Number.isInteger(focusState.current)) return;

  if (command === 'focus_in') {
    setFocusPosition({ current: Math.min(focusState.max, focusState.current + 1) }, source);
    return;
  }

  if (command === 'focus_out') {
    setFocusPosition({ current: Math.max(focusState.min, focusState.current - 1) }, source);
  }
};

const applyFocusFeedbackLine = (line, source = 'feedback') => {
  const position = parseFocusPositionFromFeedbackLine(line);
  if (position) {
    setFocusPosition({ current: position.current, max: position.max }, source);
    return;
  }

  const limit = parseFocusLimitFromFeedbackLine(line);
  if (limit === 'max') {
    setFocusPosition({ current: app.locals.controlState.focusPosition.max }, source);
    return;
  }

  if (limit === 'min') {
    lastFocusLimitMinAt = Date.now();
    setFocusPosition({ current: app.locals.controlState.focusPosition.min }, source);
  }
};

const emitFocusEncoder = (source = 'backend') => {
  const focusEncoder = app.locals.controlState.focusEncoder;
  io.emit('focus_encoder', { ...focusEncoder, source, at: Date.now() });
};

const setFocusEncoder = (nextState, source = 'backend') => {
  app.locals.controlState.focusEncoder = {
    ...app.locals.controlState.focusEncoder,
    ...nextState,
    updatedAt: Date.now(),
  };
  emitFocusEncoder(source);
};

const emitPositioningState = (source = 'backend') => {
  const positioning = app.locals.controlState.positioning;
  io.emit('positioning_state', { ...positioning, source, at: Date.now() });
};

const setPositioningState = (nextState, source = 'backend') => {
  app.locals.controlState.positioning = {
    ...app.locals.controlState.positioning,
    ...nextState,
    updatedAt: Date.now(),
  };
  emitPositioningState(source);
};

const emitXyPosition = (source = 'backend') => {
  const xyPosition = app.locals.controlState.xyPosition;
  io.emit('xy_position', { ...xyPosition, source, at: Date.now() });
};

const setXyPosition = (nextState, source = 'backend') => {
  app.locals.controlState.xyPosition = {
    ...app.locals.controlState.xyPosition,
    ...nextState,
    updatedAt: Date.now(),
  };
  emitXyPosition(source);
};

const emitHomingStatus = (source = 'backend') => {
  const homing = app.locals.controlState.homing;
  io.emit('homing_status', { ...homing, source, at: Date.now() });
};

const setHomingStatus = (nextState, source = 'backend') => {
  app.locals.controlState.homing = {
    ...app.locals.controlState.homing,
    ...nextState,
    updatedAt: Date.now(),
  };
  emitHomingStatus(source);
};

const emitRecoveryHomeStatus = (source = 'backend') => {
  const recovery = app.locals.controlState.recoveryHome;
  io.emit('recovery_home_status', { ...recovery, source, at: Date.now() });
};

const setRecoveryHomeStatus = (nextState, source = 'backend') => {
  app.locals.controlState.recoveryHome = {
    ...app.locals.controlState.recoveryHome,
    ...nextState,
    updatedAt: Date.now(),
  };
  emitRecoveryHomeStatus(source);
};

const emitTargetEncoderState = (source = 'backend') => {
  const targetEncoder = app.locals.controlState.targetEncoder;
  io.emit('target_encoder_state', { ...targetEncoder, source, at: Date.now() });
};

const setTargetEncoderState = (nextState, source = 'backend') => {
  app.locals.controlState.targetEncoder = {
    ...app.locals.controlState.targetEncoder,
    ...nextState,
    updatedAt: Date.now(),
  };
  emitTargetEncoderState(source);
};

const emitAutofocusProgress = (source = 'backend') => {
  const autofocus = app.locals.controlState.autofocus;
  io.emit('autofocus_progress', { ...autofocus, source, at: Date.now() });
};

const setAutofocusProgress = (nextState, source = 'backend') => {
  app.locals.controlState.autofocus = {
    ...app.locals.controlState.autofocus,
    ...nextState,
    updatedAt: Date.now(),
  };
  emitAutofocusProgress(source);
};

const buildAutofocusDirection = (target, current) => {
  if (!Number.isFinite(target) || !Number.isFinite(current)) return undefined;
  return target >= current ? 'focus_in' : 'focus_out';
};

const computeAutofocusPct = (start, target, current) => {
  if (!Number.isFinite(start) || !Number.isFinite(target) || !Number.isFinite(current)) return null;

  const span = Math.abs(target - start);
  if (span < 1) return 100;

  const traveled = Math.abs(current - start);
  return Math.max(0, Math.min(99, Math.round((traveled * 100) / span)));
};

const markAutofocusMoving = (source = 'autofocus-moving') => {
  if (!autofocusTask) return;

  const autofocusState = app.locals.controlState.autofocus || {};
  const currentValue = getEncoderCurrent();
  const current = Number.isFinite(currentValue) ? currentValue : null;
  const target = Number.isFinite(autofocusTask.target) ? Number(autofocusTask.target) : null;
  const timeoutDoneTolerance = Math.max(1, Math.round(autofocusTimeoutDoneTolerance));
  const nearTarget =
    Number.isFinite(current) &&
    Number.isFinite(target) &&
    Math.abs(current - target) <= timeoutDoneTolerance;

  // Nếu encoder đã rất gần target mà chưa nhận MOTOR_DONE,
  // chủ động chốt task để tránh UI kẹt ở 99% quá lâu.
  if (nearTarget) {
    setMotorTaskDone({
      command: 'goto',
      dispatchId: autofocusTask.dispatchId || null,
      source: `${source}-near-target`,
    });
    return;
  }

  const pctValue = computeAutofocusPct(autofocusTask.start, autofocusTask.target, currentValue);
  const pct = Number.isFinite(pctValue)
    ? pctValue
    : (typeof autofocusState.pct === 'number' ? autofocusState.pct : 0);

  if (
    autofocusState.phase === 'moving' &&
    autofocusState.current === current &&
    autofocusState.pct === pct
  ) {
    return;
  }

  setAutofocusProgress(
    {
      phase: 'moving',
      direction: autofocusTask.direction || autofocusState.direction,
      current,
      target,
      pct,
      result: null,
      reason: null,
    },
    source
  );
};

const failAutofocusProgress = (reason = 'autofocus_failed', source = 'autofocus-failed') => {
  const autofocusState = app.locals.controlState.autofocus || {};
  const isRunning = autofocusState.phase === 'starting' || autofocusState.phase === 'moving';

  if (!autofocusTask && !isRunning) return;

  const currentValue = getEncoderCurrent();
  const current = Number.isFinite(currentValue)
    ? currentValue
    : (Number.isFinite(autofocusState.current) ? autofocusState.current : null);

  setAutofocusProgress(
    {
      phase: 'error',
      direction: autofocusTask?.direction || autofocusState.direction,
      current,
      target: autofocusTask?.target ?? autofocusState.target ?? null,
      pct: typeof autofocusState.pct === 'number' ? autofocusState.pct : 0,
      result: 'failed',
      reason,
    },
    source
  );

  autofocusTask = null;
};

const clampEncoderTarget = (value) => {
  if (!Number.isFinite(value)) return null;
  return Math.max(encoderPosMin, Math.min(encoderPosMaxSafe, Math.round(value)));
};

// ──────────────────────────────────────────────────────────────────────────────

const getEncoderCurrent = () => {
  const current = app.locals.controlState.focusEncoder?.current;
  if (!Number.isFinite(current)) return null;
  return Number(current);
};

const ensureEncoderFreshByQuery = async () => {
  const previousUpdatedAt = Number(app.locals.controlState.focusEncoder?.updatedAt || 0);
  await sendFocusAuxCommand('ENC_POS');
  await sleep(encoderQuerySettleMs);

  const current = getEncoderCurrent();
  const latestUpdatedAt = Number(app.locals.controlState.focusEncoder?.updatedAt || 0);
  if (!Number.isFinite(current)) throw new Error('encoder_not_ready');
  if (!Number.isFinite(latestUpdatedAt) || latestUpdatedAt <= previousUpdatedAt) {
    throw new Error('encoder_not_fresh');
  }

  return current;
};

const saveCurrentEncoderAsTarget = async (source = 'backend-autosave', options = {}) => {
  const queryFresh = options.queryFresh !== false;
  let current = getEncoderCurrent();

  if (queryFresh) {
    try {
      current = await ensureEncoderFreshByQuery();
    } catch (_error) {
      // keep last known value as best effort
    }
  }

  const target = clampEncoderTarget(current);
  if (!Number.isFinite(target)) return null;

  setTargetEncoderState({ target, lastResult: 'autosaved' }, source);
  return target;
};

const cancelReturnToTarget = (reason = 'cancelled') => {
  if (returnToTargetTask) {
    returnToTargetTask.cancelled = true;
  }

  if (app.locals.controlState.targetEncoder?.returning) {
    setTargetEncoderState({ returning: false, lastResult: reason }, 'return-to-target');
  }
};

const runReturnToTarget = async () => {
  const positioning = app.locals.controlState.positioning || {};
  const targetState = app.locals.controlState.targetEncoder || {};
  const targetValue = clampEncoderTarget(targetState.target);

  if (!positioning.homed) throw new Error('not_homed');
  if (positioning.state === POSITIONING_STATE_REHOME_REQUIRED) throw new Error('rehome_required');
  if (!Number.isFinite(targetValue)) throw new Error('target_not_set');

  const task = { cancelled: false, startedAt: Date.now() };
  returnToTargetTask = task;
  setTargetEncoderState(
    { target: targetValue, returning: true, lastResult: null },
    'return-to-target'
  );

  let iterations = 0;
  try {
    while (iterations < Math.max(1, returnEncoderMaxIterations)) {
      if (task.cancelled) throw new Error('return_cancelled');

      const current = await ensureEncoderFreshByQuery();
      const error = targetValue - current;

      if (Math.abs(error) <= Math.max(1, returnEncoderTolerance)) {
        setTargetEncoderState(
          { returning: false, lastResult: 'reached', lastReachedAt: Date.now() },
          'return-to-target'
        );
        return { status: 'accepted', result: 'reached', current, target: targetValue, iterations };
      }

      const command = error > 0 ? 'focus_in' : 'focus_out';

      if (command === 'focus_out') {
        const homingNow = app.locals.controlState.homing || {};
        const minLimitRecentlyHit = Date.now() - lastFocusLimitMinAt < 3000;
        if (homingNow.endstopMin || minLimitRecentlyHit) {
          throw new Error('min_limit');
        }
      }

      const transportResult = await sendControlFallback(command);
      setMotorTaskStarted(command, 'return-to-target', { trackConfirmation: true });

      iterations += 1;
      await sleep(Math.max(30, returnEncoderStepPauseMs));

      if (task.cancelled) throw new Error('return_cancelled');

      if (transportResult?.transport) {
        app.locals.controlState.lastCommand = {
          command,
          mode: 'return-to-target',
          timestamp: Date.now(),
          transport: transportResult.transport,
        };
      }
    }

    throw new Error('return_timeout');
  } catch (error) {
    setTargetEncoderState(
      { returning: false, lastResult: error.message || 'return_failed' },
      'return-to-target'
    );
    throw error;
  } finally {
    if (returnToTargetTask === task) returnToTargetTask = null;
  }
};

const maybeAutoReturnToSavedTarget = async (source = 'auto-return') => {
  if (app.locals.controlState.targetEncoder?.returning) {
    return { status: 'skipped', reason: 'return_in_progress' };
  }

  const targetState = app.locals.controlState.targetEncoder || {};
  const targetValue = clampEncoderTarget(targetState.target);
  if (!Number.isFinite(targetValue)) return { status: 'skipped', reason: 'target_not_set' };

  const current = getEncoderCurrent();
  if (!Number.isFinite(current)) return { status: 'skipped', reason: 'encoder_not_ready' };

  const delta = Math.abs(targetValue - current);
  if (delta <= Math.max(1, returnEncoderTolerance)) {
    setTargetEncoderState(
      { returning: false, lastResult: 'already_at_target' },
      source
    );
    return { status: 'skipped', reason: 'already_at_target', delta, target: targetValue, current };
  }

  // Bỏ qua auto-return nếu delta quá lớn (> 500 đơn vị).
  // Sau homing/di chuyển thủ công lớn, không nên tự động về vị trí cũ.
  // User phải tự chọn bằng cách nhấn AUTO hoặc di chuyển thủ công.
  const maxAutoReturnDelta = 500;
  if (delta > maxAutoReturnDelta) {
    console.log(`[AUTO_RETURN] Skipped — delta=${delta} > maxAutoReturnDelta=${maxAutoReturnDelta}, target=${targetValue}, current=${current}`);
    return { status: 'skipped', reason: 'delta_too_large', delta, target: targetValue, current };
  }

  const result = await runReturnToTarget();
  return { status: 'accepted', result };
};

const markPositioningTracking = (source = 'backend') => {
  positioningRefreshMissCount = 0;
  setPositioningState(
    { state: POSITIONING_STATE_TRACKING, stale: false, lastEncoderAt: Date.now() },
    source
  );
};

const applyHomingFeedbackLine = (line, source = 'feedback') => {
  // Nếu firmware đã tự gửi HOME_STATE → hủy timer reconnect (không cần gửi HOME_MIN nữa)
  if (parseHomeStateFeedbackLine(line)) {
    cancelStm32ReconnectHomingTimer();
  }
  const endstop = parseEndstopFeedbackLine(line);
  if (endstop) {
    if (endstop.axis === 'MIN') {
      setHomingStatus({ endstopMin: endstop.triggered }, source);
    } else if (endstop.axis === 'MAX') {
      setHomingStatus({ endstopMax: endstop.triggered }, source);
    } else if (endstop.axis === 'X_MIN' && endstop.triggered) {
      // X hit home endstop mid-move → firmware already zeroed the counter; sync frontend position.
      setXyPosition({ x: 0 }, `${source}-x-endstop`);
    } else if (endstop.axis === 'Y_MIN') {
      // Track trạng thái endstop Y_MIN thật sự từ firmware.
      // Dùng để frontend disable UP chính xác — không dựa vào encoder value.
      setXyPosition(
        endstop.triggered ? { y: 0, endstopYMin: true } : { endstopYMin: false },
        `${source}-y-endstop`
      );
    }
  }

  const homeState = parseHomeStateFeedbackLine(line);
  if (homeState) {
    setHomingStatus(
      {
        state: homeState.state,
        fault: homeState.state === HOMING_STATE_FAULT,
        lastFaultReason: homeState.state === HOMING_STATE_FAULT ? 'home_failed' : null,
      },
      source
    );

    if (homeState.state === HOMING_STATE_READY) {
      setRecoveryHomeStatus(
        { inProgress: false, lastResult: 'done', lastReason: null },
        `${source}-home-done`
      );
      setPositioningState(
        {
          homed: true,
          stale: false,
          state: POSITIONING_STATE_TRACKING,
          lastEncoderAt: Date.now(),
        },
        `${source}-home-ready`
      );
    } else if (homeState.state === HOMING_STATE_AUTO_HOMING) {
      setRecoveryHomeStatus(
        { inProgress: true, lastResult: 'started', lastReason: null },
        `${source}-home-started`
        
      );
      // ✅ Cancel mọi return-to-target task đang chạy
      cancelReturnToTarget('homing_started');
      failAutofocusProgress('homing_started', `${source}-home-started`);
    } else {
      setRecoveryHomeStatus(
        { inProgress: false, lastResult: 'failed', lastReason: 'home_failed' },
        `${source}-home-failed`
      );
    }
  }

  const posValid = parsePosValidFeedbackLine(line);
  if (posValid) {
    setHomingStatus({ posValid: posValid.value }, source);
  }

  if (parseEndstopFaultFromFeedbackLine(line)) {
    setHomingStatus(
      { state: HOMING_STATE_FAULT, fault: true, lastFaultReason: 'endstop_fault' },
      source
    );
    setRecoveryHomeStatus(
      { inProgress: false, lastResult: 'failed', lastReason: 'endstop_fault' },
      `${source}-endstop-fault`
    );
  }
};

const applyEncoderFeedbackLine = (line, source = 'feedback') => {
  const nextState = {};

  const pos = parseEncoderPosFromFeedbackLine(line);
  if (pos) nextState.current = pos.current;

  const pct = parseEncoderPctFromFeedbackLine(line);
  if (pct) nextState.pct = pct.pct;

  if (Object.keys(nextState).length === 0) return;

  setFocusEncoder(nextState, source);
  markPositioningTracking(source);
  markAutofocusMoving(`${source}-autofocus`);
};

const applyXyFeedbackLine = (line, source = 'feedback') => {
  const pos = parseXyPosFromFeedbackLine(line);
  if (!pos) return;
  setXyPosition({ x: pos.x, y: pos.y }, source);
};

// ─── STM32 Watchdog handlers ──────────────────────────────────────────────────

const cancelStm32ReconnectHomingTimer = () => {
  if (!stm32ReconnectHomingTimerId) return;
  clearTimeout(stm32ReconnectHomingTimerId);
  stm32ReconnectHomingTimerId = null;
};

const isStm32HeartbeatStale = () => {
  if (!stm32WasConnected || stm32LastPingAt === 0) return false;
  return Date.now() - stm32LastPingAt > stm32WatchdogTimeoutMs;
};

const isStm32RehomePending = () => stm32ReconnectHomingTimerId !== null;

const onStm32PingReceived = () => {
  stm32LastPingAt = Date.now();

  if (!stm32WasConnected) {
    stm32WasConnected = true;
    io.emit('stm32_status', { status: STM32_STATUS_CONNECTED, at: Date.now() });
    console.log('💓 STM32 reconnected — waiting for firmware HOME_STATE feedback...');

    // Chờ firmware tự gửi HOME_STATE (nếu nó reboot → sẽ tự home).
    // Nếu hết grace period mà không nhận HOME_STATE → STM32 không reboot
    // → gửi HOME_MIN để buộc re-home.
    cancelStm32ReconnectHomingTimer();
    stm32ReconnectHomingTimerId = setTimeout(() => {
      stm32ReconnectHomingTimerId = null;
      const homingNow = app.locals.controlState.homing || {};
      if (homingNow.state === HOMING_STATE_READY || homingNow.state === HOMING_STATE_AUTO_HOMING) {
        console.log('[RECONNECT] HOME_STATE already received — skipping HOME_MIN');
        return;
      }
      console.log('[RECONNECT] No HOME_STATE after grace period — sending HOME_MIN');
      sendFocusAuxCommand('HOME_MIN').catch((err) => {
        console.warn('[RECONNECT] HOME_MIN failed:', err.message);
      });
    }, Math.max(500, stm32ReconnectHomingGraceMs));
  }
};

const onStm32Disconnected = () => {
  if (!stm32WasConnected) return;
  stm32WasConnected = false;

  console.warn('⚠️  STM32 heartbeat lost — locking all commands');

  setHomingStatus(
    {
      state: HOMING_STATE_UNKNOWN,
      posValid: false,
      fault: false,
    },
    'stm32-watchdog'
  );

  setPositioningState(
    {
      homed: false,
      stale: true,
      state: POSITIONING_STATE_REHOME_REQUIRED,
    },
    'stm32-watchdog'
  );

  cancelReturnToTarget('stm32_disconnected');
  failAutofocusProgress('stm32_disconnected', 'stm32-watchdog');

  io.emit('stm32_status', { status: STM32_STATUS_DISCONNECTED, at: Date.now() });
};

const startStm32Watchdog = () => {
  if (stm32WatchdogTimerId) return;

  stm32WatchdogTimerId = setInterval(() => {
    if (stm32LastPingAt === 0) return;
    // Bug #6 fix: Skip nếu đã disconnect rồi, tránh gọi handler lặp mỗi 300ms
    if (!stm32WasConnected) return;

    const elapsed = Date.now() - stm32LastPingAt;
    if (elapsed > Math.max(500, stm32WatchdogTimeoutMs)) {
      onStm32Disconnected();
    }
  }, 300);

  console.log(`🔍 STM32 watchdog started (timeout: ${stm32WatchdogTimeoutMs}ms)`);
};

const stopStm32Watchdog = () => {
  if (!stm32WatchdogTimerId) return;
  clearInterval(stm32WatchdogTimerId);
  stm32WatchdogTimerId = null;
};

// ─────────────────────────────────────────────────────────────────────────────

const sendFocusAuxCommand = async (commandName) => {
  const command = String(commandName || '').trim().toUpperCase();

  if (piAgentEnabled && getActivePiAgent()) {
    return sendAuxViaPiAgent(command);
  }

  const packet = `CMD:${command}:${Date.now()}\n`;
  const result = await uartBridge.sendRaw(packet);

  if (result.status === 'skipped') throw new Error('no_control_transport');

  return result;
};

const clearMotorTaskTimeout = () => {
  if (!motorTaskTimeoutId) return;
  clearTimeout(motorTaskTimeoutId);
  motorTaskTimeoutId = null;
};

const startMotorTaskTimeout = () => {
  clearMotorTaskTimeout();
  const currentTask = app.locals.controlState.motorTask;
  const pending = currentTask.pendingConfirmations || [];
  if (!pending.length) return;

  const now = Date.now();
  const nextExpiryAt = pending.reduce(
    (minValue, entry) => Math.min(minValue, entry.expiresAt),
    pending[0].expiresAt
  );
  const delay = Math.max(25, nextExpiryAt - now);

  motorTaskTimeoutId = setTimeout(() => {
    const taskNow = app.locals.controlState.motorTask;
    const queueNow = taskNow.pendingConfirmations || [];
    if (!queueNow.length) {
      app.locals.controlState.motorTask = { ...taskNow, inProgress: false, command: null };
      clearMotorTaskTimeout();
      return;
    }

    const timestamp = Date.now();
    const alive = [];
    for (const entry of queueNow) {
      if (entry.expiresAt > timestamp) {
        alive.push(entry);
        continue;
      }

      const isAutofocusGotoTimeout = Boolean(
        autofocusTask &&
        !autofocusTask.hillClimb &&
        entry.command === 'goto' &&
        (
          autofocusTask.dispatchId == null ||
          entry.dispatchId == null ||
          autofocusTask.dispatchId === entry.dispatchId
        )
      );

      if (isAutofocusGotoTimeout) {
        const currentValue = getEncoderCurrent();
        const current = Number.isFinite(currentValue) ? currentValue : null;
        const target = Number.isFinite(autofocusTask?.target) ? Number(autofocusTask.target) : null;
        const tolerance = Math.max(1, Math.round(autofocusTimeoutDoneTolerance));
        const nearTarget =
          Number.isFinite(current) &&
          Number.isFinite(target) &&
          Math.abs(current - target) <= tolerance;

        if (nearTarget) {
          setAutofocusProgress(
            {
              phase: 'done',
              direction: autofocusTask?.direction || null,
              current,
              target,
              pct: 100,
              result: 'reached_after_timeout',
              reason: null,
            },
            'autofocus-timeout-near-target'
          );
          setTargetEncoderState(
            { target, returning: false, lastResult: 'reached_after_timeout', lastReachedAt: timestamp },
            'autofocus-timeout-near-target'
          );
          autofocusTask = null;
        } else {
          failAutofocusProgress('motor_timeout', 'autofocus-timeout');
        }
      }

      io.emit('motor_state', {
        status: 'timeout',
        command: entry.command,
        dispatchId: entry.dispatchId,
        pendingCount: Math.max(0, alive.length),
        at: timestamp,
        source: 'backend-timeout',
      });
    }

    app.locals.controlState.motorTask = {
      ...taskNow,
      pendingConfirmations: alive,
      inProgress: alive.length > 0,
      command: alive.length ? alive[alive.length - 1].command : null,
      timeoutAt: timestamp,
      lastDoneAt: timestamp,
    };

    startMotorTaskTimeout();
  }, delay);
};

const setMotorTaskStarted = (command, source, options = {}) => {
  if (!knownMotorCommands.includes(command)) return;

  const trackConfirmation = options.trackConfirmation !== false;
  const now = Date.now();
  const currentTask = app.locals.controlState.motorTask;
  const currentQueue = currentTask.pendingConfirmations || [];
  const nextQueue = [...currentQueue];
  let dispatchId = null;
  let nextDispatchId = currentTask.nextDispatchId || 0;

  if (command === 'stop') {
    nextQueue.length = 0;
  } else {
    // Với feedback "started" từ UART/PI (trackConfirmation=false),
    // không tạo pending mới để tránh kẹt motor_busy giả.
    const shouldCreatePending = trackConfirmation;
    if (shouldCreatePending) {
      dispatchId = nextDispatchId + 1;
      nextDispatchId = dispatchId;
      nextQueue.push({
        dispatchId,
        command,
        startedAt: now,
        expiresAt: now + Math.max(1000, motorInProgressTimeoutMs),
      });
    }

    while (nextQueue.length > Math.max(1, motorMaxPendingDone)) {
      const dropped = nextQueue.shift();
      io.emit('motor_state', {
        status: 'timeout',
        command: dropped?.command || null,
        dispatchId: dropped?.dispatchId || null,
        pendingCount: nextQueue.length,
        at: now,
        source: 'backend-queue-overflow',
      });
    }
  }

  app.locals.controlState.motorTask = {
    ...currentTask,
    pendingConfirmations: nextQueue,
    inProgress: nextQueue.length > 0,
    command: nextQueue.length ? nextQueue[nextQueue.length - 1].command : null,
    startedAt: now,
    nextDispatchId,
    lastDispatchAt: now,
  };

  if (nextQueue.length === 0) {
    clearMotorTaskTimeout();
  } else {
    startMotorTaskTimeout();
  }

  io.emit('motor_state', {
    status: 'started',
    command,
    dispatchId,
    pendingCount: nextQueue.length,
    at: now,
    source,
  });

  return { dispatchId, pendingCount: nextQueue.length };
};

const setMotorTaskDone = (payload = {}) => {
  const currentTask = app.locals.controlState.motorTask;
  const pending = currentTask.pendingConfirmations || [];
  let doneIndex = -1;

  if (payload.dispatchId) {
    doneIndex = pending.findIndex((entry) => entry.dispatchId === payload.dispatchId);
  }

  if (doneIndex < 0 && payload.command) {
    doneIndex = pending.findIndex((entry) => entry.command === payload.command);
  }

  if (doneIndex < 0 && pending.length > 0) doneIndex = 0;

  const resolvedEntry = doneIndex >= 0 ? pending[doneIndex] : null;
  const nextQueue =
    doneIndex >= 0
      ? [...pending.slice(0, doneIndex), ...pending.slice(doneIndex + 1)]
      : [...pending];
  const command = resolvedEntry?.command || payload.command || currentTask.command || null;
  const now = Date.now();
  const resolvedDispatchId = resolvedEntry?.dispatchId || payload.dispatchId || null;

  const isAutofocusGotoDone = Boolean(
    autofocusTask &&
    !autofocusTask.hillClimb &&
    command === 'goto' &&
    (
      autofocusTask.dispatchId == null ||
      resolvedDispatchId == null ||
      autofocusTask.dispatchId === resolvedDispatchId
    )
  );

  if (isAutofocusGotoDone) {
    const currentValue = getEncoderCurrent();
    const current = Number.isFinite(currentValue) ? currentValue : null;
    const target = Number.isFinite(autofocusTask.target) ? autofocusTask.target : null;

    setAutofocusProgress(
      {
        phase: 'done',
        direction: autofocusTask.direction,
        current,
        target,
        pct: 100,
        result: 'reached',
        reason: null,
      },
      'autofocus-done'
    );

    if (Number.isFinite(target)) {
      setTargetEncoderState(
        { target, returning: false, lastResult: 'reached', lastReachedAt: now },
        'autofocus-done'
      );
    }

    autofocusTask = null;
  }

  app.locals.controlState.motorTask = {
    ...currentTask,
    pendingConfirmations: nextQueue,
    inProgress: nextQueue.length > 0,
    command: nextQueue.length ? nextQueue[nextQueue.length - 1].command : null,
    lastDoneAt: now,
  };

  if (nextQueue.length === 0) {
    clearMotorTaskTimeout();
  } else {
    startMotorTaskTimeout();
  }

  motorDoneEmitter.emit('done', { command, dispatchId: resolvedDispatchId });

  io.emit('motor_state', {
    status: 'done',
    command,
    dispatchId: resolvedDispatchId,
    pendingCount: nextQueue.length,
    at: now,
    source: payload.source || 'feedback',
    line: payload.line,
  });

  // Firmware gửi "MOTOR_DONE" (không có tên lệnh) cho XY commands.
  // Dùng lastCommand để xác định và query XY_POS/ENC_POS sau motor done.
  const lastCmdForDone = app.locals.controlState.lastCommand?.command;
  const isXyDone = !command && (
    lastCmdForDone === 'up' || lastCmdForDone === 'down' ||
    lastCmdForDone === 'left' || lastCmdForDone === 'right'
  );
  if (isXyDone) {
    sendFocusAuxCommand('XY_POS').catch(() => {});
  }

  // Focus commands gửi "MOTOR_DONE:FOCUS_IN/OUT" — query ENC_POS sau khi motor done.
  // Đây là cách duy nhất đảm bảo encoder được đọc mà không gây TX overflow.
  if (command === 'focus_in' || command === 'focus_out') {
    sendFocusAuxCommand('ENC_POS').catch(() => {});
  }
};

const getActivePiAgent = () => {
  for (const entry of piAgents.values()) return entry;
  return null;
};

app.use(
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('CORS origin not allowed'));
    },
    credentials: true,
  })
);
app.use(express.json());

if (requireHttpsInProduction) {
  app.use((req, res, next) => {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const isSecure = req.secure || forwardedProto === 'https';

    if (isSecure) {
      next();
      return;
    }

    res.status(426).json({
      status: 'error',
      error: 'https_required',
      message: 'HTTPS is required in this environment.',
    });
  });
}

const pool = createPool();
const uartBridge = new UartBridge();
app.locals.pool = pool;
app.locals.controlState = {
  enabled: controlEnabled,
  connectedClients: 0,
  lastCommand: null,
  transport: 'uart-or-pi-agent',
  uart: {
    connected: false,
    mode: 'init',
    path: process.env.UART_PORT || '/dev/serial0',
    baudRate: Number(process.env.UART_BAUD_RATE || 115200),
    lastFeedback: null,
  },
  piAgent: {
    enabled: piAgentEnabled,
    connected: false,
    count: 0,
    peers: [],
  },
  motorTask: {
    inProgress: false,
    command: null,
    startedAt: null,
    lastDoneAt: null,
    lastDispatchAt: 0,
    nextDispatchId: 0,
    pendingConfirmations: [],
  },
  focusPosition: {
    min: focusPosMin,
    max: focusPosMax,
    current: null,
    updatedAt: null,
  },
  focusEncoder: {
    min: encoderPosMin,
    max: encoderPosMax,
    safeMax: encoderPosMaxSafe,
    current: null,
    pct: null,
    updatedAt: null,
  },
  positioning: {
    state: POSITIONING_STATE_UNKNOWN,
    homed: false,
    stale: false,
    lastEncoderAt: null,
    bootSessionId: Date.now(),
    updatedAt: null,
  },
  xyPosition: {
    x: null,
    y: null,
    endstopYMin: false,
    updatedAt: null,
  },
  targetEncoder: {
    target: null,
    returning: false,
    lastResult: null,
    lastReachedAt: null,
    updatedAt: null,
  },
  autofocus: {
    phase: 'idle',
    direction: null,
    current: null,
    target: null,
    pct: 0,
    result: null,
    reason: null,
    updatedAt: null,
  },
  homing: {
    state: HOMING_STATE_UNKNOWN,
    endstopMin: false,
    endstopMax: false,
    posValid: false,
    fault: false,
    lastFaultReason: null,
    updatedAt: null,
  },
  recoveryHome: {
    inProgress: false,
    lastRequestedAt: 0,
    lastResult: null,
    lastReason: null,
    updatedAt: null,
  },
};

const startPositioningMonitor = () => {
  if (positioningMonitorTimerId) return;

  const markStaleAndRequireSync = () => {
    const positioningNow = app.locals.controlState.positioning || {};
    if (positioningNow.state === POSITIONING_STATE_STALE && positioningNow.stale === true) return;

    setPositioningState({ stale: true, state: POSITIONING_STATE_STALE }, 'positioning-monitor');
    io.emit('control_status', {
      status: 'rejected',
      reason: 'encoder_stale',
      at: Date.now(),
    });
  };

  positioningMonitorTimerId = setInterval(() => {
    const positioning = app.locals.controlState.positioning;
    if (!positioning?.homed) return;
    if (positioning?.state === POSITIONING_STATE_REHOME_REQUIRED) return;

    const lastEncoderAt = Number(positioning.lastEncoderAt || 0);
    const staleThreshold = Math.max(1000, encoderStaleTimeoutMs);
    const lastAge = Date.now() - lastEncoderAt;

    if (Number.isFinite(lastEncoderAt) && lastEncoderAt > 0 && lastAge <= staleThreshold) return;

    if (positioningRefreshInFlight) return;

    const now = Date.now();
    if (now - positioningRefreshLastAt < Math.max(300, positioningRefreshCooldownMs)) return;

    positioningRefreshInFlight = true;
    positioningRefreshLastAt = now;

    ensureEncoderFreshByQuery()
      .then(() => {
        positioningRefreshMissCount = 0;
        markPositioningTracking('positioning-refresh');
      })
      .catch(() => {
        positioningRefreshMissCount += 1;
        if (positioningRefreshMissCount >= Math.max(1, positioningRefreshMaxMisses)) {
          markStaleAndRequireSync();
        }
      })
      .finally(() => {
        positioningRefreshInFlight = false;
      });
  }, Math.max(250, positioningMonitorIntervalMs));
};

const stopPositioningMonitor = () => {
  if (!positioningMonitorTimerId) return;
  clearInterval(positioningMonitorTimerId);
  positioningMonitorTimerId = null;
};

const syncPiState = () => {
  app.locals.controlState.piAgent = {
    enabled: piAgentEnabled,
    connected: piAgents.size > 0,
    count: piAgents.size,
    peers: Array.from(piAgents.values()).map((entry) => ({
      id: entry.socket.id,
      name: entry.name,
      connectedAt: entry.connectedAt,
    })),
  };

  io.emit('control_transport', {
    status: {
      uart: app.locals.controlState.uart,
      piAgent: app.locals.controlState.piAgent,
    },
  });
};

// ─── UART Bridge events ───────────────────────────────────────────────────────

uartBridge.on('status', (status) => {
  const wasConnected = app.locals.controlState.uart.connected;

  app.locals.controlState.uart = {
    ...app.locals.controlState.uart,
    ...status,
  };

  if (!wasConnected && status.connected) {
    // Firmware tự homing khi boot (AppControl_Start → begin_auto_homing).
    // Backend không gửi HOME_MIN để tránh xung đột ERR:HOME_BUSY.
    console.log('🔌 UART connected — firmware will self-home on boot');
  }

  syncPiState();
});

uartBridge.on('feedback', (feedback) => {
  const line = feedback?.line || '';

  if (isStm32HeartbeatPing(line)) {
    onStm32PingReceived();
    return;
  }

  app.locals.controlState.uart.lastFeedback = feedback;
  io.emit('control_feedback', feedback);
  applyFocusFeedbackLine(line, 'uart-feedback');
  applyEncoderFeedbackLine(line, 'uart-feedback');
  applyXyFeedbackLine(line, 'uart-feedback');
  applyHomingFeedbackLine(line, 'uart-feedback');

  const motorState = parseMotorStateFromFeedback(line);
  if (!motorState) return;

  if (motorState.status === 'done') {
    setMotorTaskDone({ command: motorState.command, source: 'uart-feedback', line });
    return;
  }

  if (motorState.status === 'started') {
    const commandToMark = motorState.command || app.locals.controlState.motorTask.command;
    if (!commandToMark) return;
    setMotorTaskStarted(commandToMark, 'uart-feedback', { trackConfirmation: false });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

io.use((socket, next) => {
  if (requireHttpsInProduction) {
    const forwardedProto = socket.handshake.headers['x-forwarded-proto'];
    const isSecure = socket.request.connection.encrypted || forwardedProto === 'https';

    if (!isSecure) {
      next(new Error('wss_required'));
      return;
    }
  }

  const role =
    socket.handshake.auth?.role ||
    socket.handshake.headers['x-socket-role'] ||
    socket.handshake.query?.role ||
    'web';

  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers['x-socket-token'] ||
    socket.handshake.query?.token;

  if (role === 'pi-agent') {
    if (!piAgentEnabled) {
      next(new Error('pi_agent_disabled'));
      return;
    }

    if (!piAgentToken || token !== piAgentToken) {
      next(new Error('unauthorized_pi_agent'));
      return;
    }

    next();
    return;
  }

  if (!socketAuthToken) {
    next();
    return;
  }

  if (token !== socketAuthToken) {
    next(new Error('unauthorized_socket'));
    return;
  }

  next();
});

const sendControlViaPiAgent = async (command) => {
  const agent = getActivePiAgent();
  if (!agent) throw new Error('pi_agent_unavailable');

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('pi_agent_timeout'));
    }, Math.max(800, piAgentAckTimeoutMs));

    agent.socket.emit(
      'pi_control_motor',
      { command, at: Date.now() },
      (ackPayload) => {
        clearTimeout(timeoutId);

        if (!ackPayload || ackPayload.status !== 'accepted') {
          reject(new Error(ackPayload?.reason || 'pi_agent_rejected'));
          return;
        }

        resolve({ transport: 'pi-agent', detail: ackPayload });
      }
    );
  });
};


const sendAuxViaPiAgent = async (command) => {
  const agent = getActivePiAgent();
  if (!agent) throw new Error('pi_agent_unavailable');

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('pi_agent_timeout'));
    }, Math.max(800, piAgentAckTimeoutMs));

    agent.socket.emit(
      'pi_control_aux',
      { command, at: Date.now() },
      (ackPayload) => {
        clearTimeout(timeoutId);

        if (!ackPayload || ackPayload.status !== 'accepted') {
          reject(new Error(ackPayload?.reason || 'pi_agent_rejected'));
          return;
        }

        resolve({ transport: 'pi-agent', detail: ackPayload });
      }
    );
  });
};

const sendControlFallback = async (command) => {
  if (piAgentEnabled && getActivePiAgent()) {
    return sendControlViaPiAgent(command);
  }

  const uartResult = await uartBridge.sendControlCommand(command);
  if (uartResult.status === 'skipped') throw new Error('no_control_transport');

  return { transport: 'uart', detail: uartResult };
};

// ─── OpenCV2 Sharpness Process ───────────────────────────────────────────────
// Python subprocess: mở RTSP 1 lần, nhận "measure" → Laplacian variance score.
// Laplacian variance là metric chuẩn cho microscope autofocus.

const afCv2Script = path.join(__dirname, 'af_cv2.py');
let cv2Proc = null;
let cv2Rl = null;
let cv2Resolvers = []; // [{resolve, reject, timer}]

const cv2RejectAll = (err) => {
  const list = cv2Resolvers.splice(0);
  for (const { reject, timer } of list) { clearTimeout(timer); reject(err); }
};

const cv2Start = () => {
  if (cv2Proc) return;
  cv2Proc = spawn('python3', [afCv2Script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RTSP_URL: afRtspUrl },
  });
  cv2Rl = readline.createInterface({ input: cv2Proc.stdout, terminal: false });
  cv2Rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === 'ready') {
      console.log('[AF-CV2] Python OpenCV process ready');
      return;
    }
    if (trimmed === 'pong') {
      // ping/pong readiness check — resolve với 1 (truthy)
      if (cv2Resolvers.length > 0) {
        const { resolve, timer } = cv2Resolvers.shift();
        clearTimeout(timer); resolve(1);
      }
      return;
    }
    if (cv2Resolvers.length > 0) {
      const { resolve, timer } = cv2Resolvers.shift();
      clearTimeout(timer);
      resolve(parseFloat(trimmed) || 0);
    }
  });
  // Bỏ qua H264 decode errors từ OpenCV stderr (chỉ log lỗi thực sự)
  cv2Proc.stderr.on('data', (d) => {
    const msg = String(d);
    if (!msg.includes('error while decoding MB') && !msg.includes('bytestream')) {
      process.stdout.write(msg);
    }
  });
  cv2Proc.on('close', (code) => {
    console.log(`[AF-CV2] Process closed (code=${code})`);
    cv2Proc = null; cv2Rl = null;
    cv2RejectAll(new Error('cv2_closed'));
  });
  cv2Proc.on('error', (err) => {
    console.warn('[AF-CV2] Spawn error:', err.message);
    cv2Proc = null; cv2Rl = null;
    cv2RejectAll(err);
  });
};

const cv2Stop = () => {
  if (!cv2Proc) return;
  try { cv2Proc.stdin.write('exit\n'); } catch (_) {}
  try { cv2Proc.kill('SIGTERM'); } catch (_) {}
  cv2Proc = null; cv2Rl = null;
  cv2RejectAll(new Error('cv2_stopped'));
};

const cv2Measure = (timeoutMs = 5000) => new Promise((resolve, reject) => {
  if (!cv2Proc) { reject(new Error('cv2_not_running')); return; }
  const timer = setTimeout(() => {
    const idx = cv2Resolvers.findIndex((r) => r.resolve === resolve);
    if (idx >= 0) cv2Resolvers.splice(idx, 1);
    reject(new Error('cv2_timeout'));
  }, timeoutMs);
  cv2Resolvers.push({ resolve, reject, timer });
  try { cv2Proc.stdin.write('measure\n'); } catch (e) {
    clearTimeout(timer); cv2Resolvers.pop(); reject(e);
  }
});

const cv2MeasureQuick = (timeoutMs = 3500) => new Promise((resolve, reject) => {
  if (!cv2Proc) { reject(new Error('cv2_not_running')); return; }
  const timer = setTimeout(() => {
    const idx = cv2Resolvers.findIndex((r) => r.resolve === resolve);
    if (idx >= 0) cv2Resolvers.splice(idx, 1);
    reject(new Error('cv2_timeout'));
  }, timeoutMs);
  cv2Resolvers.push({ resolve, reject, timer });
  try { cv2Proc.stdin.write('measure_quick\n'); } catch (e) {
    clearTimeout(timer); cv2Resolvers.pop(); reject(e);
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// ─── Hill-Climb Autofocus Engine ─────────────────────────────────────────────

const afCaptureFps = Number(process.env.AUTOFOCUS_CAPTURE_FPS || 4);
const afFrameBytes = afFrameWidth * afFrameHeight;

// Persistent RTSP capture — 1 ffmpeg process cho toàn bộ autofocus session.
// Mỗi lần đo không cần reconnect → tiết kiệm 2-4s per step.
let afCaptureProc = null;
let afFrameAccum = Buffer.alloc(0);
let afFrameWaiters = []; // [{resolve, reject, timer}]

const afDeliverFrame = (frame) => {
  if (afFrameWaiters.length === 0) return;
  const { resolve, timer } = afFrameWaiters.shift();
  clearTimeout(timer);
  resolve(frame);
};

const afRejectAllWaiters = (err) => {
  const waiters = afFrameWaiters.splice(0);
  for (const { reject, timer } of waiters) {
    clearTimeout(timer);
    reject(err);
  }
};

const afStartCapture = () => {
  if (afCaptureProc) return;
  afFrameAccum = Buffer.alloc(0);

  afCaptureProc = spawn('ffmpeg', [
    '-fflags', '+nobuffer',
    '-rtsp_transport', 'tcp',
    '-i', afRtspUrl,
    '-vf', `fps=${afCaptureFps},scale=${afFrameWidth}:${afFrameHeight}`,
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  afCaptureProc.stdout.on('data', (chunk) => {
    afFrameAccum = Buffer.concat([afFrameAccum, chunk]);
    while (afFrameAccum.length >= afFrameBytes) {
      afDeliverFrame(Buffer.from(afFrameAccum.subarray(0, afFrameBytes)));
      afFrameAccum = Buffer.from(afFrameAccum.subarray(afFrameBytes));
    }
  });

  afCaptureProc.on('close', () => {
    afCaptureProc = null;
    afFrameAccum = Buffer.alloc(0);
    afRejectAllWaiters(new Error('af_capture_closed'));
  });

  afCaptureProc.on('error', () => {
    if (afCaptureProc) { try { afCaptureProc.kill('SIGKILL'); } catch (_) {} }
    afCaptureProc = null;
    afRejectAllWaiters(new Error('af_capture_error'));
  });
};

const afStopCapture = () => {
  if (!afCaptureProc) return;
  try { afCaptureProc.kill('SIGKILL'); } catch (_) {}
  afCaptureProc = null;
  afFrameAccum = Buffer.alloc(0);
  afRejectAllWaiters(new Error('af_capture_stopped'));
};

// Chờ frame tiếp theo từ persistent capture.
const afNextFrame = (timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = afFrameWaiters.findIndex((w) => w.resolve === resolve);
      if (idx >= 0) afFrameWaiters.splice(idx, 1);
      reject(new Error('af_frame_timeout'));
    }, timeoutMs);
    afFrameWaiters.push({ resolve, reject, timer });
  });

// Fallback per-call grab khi persistent capture không chạy.
const grabFrame = (url, width, height) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    const expected = width * height;
    const proc = spawn('ffmpeg', [
      '-fflags', '+nobuffer',
      '-rtsp_transport', 'tcp',
      '-i', url,
      '-vf', `scale=${width}:${height}`,
      '-frames:v', '2',
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg_timeout')); }, 10000);
    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.on('close', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (buf.length < Math.floor(expected * 0.5)) { reject(new Error(`short_frame:${buf.length}/${expected}`)); return; }
      const offset = buf.length >= expected * 2 ? expected : 0;
      resolve(buf.slice(offset, offset + Math.min(expected, buf.length - offset)));
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

// Tenengrad (Sobel gradient magnitude squared) — chuẩn công nghiệp cho autofocus.
// Tenengrad với threshold — loại bỏ noise H264 compression artifacts.
// H264 tạo DCT blocking artifacts giả là "edge" với gradient nhỏ → gây nhiễu metric.
// Chỉ đếm gradient ĐỦ LỚN (thực sự là cạnh ảnh, không phải noise).
const SHARPNESS_GRADIENT_THRESHOLD_SQ = 400; // sqrt(400)=20 ≈ gradient tối thiểu là edge thật

const computeSharpness = (buf, width, height) => {
  let sumGrad = 0;
  let edgeCount = 0;
  let totalCount = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      // Sobel 3×3
      const gx = (buf[i - width + 1] + 2 * buf[i + 1] + buf[i + width + 1])
               - (buf[i - width - 1] + 2 * buf[i - 1] + buf[i + width - 1]);
      const gy = (buf[i + width - 1] + 2 * buf[i + width] + buf[i + width + 1])
               - (buf[i - width - 1] + 2 * buf[i - width] + buf[i - width + 1]);
      const mag = gx * gx + gy * gy;
      totalCount++;
      if (mag > SHARPNESS_GRADIENT_THRESHOLD_SQ) {
        sumGrad += mag;
        edgeCount++;
      }
    }
  }
  if (totalCount === 0) return 0;
  // Kết hợp: mật độ cạnh × cường độ trung bình → phân biệt tốt nét/mờ
  const edgeDensity = edgeCount / totalCount;
  const avgGrad = edgeCount > 0 ? sumGrad / edgeCount : 0;
  return edgeDensity * avgGrad;
};

const measureSharpnessHere = async (options = {}) => {
  const quick = options.quick === true;
  const samples = quick ? 1 : Math.max(1, afSamples);

  // Ưu tiên 1: OpenCV2 Python process (Laplacian variance — chuẩn cho microscope)
  if (cv2Proc) {
    if (quick) return cv2MeasureQuick(3500);
    if (samples <= 1) return cv2Measure(5000);
    const s1 = await cv2Measure(5000);
    const s2 = await cv2Measure(5000);
    return (s1 + s2) / 2;
  }
  // Fallback 2: persistent ffmpeg + Node.js Tenengrad
  if (afCaptureProc) {
    const frames = [];
    const frameCount = quick ? 1 : 2;
    for (let i = 0; i < frameCount; i++) {
      if (i === 0) await afNextFrame(4000);
      frames.push(await afNextFrame(4000));
    }
    const total = frames.reduce(
      (sum, frame) => sum + computeSharpness(frame, afFrameWidth, afFrameHeight),
      0
    );
    return total / frames.length;
  }
  // Fallback 3: per-call ffmpeg
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const frame = await grabFrame(afRtspUrl, afFrameWidth, afFrameHeight);
    total += computeSharpness(frame, afFrameWidth, afFrameHeight);
    if (i < samples - 1) await sleep(quick ? 40 : 80);
  }
  return total / samples;
};

const resolveAutofocusSweepCenter = (warmPos) => {
  const defaultTarget = autofocusEncoderDefaultTarget;
  if (
    Number.isFinite(warmPos) &&
    warmPos > 0 &&
    Math.abs(warmPos - defaultTarget) <= afWarmStartMaxDelta
  ) {
    return clampEncoderTarget(warmPos);
  }
  return clampEncoderTarget(defaultTarget);
};

const computeAutofocusSweepBounds = (center) => {
  const sweepCenter = clampEncoderTarget(center);
  let start = clampEncoderTarget(sweepCenter - afSweepBelow);
  let end = clampEncoderTarget(sweepCenter + afSweepAbove);
  if (afSweepAbsMin > 0) start = Math.max(start, afSweepAbsMin);
  if (afSweepAbsMax > 0) end = Math.min(end, afSweepAbsMax);
  if (start >= end) {
    start = clampEncoderTarget(sweepCenter - afFineStep * 4);
    end = clampEncoderTarget(sweepCenter + afFineStep * 4);
  }
  return { start, end, center: sweepCenter };
};

const runAutofocusSweep = async ({
  label,
  sweepStart,
  sweepEnd,
  step,
  settleMs,
  quick,
  deadline,
  initialBestScore,
  initialBestPos,
  onProgress,
}) => {
  let bestScore = initialBestScore;
  let bestPos = initialBestPos;
  let peakScore = initialBestScore;
  let worseStreak = 0;
  let sweepPos = sweepStart;
  const totalSteps = Math.max(1, Math.ceil((sweepEnd - sweepStart) / step));
  let stepIdx = 0;

  const measureAt = async (pos) => {
    const score = await measureSharpnessHere({ quick });
    console.log(
      `[AUTOFOCUS-HC] ${label} pos=${pos} score=${score.toFixed(1)} best=${bestScore.toFixed(1)}@${bestPos}`
    );
    return score;
  };

  if (!hillClimbCancelFlag && Date.now() < deadline) {
    try {
      const s = await measureAt(sweepStart);
      if (s > bestScore) {
        bestScore = s;
        bestPos = sweepStart;
        peakScore = s;
      }
    } catch (err) {
      console.warn(`[AUTOFOCUS-HC] ${label} start measure failed:`, err.message);
    }
  }

  while (sweepPos < sweepEnd && !hillClimbCancelFlag && Date.now() < deadline) {
    const nextPos = clampEncoderTarget(Math.min(sweepEnd, sweepPos + step));
    if (nextPos === sweepPos) break;

    stepIdx++;
    onProgress?.({
      stepIdx,
      totalSteps,
      sweepPos,
      bestPos,
    });

    try {
      await gotoAndWait(nextPos, settleMs, 12000);
      if (hillClimbCancelFlag) break;

      const score = await measureAt(nextPos);
      if (hillClimbCancelFlag) break;

      if (score > bestScore) {
        bestScore = score;
        bestPos = nextPos;
        worseStreak = 0;
        peakScore = score;
      } else if (peakScore > 0 && score < peakScore * afPeakDropRatio) {
        worseStreak++;
        if (worseStreak >= afPeakDropSteps) {
          console.log(
            `[AUTOFOCUS-HC] ${label} early stop at ${nextPos} (past peak @${bestPos})`
          );
          sweepPos = nextPos;
          break;
        }
      } else {
        worseStreak = Math.max(0, worseStreak - 1);
      }

      sweepPos = nextPos;
    } catch (err) {
      if (hillClimbCancelFlag) break;
      console.warn(`[AUTOFOCUS-HC] ${label} step failed at ${nextPos}:`, err.message);
      break;
    }
  }

  return { bestScore, bestPos, sweepPos };
};

const gotoAndWait = async (targetPos, settleMs, timeoutMs = 35000) => {
  const ctx = { dispatchId: null, dispatched: false };
  let handler;
  let timer;

  const donePromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      motorDoneEmitter.off('done', handler);
      resolve({ timeout: true });
    }, timeoutMs);

    handler = (data) => {
      if (!ctx.dispatched) return;
      const matchesDispatch = ctx.dispatchId == null || data.dispatchId === ctx.dispatchId;
      if (matchesDispatch || data.command === 'stop') {
        clearTimeout(timer);
        motorDoneEmitter.off('done', handler);
        resolve(data);
      }
    };

    motorDoneEmitter.on('done', handler);
  });

  try {
    await sendControlFallback(`GOTO:${targetPos}`);
  } catch (err) {
    clearTimeout(timer);
    motorDoneEmitter.off('done', handler);
    throw err;
  }
  const info = setMotorTaskStarted('goto', 'af-hill-climb', { trackConfirmation: true });
  ctx.dispatchId = info?.dispatchId ?? null;
  ctx.dispatched = true;

  await donePromise;
  if (settleMs > 0 && !hillClimbCancelFlag) await sleep(settleMs);
};

const runHillClimbAutofocus = async () => {
  hillClimbCancelFlag = false;
  const deadline = Date.now() + afTimeoutMs;

  // ── Greedy hill-climb với early stop ────────────────────────────────────────
  // Nguyên lý: kính hiển vi chỉ nét ở 1 điểm duy nhất (unimodal focus curve).
  // Bước từng nấc theo 1 chiều, dừng ngay khi score giảm N lần liên tiếp.
  // Thời gian: ~5-10 nấc × 70ms = 350-700ms + pre-goto ≈ 1.5-2s tổng.

  const AF_MAX_STEPS = 60;         // tối đa 60 nấc (dự phòng)
  const AF_END_ENC = 10500;        // dừng khi encoder đạt 10500

  // Khởi động OpenCV2
  cv2Start();
  afStartCapture();

  // Lấy encoder hiện tại
  let curPos;
  try {
    await sendFocusAuxCommand('ENC_POS');
    await sleep(150);
    curPos = getEncoderCurrent();
    if (!Number.isFinite(curPos)) throw new Error('encoder_not_ready');
    curPos = clampEncoderTarget(curPos);
  } catch (err) {
    afStopCapture(); cv2Stop();
    failAutofocusProgress('encoder_not_ready');
    autofocusTask = null;
    return;
  }

  // Luôn bắt đầu từ 9500 (user yêu cầu) — focus_in từng nấc lên đến vùng nét.
  // Warm-start chỉ dùng để logging, không ảnh hưởng startPos.
  const warmPos = Number.isFinite(afBestPosMemory) && afBestPosMemory > 0 ? afBestPosMemory : autofocusEncoderDefaultTarget;
  const startPos = clampEncoderTarget(9500);

  // Pre-goto về startPos nếu cần
  if (Math.abs(curPos - startPos) > 100) {
    setAutofocusProgress({
      phase: 'moving', direction: curPos < startPos ? 'focus_in' : 'focus_out',
      current: curPos, target: startPos, pct: 5, result: null, reason: null,
    }, 'af-pre-goto');
    try {
      await gotoAndWait(startPos, 0, 20000);
      if (hillClimbCancelFlag) {
        afStopCapture(); cv2Stop();
        setAutofocusProgress({ phase: 'idle', pct: 0, result: 'cancelled', reason: null }, 'autofocus-cancel');
        autofocusTask = null; return;
      }
    } catch (err) {
      if (hillClimbCancelFlag) {
        afStopCapture(); cv2Stop();
        setAutofocusProgress({ phase: 'idle', pct: 0, result: 'cancelled', reason: null }, 'autofocus-cancel');
        autofocusTask = null; return;
      }
    }
  }
  curPos = clampEncoderTarget(getEncoderCurrent() ?? startPos);

  // Chờ cv2 process sẵn sàng (ping/pong, timeout 5s)
  const cv2Ready = await (async () => {
    if (!cv2Proc) return false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      cv2Resolvers.push({
        resolve: (val) => { clearTimeout(timer); resolve(val !== 0); },
        reject: () => { clearTimeout(timer); resolve(false); },
        timer,
      });
      try { cv2Proc.stdin.write('ping\n'); } catch (_) { clearTimeout(timer); resolve(false); }
    });
  })();
  console.log(`[AF] cv2 ready=${cv2Ready} startPos=${curPos} warmPos=${warmPos}`);

  // Đo baseline tại startPos
  let bestScore = 0;
  let bestPos = curPos;
  try {
    bestScore = cv2Ready ? await cv2Measure(4000) : await measureSharpnessHere();
    console.log(`[AF] Start pos=${curPos} score=${bestScore.toFixed(2)}`);
  } catch (_) {
    // Nếu đo thất bại, thử fallback goto về warmPos
    afStopCapture(); cv2Stop();
    const fallbackPos = clampEncoderTarget(warmPos);
    try { await gotoAndWait(fallbackPos, 0, 15000); } catch (__) { /* ignore */ }
    const finalPos = getEncoderCurrent() ?? fallbackPos;
    setAutofocusProgress({ phase: 'done', direction: null, current: finalPos, target: fallbackPos, pct: 100, result: 'fallback_goto', reason: null }, 'af-fallback');
    setTargetEncoderState({ target: fallbackPos, returning: false, lastResult: 'autofocus_reached', lastReachedAt: Date.now() }, 'af-fallback');
    saveAfBestPos(fallbackPos);
    autofocusTask = null; return;
  }

  // ── Full scan 9500→10500 dùng focus_in từng nấc ──
  // Quét TOÀN BỘ range, đo hết rồi mới kết luận vị trí nét nhất.
  // Không dừng sớm — đảm bảo không bỏ sót peak.
  const focusInStep = (timeoutMs = 3000) => new Promise((resolve) => {
    const timer = setTimeout(() => { motorDoneEmitter.off('done', handler); resolve(); }, timeoutMs);
    const handler = (data) => {
      if (!data.command || data.command === 'focus_in' || data.command === 'focus_out' || data.command === 'stop') {
        clearTimeout(timer); motorDoneEmitter.off('done', handler); resolve(data);
      }
    };
    motorDoneEmitter.on('done', handler);
    sendControlFallback('focus_in').catch(() => {
      clearTimeout(timer); motorDoneEmitter.off('done', handler); resolve();
    });
  });

  let step = 0;

  while (step < AF_MAX_STEPS && !hillClimbCancelFlag && Date.now() < deadline) {
    if (curPos >= AF_END_ENC) {
      console.log(`[AF] Reached end of scan range ${AF_END_ENC}`);
      break;
    }

    const pct = Math.min(90, Math.round(((curPos - 9500) / (AF_END_ENC - 9500)) * 85 + 5));
    setAutofocusProgress({
      phase: 'moving', direction: 'focus_in',
      current: curPos, target: AF_END_ENC,
      pct, result: null, reason: null,
    }, 'af-step');

    try {
      await focusInStep(3000);
      if (hillClimbCancelFlag) break;

      await sendFocusAuxCommand('ENC_POS');
      await sleep(80);
      const stepPos = getEncoderCurrent() ?? curPos;

      const score = cv2Ready ? await cv2Measure(4000) : await measureSharpnessHere();
      if (hillClimbCancelFlag) break;

      console.log(`[AF] step=${step} pos=${stepPos} score=${score.toFixed(2)} best=${bestScore.toFixed(2)}@${bestPos}`);

      if (score > bestScore) {
        bestScore = score;
        bestPos = stepPos;
      }
      curPos = stepPos;
    } catch (err) {
      if (hillClimbCancelFlag) break;
      console.warn('[AF] Step failed:', err.message);
      break;
    }
    step++;
  }

  afStopCapture(); cv2Stop();

  if (hillClimbCancelFlag) {
    setAutofocusProgress({ phase: 'idle', pct: 0, result: 'cancelled', reason: null }, 'autofocus-cancel');
    autofocusTask = null; return;
  }

  // Backlash fix: lùi 500 enc rồi tiến lên bestPos từ dưới.
  try {
    const posNow = getEncoderCurrent() ?? curPos;
    if (posNow > bestPos + 50) {
      const backoff = clampEncoderTarget(bestPos - 718);
      await gotoAndWait(backoff, 0, 10000);
      if (hillClimbCancelFlag) {
        setAutofocusProgress({ phase: 'idle', pct: 0, result: 'cancelled', reason: null }, 'autofocus-cancel');
        autofocusTask = null; return;
      }
    }
    await gotoAndWait(bestPos, 0, 10000);
  } catch (err) {
    console.warn('[AF] Final goto failed:', err.message);
  }

  const finalPos = getEncoderCurrent() ?? bestPos;
  console.log(`[AF] Done. bestPos=${bestPos} finalPos=${finalPos} score=${bestScore.toFixed(2)} steps=${step}`);

  setAutofocusProgress({ phase: 'done', direction: null, current: finalPos, target: bestPos, pct: 100, result: 'found', reason: null }, 'autofocus-hc-done');
  setTargetEncoderState({ target: bestPos, returning: false, lastResult: 'autofocus_reached', lastReachedAt: Date.now() }, 'autofocus-hc-done');
  saveAfBestPos(bestPos);
  autofocusTask = null;

  // Hàm này không dùng nữa — keep compiler happy
  void deadline;

};

// ─────────────────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  const role =
    socket.handshake.auth?.role ||
    socket.handshake.headers['x-socket-role'] ||
    socket.handshake.query?.role ||
    'web';

  if (role === 'pi-agent') {
    const name = socket.handshake.auth?.name || socket.handshake.query?.name || 'pi-agent';

    piAgents.set(socket.id, { socket, name, connectedAt: Date.now() });
    syncPiState();

    socket.on('pi_uart_feedback', (feedback) => {
      const line = feedback?.line || '';

      if (isStm32HeartbeatPing(line)) {
        onStm32PingReceived();
        return;
      }

      io.emit('control_feedback', { ...feedback, source: 'pi-agent', at: Date.now() });
      applyFocusFeedbackLine(line, 'pi-uart-feedback');
      applyEncoderFeedbackLine(line, 'pi-uart-feedback');
      applyXyFeedbackLine(line, 'pi-uart-feedback');
      applyHomingFeedbackLine(line, 'pi-uart-feedback');

      const motorState = parseMotorStateFromFeedback(line);
      if (!motorState) return;

      if (motorState.status === 'done') {
        setMotorTaskDone({ command: motorState.command, source: 'pi-uart-feedback', line });
        return;
      }

      if (motorState.status === 'started') {
        const commandToMark = motorState.command || app.locals.controlState.motorTask.command;
        if (!commandToMark) return;
        setMotorTaskStarted(commandToMark, 'pi-uart-feedback', { trackConfirmation: false });
      }
    });


    socket.on('disconnect', () => {
      piAgents.delete(socket.id);
      syncPiState();
      console.log(`🔴 Pi agent disconnected: ${name}`);
    });

    socket.emit('pi_agent_registered', { status: 'ok', id: socket.id, name });
    console.log(`🟢 Pi agent connected: ${name}`);
    return;
  }

  // ─── Web client ─────────────────────────────────────────────────────────────
  console.log('🟢 Web client connected');
  let focusSyncArmed = false;
  app.locals.controlState.connectedClients += 1;
  clearDisconnectFailsafeTimeout();

  socket.emit('control_status', {
    status: controlEnabled ? 'online' : 'disabled',
    connectedClients: app.locals.controlState.connectedClients,
  });

  socket.emit('control_transport', {
    status: {
      uart: app.locals.controlState.uart,
      piAgent: app.locals.controlState.piAgent,
    },
  });

  socket.emit('motor_state', {
    status: app.locals.controlState.motorTask.inProgress ? 'started' : 'idle',
    command: app.locals.controlState.motorTask.command,
    pendingCount: app.locals.controlState.motorTask.pendingConfirmations?.length || 0,
    at: Date.now(),
    source: 'snapshot',
  });

  socket.emit('focus_position', {
    ...app.locals.controlState.focusPosition,
    source: 'snapshot',
    at: Date.now(),
  });

  socket.emit('focus_encoder', {
    ...app.locals.controlState.focusEncoder,
    source: 'snapshot',
    at: Date.now(),
  });

  socket.emit('positioning_state', {
    ...app.locals.controlState.positioning,
    source: 'snapshot',
    at: Date.now(),
  });

  socket.emit('homing_status', {
    ...app.locals.controlState.homing,
    source: 'snapshot',
    at: Date.now(),
  });

  socket.emit('recovery_home_status', {
    ...app.locals.controlState.recoveryHome,
    source: 'snapshot',
    at: Date.now(),
  });

  socket.emit('autofocus_progress', {
    ...app.locals.controlState.autofocus,
    source: 'snapshot',
    at: Date.now(),
  });

  socket.emit('target_encoder_state', {
    ...app.locals.controlState.targetEncoder,
    source: 'snapshot',
    at: Date.now(),
  });

  socket.emit('xy_position', {
    ...app.locals.controlState.xyPosition,
    source: 'snapshot',
    at: Date.now(),
  });

  socket.emit('stm32_status', {
    status: stm32WasConnected ? STM32_STATUS_CONNECTED : STM32_STATUS_DISCONNECTED,
    lastPingAt: stm32LastPingAt || null,
    at: Date.now(),
    source: 'snapshot',
  });

  socket.on('focus_position_query', async (callback) => {
    try {
      const result = await sendFocusAuxCommand('FOCUS_POS');
      callback?.({ status: 'accepted', detail: result });
    } catch (error) {
      console.warn('[AUX] FOCUS_POS rejected:', error.message);
      callback?.({ status: 'rejected', reason: error.message });
    }
  });

  socket.on('focus_position_zero', async (callback) => {
    if (!allowManualZeroCommand) {
      callback?.({ status: 'rejected', reason: 'manual_zero_disabled' });
      return;
    }

    try {
      cancelReturnToTarget('cleared_by_focus_zero');

      const focusZeroResult = await sendFocusAuxCommand('FOCUS_ZERO');
      const encoderZeroResult = await sendFocusAuxCommand('ENC_ZERO');

      setTargetEncoderState(
        { target: null, returning: false, lastResult: 'cleared_by_focus_zero' },
        'focus-zero'
      );

      setFocusPosition(
        { current: app.locals.controlState.focusPosition.min },
        'backend-zero'
      );

      await sleep(encoderQuerySettleMs);

      setPositioningState(
        {
          homed: true,
          state: POSITIONING_STATE_TRACKING,
          stale: false,
          lastEncoderAt: Date.now(),
        },
        'backend-homed'
      );

      focusSyncArmed = true;

      callback?.({
        status: 'accepted',
        detail: { focusZero: focusZeroResult, encoderZero: encoderZeroResult },
        encoderSnapshot: app.locals.controlState.focusEncoder,
        focusSyncArmed,
      });
    } catch (error) {
      console.warn('[AUX] FOCUS_ZERO rejected:', error.message);
      callback?.({ status: 'rejected', reason: error.message });
    }
  });

  socket.on('target_encoder_query', (callback) => {
    callback?.({ status: 'accepted', snapshot: app.locals.controlState.targetEncoder });
  });

  socket.on('target_encoder_save', async (payload, callback) => {
    const explicitTarget = Number(payload?.target);
    let target = Number.isFinite(explicitTarget) ? explicitTarget : getEncoderCurrent();
    target = clampEncoderTarget(target);

    if (!Number.isFinite(target)) {
      callback?.({ status: 'rejected', reason: 'encoder_not_ready' });
      return;
    }

    setTargetEncoderState({ target, lastResult: 'saved' }, 'target-save');
    callback?.({ status: 'accepted', target, snapshot: app.locals.controlState.targetEncoder });
  });

  socket.on('return_to_target', async (callback) => {
    if (!controlEnabled) {
      callback?.({ status: 'rejected', reason: 'control_disabled' });
      return;
    }

    if (app.locals.controlState.targetEncoder?.returning) {
      callback?.({ status: 'rejected', reason: 'return_in_progress' });
      return;
    }

    try {
      const result = await runReturnToTarget();
      callback?.(result);
    } catch (error) {
      callback?.({ status: 'rejected', reason: error.message || 'return_failed' });
    }
  });

  socket.on('return_to_target_cancel', async (callback) => {
    cancelReturnToTarget('cancelled_by_user');

    try {
      await sendControlFallback('stop');
    } catch (_error) {
      // ignore transport stop errors on cancel path
    }

    callback?.({ status: 'accepted' });
  });

  socket.on('encoder_position_query', async (callback) => {
    try {
      const result = await sendFocusAuxCommand('ENC_POS');
      await sleep(encoderQuerySettleMs);

      if (Number.isFinite(app.locals.controlState.focusEncoder?.current)) {
        setPositioningState(
          {
            homed: true,
            state: POSITIONING_STATE_TRACKING,
            stale: false,
            lastEncoderAt: Date.now(),
          },
          'encoder-query-sync'
        );
        focusSyncArmed = true;
      }

      callback?.({
        status: 'accepted',
        detail: result,
        snapshot: app.locals.controlState.focusEncoder,
        positioningSnapshot: app.locals.controlState.positioning,
        focusSyncArmed,
      });
    } catch (error) {
      console.warn('[AUX] ENC_POS rejected:', error.message);
      callback?.({ status: 'rejected', reason: error.message, focusSyncArmed });
    }
  });

  socket.on('xy_position_query', async (callback) => {
    try {
      const result = await sendFocusAuxCommand('XY_POS');
      callback?.({ status: 'accepted', detail: result, snapshot: app.locals.controlState.xyPosition });
    } catch (error) {
      console.warn('[AUX] XY_POS rejected:', error.message);
      callback?.({ status: 'rejected', reason: error.message });
    }
  });

  socket.on('request_home_min', async (callback) => {
    if (!controlEnabled) {
      callback?.({ status: 'rejected', reason: 'control_disabled' });
      return;
    }

    try {
      await sendFocusAuxCommand('HOME_MIN');
      callback?.({ status: 'accepted' });
    } catch (error) {
      console.warn('[AUX] HOME_MIN rejected:', error.message);
      callback?.({ status: 'rejected', reason: error.message });
    }
  });

  // ─── Autofocus run ────────────────────────────────────────────────────────
  // Nếu Pi Agent đang kết nối: delegate toàn bộ engine (closed-loop sharpness).
  // Fallback: gửi 1 lệnh GOTO duy nhất về encoder target cố định (open-loop cũ).
  socket.on('autofocus_run', async (payload, callback) => {
    if (!controlEnabled) {
      callback?.({ status: 'rejected', reason: 'control_disabled' });
      return;
    }

    const autofocusState = app.locals.controlState.autofocus || {};
    const autofocusBusy = Boolean(
      autofocusTask ||
      autofocusState.phase === 'starting' ||
      autofocusState.phase === 'moving'
    );

    if (autofocusBusy) {
      callback?.({ status: 'rejected', reason: 'autofocus_in_progress' });
      return;
    }

    const motorTaskState = app.locals.controlState.motorTask || {};
    const now = Date.now();
    const pendingNow = Array.isArray(motorTaskState.pendingConfirmations)
      ? motorTaskState.pendingConfirmations
      : [];
    const alivePending = pendingNow.filter((entry) => Number(entry?.expiresAt || 0) > now);

    if (alivePending.length !== pendingNow.length) {
      app.locals.controlState.motorTask = {
        ...motorTaskState,
        pendingConfirmations: alivePending,
        inProgress: alivePending.length > 0,
        command: alivePending.length ? alivePending[alivePending.length - 1].command : null,
      };
    }

    if (alivePending.length > 0) {
      callback?.({ status: 'rejected', reason: 'motor_busy' });
      return;
    }

    if (app.locals.controlState.targetEncoder?.returning) {
      cancelReturnToTarget('cancelled_by_autofocus');
    }

    const positioningState = app.locals.controlState.positioning || {};
    const homingState = app.locals.controlState.homing || {};

    if (isStm32HeartbeatStale() || isStm32RehomePending()) {
      callback?.({
        status: 'rejected',
        reason: isStm32RehomePending() ? 'rehome_pending' : 'stm32_heartbeat_lost',
      });
      return;
    }

    if (positioningState.state === POSITIONING_STATE_REHOME_REQUIRED) {
      callback?.({ status: 'rejected', reason: 'rehome_required' });
      return;
    }

    if (homingState.state === HOMING_STATE_AUTO_HOMING) {
      callback?.({ status: 'rejected', reason: 'auto_homing_in_progress' });
      return;
    }

    if (homingState.fault || homingState.state === HOMING_STATE_FAULT) {
      callback?.({ status: 'rejected', reason: homingState.lastFaultReason || 'home_failed' });
      return;
    }

    if (homingState.state !== HOMING_STATE_READY || !homingState.posValid) {
      callback?.({ status: 'rejected', reason: 'homing_not_ready' });
      return;
    }

    if (afEnabled) {
      // Hill-climbing autofocus: đo sharpness qua RTSP, tìm vị trí encoder tốt nhất
      const startCurrent = getEncoderCurrent();
      autofocusTask = {
        hillClimb: true,
        start: Number.isFinite(startCurrent) ? startCurrent : null,
        target: null,
        direction: null,
        mode: 'hill-climb',
      };

      setAutofocusProgress(
        {
          phase: 'starting',
          direction: null,
          current: Number.isFinite(startCurrent) ? startCurrent : null,
          target: null,
          pct: 0,
          result: null,
          reason: null,
        },
        'autofocus-hc-start'
      );

      callback?.({ status: 'accepted', mode: 'hill-climb' });

      runHillClimbAutofocus().catch((err) => {
        console.error('[AUTOFOCUS-HC] Unhandled error:', err.message);
        if (autofocusTask?.hillClimb) {
          failAutofocusProgress(err.message || 'autofocus_failed');
          autofocusTask = null;
        }
      });
      return;
    }

    // Fallback: fixed GOTO khi AUTOFOCUS_HC_ENABLED=false
    const targetPos = autofocusEncoderDefaultTarget;
    const autofocusStartCurrent = getEncoderCurrent();
    const finalDirection = buildAutofocusDirection(targetPos, autofocusStartCurrent);

    console.log(`[AUTOFOCUS] GOTO fixed target → ${targetPos}`);

    setAutofocusProgress(
      {
        phase: 'moving',
        direction: finalDirection || null,
        current: Number.isFinite(autofocusStartCurrent) ? autofocusStartCurrent : null,
        target: targetPos,
        pct: 0,
        result: null,
        reason: null,
      },
      'autofocus-goto'
    );

    try {
      await sendControlFallback(`GOTO:${targetPos}`);
    } catch (err) {
      autofocusTask = null;
      failAutofocusProgress(err.message || 'send_failed', 'autofocus-send-error');
      callback?.({ status: 'rejected', reason: err.message || 'send_failed' });
      return;
    }

    const startedInfo = setMotorTaskStarted('goto', 'autofocus', { trackConfirmation: true });

    setTargetEncoderState(
      { target: targetPos, returning: false, lastResult: 'autofocus_dispatched' },
      'autofocus-goto'
    );

    autofocusTask = {
      dispatchId: startedInfo?.dispatchId || null,
      target: targetPos,
      start: Number.isFinite(autofocusStartCurrent) ? autofocusStartCurrent : null,
      direction: finalDirection,
      mode: 'fixed-goto',
    };

    markAutofocusMoving('autofocus-goto');
    callback?.({ status: 'accepted', mode: 'fixed-goto', target: targetPos });
  });

  // ─── Autofocus cancel ──────────────────────────────────────────────────────
  // Bug #8 fix: Frontend gửi emit('autofocus_cancel', {}, callback)
  // → Socket.IO truyền 2 args: (payload, callback). Cần nhận cả 2.
  socket.on('autofocus_cancel', async (_payload, callback) => {
    // Nếu frontend gửi emit('autofocus_cancel', callback) (ko có payload),
    // thì _payload sẽ là function callback. Handle cả 2 trường hợp.
    const ack = typeof _payload === 'function' ? _payload : callback;
    const autofocusState = app.locals.controlState.autofocus || {};
    const wasRunning = autofocusState.phase === 'starting' || autofocusState.phase === 'moving';
    const currentValue = getEncoderCurrent();

    hillClimbCancelFlag = true; // báo cho hill-climb loop dừng lại
    afStopCapture();            // dừng persistent RTSP capture nếu đang chạy
    autofocusTask = null;
    if (wasRunning) {
      setAutofocusProgress(
        {
          phase: 'idle',
          direction: null,
          current: Number.isFinite(currentValue) ? currentValue : autofocusState.current ?? null,
          target: null,
          pct: 0,
          result: 'cancelled',
          reason: null,
        },
        'autofocus-cancel'
      );
    }

    try {
      await sendControlFallback('stop');
    } catch (_err) {
      // ignore
    }

    console.log('[AUTOFOCUS] Đã hủy Autofocus');
    ack?.({ status: 'accepted' });
  });
  // ─────────────────────────────────────────────────────────────────────────

  socket.on('control_motor', async (rawPayload, callback) => {
    const payload = normalizeControlPayload(rawPayload);
    const command = payload.command || 'unknown';

    // Bug #3 fix: Check controlEnabled TRƯỚC tất cả — nếu disabled, không cần
    // check homing/positioning → user nhận đúng lỗi 'control_disabled'.
    if (!controlEnabled) {
      callback?.({ status: 'rejected', reason: 'control_disabled', command });
      return;
    }

    const isXyMotorCommand = command === 'up' || command === 'down' || command === 'left' || command === 'right';
    if (app.locals.controlState.targetEncoder?.returning) {
      if (command === 'stop' || !isXyMotorCommand) {
        // User command always wins — cancel returnToTarget immediately.
        // Không reject nữa, để lệnh tiếp tục execute.
        cancelReturnToTarget('cancelled_by_user_command');
      }
    }

    const positioningState = app.locals.controlState.positioning || {};
    const homingState = app.locals.controlState.homing || {};
    const needsHomed = command === 'focus_in' || command === 'focus_out';

    if (needsHomed && (isStm32HeartbeatStale() || isStm32RehomePending())) {
      const reason = isStm32RehomePending() ? 'rehome_pending' : 'stm32_heartbeat_lost';
      callback?.({ status: 'rejected', reason, command });
      socket.emit('control_status', {
        status: 'rejected', command, reason, at: Date.now(),
      });
      return;
    }

    if (needsHomed && positioningState.state === POSITIONING_STATE_REHOME_REQUIRED) {
      callback?.({ status: 'rejected', reason: 'rehome_required', command });
      socket.emit('control_status', {
        status: 'rejected', command, reason: 'rehome_required', at: Date.now(),
      });
      return;
    }

    if (needsHomed && homingState.state === HOMING_STATE_AUTO_HOMING) {
      callback?.({ status: 'rejected', reason: 'auto_homing_in_progress', command });
      socket.emit('control_status', {
        status: 'rejected', command, reason: 'auto_homing_in_progress', at: Date.now(),
      });
      return;
    }

    if (needsHomed && (homingState.fault || homingState.state === HOMING_STATE_FAULT)) {
      callback?.({
        status: 'rejected',
        reason: homingState.lastFaultReason || 'home_failed',
        command,
      });
      socket.emit('control_status', {
        status: 'rejected',
        command,
        reason: homingState.lastFaultReason || 'home_failed',
        at: Date.now(),
      });
      return;
    }

    if (needsHomed && (homingState.state !== HOMING_STATE_READY || !homingState.posValid)) {
      callback?.({ status: 'rejected', reason: 'homing_not_ready', command });
      socket.emit('control_status', {
        status: 'rejected', command, reason: 'homing_not_ready', at: Date.now(),
      });
      return;
    }

    if (needsHomed && command === 'focus_out' && homingState.endstopMin) {
      callback?.({ status: 'rejected', reason: 'LIMIT_MIN', command });
      socket.emit('control_status', {
        status: 'rejected', command, reason: 'LIMIT_MIN', at: Date.now(),
      });
      return;
    }

    if (controlFocusOnly && !focusOnlyAllowedCommands.has(command)) {
      callback?.({ status: 'rejected', reason: 'focus_only_mode', command });
      socket.emit('control_status', {
        status: 'rejected', command, reason: 'focus_only_mode', at: Date.now(),
      });
      return;
    }

    // Motor_busy check đã bị bỏ hoàn toàn — firmware tự xử lý BUSY.
    // Pending tracking gây stale pending khi MOTOR_DONE bị drop → freeze buttons.

    // STOP trong khi autofocus đang chạy → cancel autofocus ngay,
    // tránh sweep loop tiếp tục và làm motor chạy thêm sau khi STOP.
    if (command === 'stop' && autofocusTask) {
      hillClimbCancelFlag = true;
      afStopCapture();
      autofocusTask = null;
      const afStateNow = app.locals.controlState.autofocus || {};
      if (afStateNow.phase === 'starting' || afStateNow.phase === 'moving') {
        setAutofocusProgress({
          phase: 'idle', direction: null,
          current: getEncoderCurrent(), target: null,
          pct: 0, result: 'cancelled', reason: 'stopped_by_user',
        }, 'stop-command');
      }
    }

    if (autofocusTask && command !== 'stop') {
      const blockXy = autofocusTask.hillClimb === true;
      if (!isXyMotorCommand || blockXy) {
        callback?.({ status: 'rejected', reason: 'autofocus_in_progress', command });
        socket.emit('control_status', {
          status: 'rejected', command, reason: 'autofocus_in_progress', at: Date.now(),
        });
        return;
      }
    }

    try {
      const transportResult = await sendControlFallback(command);
      // Không track pending cho bất kỳ lệnh nào — firmware tự xử lý BUSY.
      // Tránh stale pending → motor_busy freeze buttons.
      const startedInfo = setMotorTaskStarted(command, 'control-dispatch', {
        trackConfirmation: false,
      });

      app.locals.controlState.lastCommand = {
        ...payload,
        command,
        transport: transportResult.transport,
      };

      if (command === 'focus_in' || command === 'focus_out') {
        applyFocusPositionDelta(command, 'backend-dispatch');
      }

      callback?.({
        status: 'accepted',
        command,
        mode: payload.mode,
        at: payload.timestamp,
        transport: transportResult.transport,
        dispatchId: startedInfo?.dispatchId || null,
        pendingCount: startedInfo?.pendingCount || 0,
      });

      console.log('Nhận lệnh điều khiển:', { ...payload, command, transport: transportResult.transport });

      socket.emit('control_status', {
        status: 'executed',
        command,
        mode: payload.mode,
        dispatchId: startedInfo?.dispatchId || null,
        pendingCount: startedInfo?.pendingCount || 0,
        at: Date.now(),
      });
    } catch (error) {
      callback?.({ status: 'rejected', reason: error.message, command });
      socket.emit('control_status', {
        status: 'rejected', command, reason: error.message, at: Date.now(),
      });
    }
  });


  socket.on('disconnect', (reason) => {
    saveCurrentEncoderAsTarget('web-disconnect', { queryFresh: true }).catch(() => undefined);
    focusSyncArmed = false;

    app.locals.controlState.connectedClients = Math.max(
      0,
      app.locals.controlState.connectedClients - 1
    );

    if (app.locals.controlState.connectedClients === 0) {
      scheduleDisconnectFailsafe();
    }

    console.log('🔴 Web client disconnected:', reason || 'unknown');
  });
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'backend',
    control: app.locals.controlState,
  });
});

app.use('/health', healthRouter);
app.use('/items', itemsRouter);

const port = Number(process.env.PORT) || 5000;

const startServer = async () => {
  try {
    await connectWithRetry(pool);
    await initDb(pool);

    try {
      await uartBridge.init();
      uartBridge.startWatchdog();
    } catch (uartError) {
      app.locals.controlState.uart = {
        ...app.locals.controlState.uart,
        connected: false,
        mode: 'degraded',
        error: uartError.message,
      };
      console.warn('UART unavailable, backend running in degraded mode:', uartError.message);
    }

    loadAfBestPos();
    syncPiState();
    startPositioningMonitor();
    startStm32Watchdog();

    server.listen(port, () => {
      console.log(`Backend listening on port ${port}`);
    });
  } catch (error) {
    console.error('Database connection failed:', error.message);
    process.exit(1);
  }
};

startServer();

const shutdown = async () => {
  try {
    stopPositioningMonitor();
    stopStm32Watchdog();
    await uartBridge.shutdown();
    await pool.end();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);