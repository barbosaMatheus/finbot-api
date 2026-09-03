import { apiReference } from '@scalar/express-api-reference';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import helmet from 'helmet';
import { openApiDocument } from './lib/openapi.js';
import authRouter from './routes/auth.js';
import healthRouter from './routes/health.js';
import baseIntelligenceRouter from './routes/base-intelligence.js';
import embedTextRouter from './routes/embbed-text.js';
import queryVectorDbRouter from './routes/query-vector-db.js';
import onboardingRouter from './routes/onboarding.js';
import plaidRouter from './routes/plaid.js';
import promptTemplateRouter from './routes/prompt-template.js';

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
app.use(express.json());

app.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument);
});

const scalarCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data: https://cdn.jsdelivr.net",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "connect-src 'self' https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
].join('; ');

app.use('/docs', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Content-Security-Policy', scalarCsp);
  next();
});
app.use('/docs', apiReference({ url: '/openapi.json' }));

app.use('/health', healthRouter);
app.use('/auth', authRouter);
app.use('/onboarding', onboardingRouter);
app.use('/plaid', plaidRouter);
app.use('/base-intelligence', baseIntelligenceRouter);
app.use('/embeddings', embedTextRouter);
app.use('/query-vector-db', queryVectorDbRouter);
app.use('/prompt-template', promptTemplateRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

export default app;

