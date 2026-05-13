import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import projectsRouter from './routes/projects';
import templatesRouter from './routes/templates';
import czRouter from './routes/cz';
import batchesRouter from './routes/batches';
import { errorHandler } from './middleware/errorHandler';

const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Rate limit auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later.' },
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/users', usersRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/projects', templatesRouter);
app.use('/api/projects', czRouter);
app.use('/api', batchesRouter);

app.use(errorHandler);

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
