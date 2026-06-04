require('dotenv').config();

const { createPool, checkDb } = require('../src/config/db');

const run = async () => {
  const pool = createPool();
  try {
    await checkDb(pool);
    console.log('DB OK');
  } catch (error) {
    console.error('DB FAIL:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

run();
