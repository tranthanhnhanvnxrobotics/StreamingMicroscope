const { Pool } = require('pg');

const getDbConfig = () => ({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'postgres',
  port: Number(process.env.DB_PORT) || 5432,
});

const createPool = () => new Pool(getDbConfig());

const checkDb = async (pool) => {
  await pool.query('SELECT 1');
};

const initDb = async (pool) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const connectWithRetry = async (pool, options = {}) => {
  const retries = Number(options.retries ?? process.env.DB_RETRY_COUNT ?? 10);
  const delayMs = Number(options.delayMs ?? process.env.DB_RETRY_DELAY_MS ?? 2000);

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await checkDb(pool);
      return;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

module.exports = {
  getDbConfig,
  createPool,
  checkDb,
  initDb,
  connectWithRetry,
};
