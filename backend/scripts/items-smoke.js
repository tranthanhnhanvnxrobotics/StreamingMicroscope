require('dotenv').config();

const { createPool, connectWithRetry, initDb } = require('../src/config/db');

const run = async () => {
  const pool = createPool();

  try {
    await connectWithRetry(pool, { retries: 3, delayMs: 1000 });
    await initDb(pool);

    const insert = await pool.query(
      'INSERT INTO items (name) VALUES ($1) RETURNING id, name',
      ['smoke-test']
    );

    const id = insert.rows[0].id;
    const select = await pool.query('SELECT id, name FROM items WHERE id = $1', [id]);

    console.log('SMOKE OK:', select.rows[0]);
  } catch (error) {
    console.error('SMOKE FAIL:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

run();
