require('dotenv').config();

const { UartBridge } = require('../src/services/uartBridge');

const DEFAULT_DELAY_MS = 140;
const DEFAULT_TEST1_COUNT = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = () => {
  const args = process.argv.slice(2);
  const parsed = {
    mode: 'test1',
    command: 'focus_in',
    count: DEFAULT_TEST1_COUNT,
    delayMs: DEFAULT_DELAY_MS,
    maxCount: null,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }

    if (token === '--mode' && args[index + 1]) {
      parsed.mode = String(args[index + 1]).trim().toLowerCase();
      index += 1;
      continue;
    }

    if (token === '--command' && args[index + 1]) {
      parsed.command = String(args[index + 1]).trim().toLowerCase();
      index += 1;
      continue;
    }

    if (token === '--count' && args[index + 1]) {
      parsed.count = Number(args[index + 1]);
      index += 1;
      continue;
    }

    if (token === '--delay' && args[index + 1]) {
      parsed.delayMs = Number(args[index + 1]);
      index += 1;
      continue;
    }

    if (token === '--max' && args[index + 1]) {
      parsed.maxCount = Number(args[index + 1]);
      index += 1;
    }
  }

  return parsed;
};

const printHelp = () => {
  console.log('Focus calibration helper');
  console.log('');
  console.log('Modes:');
  console.log('  --mode test1   Send fixed number of focus commands (default 100)');
  console.log('  --mode test2   Send focus commands continuously until you press Q');
  console.log('');
  console.log('Options:');
  console.log('  --command focus_in|focus_out   Command to send (default focus_in)');
  console.log('  --count <n>                    Number of sends in test1 (default 100)');
  console.log('  --delay <ms>                   Delay between sends (default 140)');
  console.log('  --max <n>                      Optional guard max sends in test2');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/focus-calibration.js --mode test1 --count 100 --delay 140');
  console.log('  node scripts/focus-calibration.js --mode test2 --delay 160');
};

const assertOptions = (options) => {
  if (!['test1', 'test2'].includes(options.mode)) {
    throw new Error('invalid_mode');
  }

  if (!['focus_in', 'focus_out'].includes(options.command)) {
    throw new Error('invalid_command');
  }

  if (!Number.isFinite(options.delayMs) || options.delayMs < 20) {
    throw new Error('invalid_delay');
  }

  if (!Number.isInteger(options.count) || options.count <= 0) {
    throw new Error('invalid_count');
  }

  if (options.maxCount !== null && (!Number.isInteger(options.maxCount) || options.maxCount <= 0)) {
    throw new Error('invalid_max');
  }
};

const sendOnce = async (bridge, command, index, total) => {
  const result = await bridge.sendControlCommand(command);
  if (result.status === 'skipped') {
    throw new Error(`uart_${result.reason || 'skipped'}`);
  }
  const suffix = Number.isInteger(total) ? `/${total}` : '';
  console.log(`[${index}${suffix}] sent ${result.normalized}`);
};

const runTest1 = async (bridge, options) => {
  console.log(`[TEST1] Sending ${options.count} x ${options.command} (delay ${options.delayMs} ms)`);
  for (let index = 1; index <= options.count; index += 1) {
    await sendOnce(bridge, options.command, index, options.count);
    await sleep(options.delayMs);
  }
  console.log(`[TEST1] done, total=${options.count}`);
};

const runTest2 = async (bridge, options) => {
  console.log(`[TEST2] Sending ${options.command} continuously (delay ${options.delayMs} ms)`);
  console.log('[TEST2] Press Q to stop and print total click count');

  let running = true;
  let counter = 0;

  const stdin = process.stdin;
  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }
  stdin.setEncoding('utf8');
  stdin.resume();

  const onData = (chunk) => {
    const key = String(chunk || '').toLowerCase();
    if (key === 'q') {
      running = false;
      return;
    }

    if (key === '\u0003') {
      running = false;
    }
  };

  stdin.on('data', onData);

  try {
    while (running) {
      counter += 1;
      await sendOnce(bridge, options.command, counter, null);

      if (options.maxCount !== null && counter >= options.maxCount) {
        console.log(`[TEST2] reached --max ${options.maxCount}, stopping`);
        break;
      }

      await sleep(options.delayMs);
    }
  } finally {
    stdin.off('data', onData);
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }
    stdin.pause();
  }

  console.log(`[TEST2] done, total_clicks=${counter}`);
};

const run = async () => {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    return;
  }

  assertOptions(options);

  const bridge = new UartBridge();

  console.log('[CFG] UART_ENABLED=', process.env.UART_ENABLED ?? '(undefined)');
  console.log('[CFG] UART_PORT=', process.env.UART_PORT || '/dev/serial0');
  console.log('[CFG] UART_BAUD_RATE=', process.env.UART_BAUD_RATE || 115200);

  bridge.on('feedback', (payload) => {
    if (!payload?.line) return;
    console.log(`[STM32] ${payload.line}`);
  });

  bridge.on('status', (status) => {
    console.log('[UART STATUS]', status);
  });

  try {
    await bridge.init();

    if (options.mode === 'test1') {
      await runTest1(bridge, options);
    } else {
      await runTest2(bridge, options);
    }

    await bridge.shutdown();
  } catch (error) {
    console.error('Calibration failed:', error.message);
    await bridge.shutdown();
    process.exitCode = 1;
  }
};

run();
