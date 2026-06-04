const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const result = await pool.query(
      'SELECT id, name, created_at FROM items ORDER BY id DESC'
    );
    return res.json({ data: result.rows });
  } catch (error) {
    return res.status(500).json({ error: 'items_fetch_failed' });
  }
});

router.get('/:id', async (req, res) => {
  const pool = req.app.locals.pool;
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  try {
    const result = await pool.query(
      'SELECT id, name, created_at FROM items WHERE id = $1',
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'item_not_found' });
    }

    return res.json({ data: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: 'item_fetch_failed' });
  }
});

router.post('/', async (req, res) => {
  const pool = req.app.locals.pool;
  const { name } = req.body || {};

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'invalid_name' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at',
      [name]
    );

    return res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: 'item_create_failed' });
  }
});

router.put('/:id', async (req, res) => {
  const pool = req.app.locals.pool;
  const id = Number(req.params.id);
  const { name } = req.body || {};

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'invalid_name' });
  }

  try {
    const result = await pool.query(
      'UPDATE items SET name = $1 WHERE id = $2 RETURNING id, name, created_at',
      [name, id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'item_not_found' });
    }

    return res.json({ data: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: 'item_update_failed' });
  }
});

router.delete('/:id', async (req, res) => {
  const pool = req.app.locals.pool;
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  try {
    const result = await pool.query(
      'DELETE FROM items WHERE id = $1 RETURNING id',
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'item_not_found' });
    }

    return res.status(204).send();
  } catch (error) {
    return res.status(500).json({ error: 'item_delete_failed' });
  }
});

module.exports = router;
