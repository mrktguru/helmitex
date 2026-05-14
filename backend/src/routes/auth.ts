import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { z } from 'zod';
import prisma from '../prisma/client';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const REFRESH_COOKIE = 'refreshToken';
const ACCESS_EXPIRY = '8h';
const REFRESH_EXPIRY = '30d';

function signAccess(id: string, role: string): string {
  return jwt.sign({ id, role }, process.env.JWT_SECRET!, { expiresIn: ACCESS_EXPIRY });
}

function signRefresh(id: string): string {
  return jwt.sign({ id }, process.env.JWT_REFRESH_SECRET!, { expiresIn: REFRESH_EXPIRY });
}

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await argon2.verify(user.passwordHash, password))) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const accessToken = signAccess(user.id, user.role);
  const refreshToken = signRefresh(user.id);
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ accessToken, user: { id: user.id, email: user.email, role: user.role } });
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const token: string | undefined = req.cookies[REFRESH_COOKIE];
  if (!token) {
    res.status(401).json({ error: 'No refresh token' });
    return;
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as { id: string };
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    const accessToken = signAccess(user.id, user.role);
    res.json({ accessToken });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// POST /api/auth/logout
router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(REFRESH_COOKIE);
  res.json({ ok: true });
});

export default router;
