require('dotenv').config();

const { UartBridge } = require('../src/services/uartBridge');

const run = async () => {
  const command = process.argv[2] || 'stop';
  const bridge = new UartBridge();

  bridge.on('feedback', (payload) => {
    console.log('[STM32]', payload.line);
  });

  try {
    await bridge.init();
    const result = await bridge.sendControlCommand(command);
    console.log('UART sent:', result);

    setTimeout(async () => {
      await bridge.shutdown();
      process.exit(0);
    }, 500);
  } catch (error) {
    console.error('UART send failed:', error.message);
    await bridge.shutdown();
    process.exit(1);
  }
};

run();
