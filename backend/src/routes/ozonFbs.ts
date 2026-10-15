import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { StockError } from '../services/stock';
import { downloadFile } from '../services/s3';
import { act, batchLabels, carriageAct, formCarriage, days, dayState, labels, ship, syncFbs, writeOffDay } from '../services/ozonFbs';

// Отправки Ozon FBS: мастер сборки отгрузки дня
const router = Router();
router.use(authMiddleware);

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;
const h = (fn: Handler) => async (req: AuthRequest, res: Response, next: (e: unknown) => void) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof StockError) res.status(400).json({ error: e.message });
    else if (e instanceof z.ZodError) res.status(400).json({ error: 'Неверные данные запроса' });
    else next(e);
  }
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (req: AuthRequest) => { if (!DAY.test(req.params.day)) throw new StockError('Неверная дата'); return req.params.day; };
const numbers = z.object({ postingNumbers: z.array(z.string().max(40)).max(2000).optional(), batch: z.enum(['quant', 'multi', 'manual']).nullish() });
const size = z.object({ size: z.enum(['small', 'big']).default('small') });

router.get('/ozon-fbs/days', h(async (_req, res) => { res.json(await days()); }));
router.post('/ozon-fbs/sync', h(async (req, res) => { await syncFbs(req.user!.id); res.json(await days()); }));
router.get('/ozon-fbs/days/:day', h(async (req, res) => { res.json(await dayState(day(req))); }));

router.post('/ozon-fbs/days/:day/ship', h(async (req, res) => {
  const { postingNumbers, batch } = numbers.parse(req.body);
  if (!postingNumbers?.length) throw new StockError('Не выбраны отправления');
  const r = await ship(postingNumbers, req.user!.id, batch);
  res.json({ ...r, state: await dayState(day(req)) });
}));
router.post('/ozon-fbs/days/:day/write-off', h(async (req, res) => {
  const { postingNumbers } = numbers.parse(req.body ?? {});
  const doc = await writeOffDay(day(req), postingNumbers, req.user!.id);
  res.json({ doc: doc ? { id: doc.id, number: doc.number } : null, state: await dayState(day(req)) });
}));
router.post('/ozon-fbs/days/:day/labels', h(async (req, res) => {
  await labels(day(req), size.parse(req.body ?? {}).size);
  res.json(await dayState(day(req)));
}));
router.post('/ozon-fbs/days/:day/batches/:no/labels', h(async (req, res) => {
  await batchLabels(day(req), Number(req.params.no), size.parse(req.body ?? {}).size);
  res.json(await dayState(day(req)));
}));
router.post('/ozon-fbs/days/:day/batches/:no/carriage', h(async (req, res) => {
  await formCarriage(day(req), Number(req.params.no));
  res.json(await dayState(day(req)));
}));
router.get('/ozon-fbs/days/:day/batches/:no/act.pdf', h(async (req, res) => {
  const buf = await carriageAct(day(req), Number(req.params.no));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(`Акт Ozon FBS ${req.params.day} группа ${req.params.no}.pdf`)}`);
  res.end(buf);
}));
router.get('/ozon-fbs/days/:day/batches/:no.pdf', h(async (req, res) => {
  const b = await prisma.ozonFbsBatch.findUnique({ where: { day_no: { day: day(req), no: Number(req.params.no) || 0 } } });
  if (!b?.labelS3Key) throw new StockError('Этикетки группы ещё не сформированы');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(`Этикетки Ozon FBS ${b.day} группа ${b.no}.pdf`)}`);
  res.end(await downloadFile(b.labelS3Key));
}));
router.post('/ozon-fbs/days/:day/act', h(async (req, res) => { await act(day(req)); res.json(await dayState(day(req))); }));

router.get('/ozon-fbs/days/:day/:kind.pdf', h(async (req, res) => {
  const d = await prisma.ozonFbsDay.findUnique({ where: { day: day(req) } });
  const key = req.params.kind === 'labels' ? d?.labelS3Key : req.params.kind === 'act' ? d?.actS3Key : null;
  if (!key) throw new StockError('Файл ещё не сформирован');
  const buf = await downloadFile(key);
  const name = req.params.kind === 'labels' ? `Этикетки Ozon FBS ${req.params.day}.pdf` : `Акт Ozon FBS ${req.params.day}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.end(buf);
}));

export default router;
