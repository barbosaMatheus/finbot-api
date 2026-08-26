import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import helmet from 'helmet';
import authRouter from './routes/auth.js';
import healthRouter from './routes/health.js';
import baseIntelligenceRouter from './routes/base-intelligence.js';
import embedTextRouter from './routes/embbed-text.js';
import notificationsRouter from './routes/notifications.js';
import onboardingRouter from './routes/onboarding.js';
import plaidRouter from './routes/plaid.js';

dotenv.config();

const app = express();

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:8081',
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(
  express.json({
    // Plaid webhook verification hashes the exact raw body; capture it
    // before JSON parsing normalizes whitespace.
    verify: (req, _res, buf) => {
      (req as { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.use('/health', healthRouter);
app.use('/auth', authRouter);
app.use('/onboarding', onboardingRouter);
app.use('/notifications', notificationsRouter);
app.use('/plaid', plaidRouter);
app.use('/base-intelligence', baseIntelligenceRouter);
app.use('/embeddings', embedTextRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

export default app;
