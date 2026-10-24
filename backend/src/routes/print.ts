import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getCalib, setCalib, testLabel } from '../services/printCalib';

// Калибровка принтера этикеток: сдвиг и масштаб для всех PDF этикеток + тестовая этикетка
const router = Router();
router.use(authMiddleware);

router.get('/print/calibration', async (_req: AuthRequest, res: Response) => { res.json(await getCalib()); });
router.put('/print/calibration', async (req: AuthRequest, res: Response) => {
  const p = z.object({ dxMm: z.number().min(-10).max(10), dyMm: z.number().min(-10).max(10), scalePct: z.number().min(80).max(110) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Сдвиг — от −10 до 10 мм, масштаб — от 80 до 110 %' }); return; }
  await setCalib(p.data);
  res.json(p.data);
});
router.get('/print/test.pdf', async (req: AuthRequest, res: Response) => {
  const w = Number(req.query.w) || 58, h = Number(req.query.h) || 40;
  const buf = await testLabel(Math.min(120, w), Math.min(120, h));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="TEST_${w}x${h}.pdf"`);
  res.end(buf);
});

export default router;
