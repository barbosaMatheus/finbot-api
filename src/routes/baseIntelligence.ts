import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT contents FROM base_intelligence ORDER BY created_at DESC, id DESC LIMIT 1',
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No base intelligence found' });
    }

    return res.status(200).json({ contents: result.rows[0].contents });
  } catch (error) {
    console.error('[base-intelligence] failed to fetch latest intelligence', error);
    return res.status(500).json({ error: 'Failed to fetch base intelligence' });
  }
});

export default router;
