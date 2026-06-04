const EventEmitter = require('events');
const { SerialPort, ReadlineParser } = require('serialport');

const COMMAND_MAP = {
  up: 'MOVE_UP',
  down: 'MOVE_DOWN',
  left: 'MOVE_LEFT',
  right: 'MOVE_RIGHT',
  focus_in: 'FOCUS_IN',
  focus_out: 'FOCUS_OUT',
  stop: 'STOP',
  ping: 'PING',
};

const normalizeGotoCommand = (command) => {
  const match = String(command || '')
    .trim()
    .match(/^goto\s*[=:]\s*(-?\d+)$/i);
  if (!match) return null;

  const target = Number(match[1]);
  if (!Number.isFinite(target)) return null;

  // Keep ':' format for compatibility with firmware parser (CMD:GOTO:<target>:<ts>)
  return `GOTO:${Math.round(target)}`;
};

const parseBool = (value, defaultValue = false) => {
  if (value === undefined) return defaultValue;
  return !['false', '0', 'off', 'no'].includes(String(value).toLowerCase());
};

class UartBridge extends EventEmitter {
  constructor(options = {}) {
    super();

    this.enabled = parseBool(options.enabled ?? process.env.UART_ENABLED, false);
    this.portPath = options.path ?? process.env.UART_PORT ?? '/dev/serial0';
    this.baudRate = Number(options.baudRate ?? process.env.UART_BAUD_RATE ?? 115200);
    this.timeoutMs = Number(options.timeoutMs ?? process.env.UART_ACK_TIMEOUT_MS ?? 800);
    this.watchdogEnabled = parseBool(
      options.watchdogEnabled ?? process.env.UART_WATCHDOG_ENABLED,
      false
    );
    this.watchdogIntervalMs = Number(
      options.watchdogIntervalMs ??
        process.env.UART_WATCHDOG_INTERVAL_MS ??
        Math.max(this.timeoutMs, 1500)
    );

    this.port = null;
    this.parser = null;
    this.ready = false;
    this.watchdogTimer = null;
    this.lastFeedback = null;
    this._writeQueue = Promise.resolve();
  }

  async init() {
    if (!this.enabled) {
      this.emit('status', { connected: false, mode: 'disabled' });
      return;
    }

    this.port = new SerialPort({
      path: this.portPath,
      baudRate: this.baudRate,
      autoOpen: false,
    });

    this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));

    this.port.on('open', () => {
      this.ready = true;
      this.emit('status', {
        connected: true,
        mode: 'uart',
        path: this.portPath,
        baudRate: this.baudRate,
      });
    });

    this.port.on('error', (error) => {
      this.ready = false;
      this.emit('status', {
        connected: false,
        mode: 'uart',
        error: error.message,
      });
    });

    this.port.on('close', () => {
      this.ready = false;
      this.emit('status', {
        connected: false,
        mode: 'uart',
        reason: 'port_closed',
      });
    });

    this.parser.on('data', (line) => {
      const payload = String(line).trim();
      if (!payload) return;

      this.lastFeedback = {
        line: payload,
        at: Date.now(),
      };
      this.emit('feedback', this.lastFeedback);
    });

    await new Promise((resolve, reject) => {
      this.port.open((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  normalizeCommand(command) {
    const normalized = String(command || '').trim().toLowerCase();
    return COMMAND_MAP[normalized] || normalizeGotoCommand(command);
  }

  sendWatchdogKick() {
    if (!this.enabled || !this.ready) return;
    this.sendRaw('PING\n').catch(() => undefined);
  }

  startWatchdog() {
    if (!this.enabled || !this.watchdogEnabled) return;
    if (this.watchdogTimer) return;

    this.watchdogTimer = setInterval(() => {
      this.sendWatchdogKick();
    }, Math.max(this.watchdogIntervalMs, 500));
  }

  stopWatchdog() {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  async sendRaw(message) {
    if (!this.enabled) {
      return { status: 'skipped', reason: 'uart_disabled' };
    }

    if (!this.ready || !this.port) {
      throw new Error('uart_not_ready');
    }

    return this._enqueue(() => this._writeRaw(message));
  }

  // Bỏ qua các aux writes đang chờ — motor commands gọi cái này để lấy ưu tiên.
  // Các writes cũ vẫn chạy tiếp trên chain cũ (không cancel được), nhưng
  // write mới tiếp theo sẽ bắt đầu ngay trên chain sạch.
  clearPendingWrites() {
    this._writeQueue = Promise.resolve();
  }

  _enqueue(fn) {
    this._writeQueue = this._writeQueue
      .then(() => fn())
      .catch((err) => {
        // Reset queue on error so subsequent writes are not permanently blocked.
        this._writeQueue = Promise.resolve();
        throw err;
      });
    return this._writeQueue;
  }

  async _writeRaw(message) {
    await new Promise((resolve, reject) => {
      const timeoutMs = Math.max(200, this.timeoutMs);
      const timer = setTimeout(() => {
        reject(new Error('uart_write_timeout'));
      }, timeoutMs);

      this.port.write(message, (error) => {
        if (error) {
          clearTimeout(timer);
          return reject(error);
        }
        this.port.drain((drainError) => {
          clearTimeout(timer);
          if (drainError) return reject(drainError);
          resolve();
        });
      });
    });

    return { status: 'sent', message: message.trim() };
  }

  async sendControlCommand(command) {
    const normalized = this.normalizeCommand(command);
    if (!normalized) {
      throw new Error('unsupported_command');
    }

    const packet = `CMD:${normalized}:${Date.now()}\n`;
    const result = await this.sendRaw(packet);

    return {
      ...result,
      command,
      normalized,
    };
  }

  async shutdown() {
    this.stopWatchdog();

    if (!this.port) return;

    await new Promise((resolve) => {
      this.port.close(() => resolve());
    });
  }
}

module.exports = {
  UartBridge,
};
