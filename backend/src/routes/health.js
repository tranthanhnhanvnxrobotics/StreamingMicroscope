const express = require('express');
const { checkDb } = require('../config/db');

const router = express.Router();

router.get('/', (req, res) => {
  const controlState = req.app.locals.controlState || {
    enabled: false,
    connectedClients: 0,
    lastCommand: null,
  };

  res.json({
    status: 'ok',
    control: {
      enabled: controlState.enabled,
      connectedClients: controlState.connectedClients,
      lastCommand: controlState.lastCommand,
      transport: controlState.transport,
      uart: controlState.uart,
    },
  });
});

router.get('/db', async (req, res) => {
  const pool = req.app.locals.pool;

  if (!pool) {
    return res.status(500).json({ status: 'error', error: 'db_pool_missing' });
  }

  try {
    await checkDb(pool);
    return res.json({ status: 'ok' });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: 'db_connection_failed' });
  }
});

module.exports = router;
