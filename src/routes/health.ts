import { Router } from 'express';
import { checkConnection } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  const dbUp = await checkConnection();

  res.status(200).json({
    status: 'ok',
    service: 'finbot-api',
    db: dbUp ? 'up' : 'down',
    timestamp: new Date().toISOString(),
  });
});

export default router;
