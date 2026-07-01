import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import healthRouter from './routes/health.js';

dotenv.config();

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? '*',
  }),
);
app.use(express.json());

app.use('/health', healthRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

export default app;
