import { Router, Response } from 'express';
import { tubeLabelsPdf } from '../services/tubeLabel';
import { calibrate } from '../services/printCalib';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { StockError } from '../services/stock';
import { downloadFile } from '../services/s3';
import { callsLastHour } from '../services/ozon';
import { groupCzCodes, batchLabels, carriageAct, pendingLabels, fbsState, formCarriage, postingItems, ship, syncFbs, writeOffPending } from '../services/ozonFbs';
import { syncStatus } from '../services/syncStatus';
import { ddmm, fileName, itemsToken, qtyLines, setShareText } from '../services/share';

// Отправки Ozon FBS: все текущие заказы, сборка группами (кванты, пакеты), этикетки и поставки по группам
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

const KIND: Record<string, string> = { quant: 'квант', multi: 'заказы по 2+ шт.', manual: 'группа', bag: 'пакеты' };
// метка группы в имени файла: KVANT3, 2PLUS12, BAG4, GR12
const groupTag = (b: { kind: string; no: number }) => `${({ quant: 'KVANT', multi: '2PLUS', bag: 'BAG' } as Record<string, string>)[b.kind] ?? 'GR'}${b.no}`;
const dayTag = (day: string) => ddmm(day).replace('.', '');
const group = async (id: string) => {
  const b = await prisma.ozonFbsBatch.findUnique({ where: { id } });
  if (!b) throw new StockError('Группа не найдена');
  return b;
};

router.get('/ozon-fbs/state', h(async (_req, res) => { res.json(await fbsState()); }));
// Обновление из Ozon — в фоне: страница сразу показывает сохранённое, а статус обновления опрашивает отдельно
router.get('/ozon-fbs/api-load', h(async (_req, res) => { res.json({ sellerCallsLastHour: callsLastHour() }); }));
router.get('/ozon-fbs/sync-status', h(async (_req, res) => { res.json(await syncStatus(['fbs'])); }));
router.post('/ozon-fbs/sync', h(async (req, res) => {
  syncFbs(req.user!.id).catch((e) => console.warn('[ozon fbs sync]', (e as Error).message)); // сама учитывается в статусе
  res.json({ started: true, sync: await syncStatus(['fbs']) });
}));

const shipBody = z.object({
  postingNumbers: z.array(z.string().max(40)).min(1).max(2000),
  kind: z.enum(['quant', 'multi', 'manual', 'bag']),
  quantTypeId: z.string().uuid().nullish(),
  limit: z.number().int().positive().nullish(),
  labels: z.boolean().default(true),
  carriage: z.boolean().default(false),
  reserve: z.array(z.string().max(40)).max(200).optional(),
});
router.post('/ozon-fbs/ship', h(async (req, res) => {
  const { postingNumbers, ...opts } = shipBody.parse(req.body);
  const r = await ship(postingNumbers, req.user!.id, opts);
  res.json({ ...r, state: await fbsState() });
}));
router.post('/ozon-fbs/write-off', h(async (req, res) => {
  const doc = await writeOffPending(req.user!.id);
  res.json({ doc: doc ? { id: doc.id, number: doc.number } : null, state: await fbsState() });
}));

router.post('/ozon-fbs/batches/:id/labels', h(async (req, res) => {
  const { size } = z.object({ size: z.enum(['small', 'big']).default('small') }).parse(req.body ?? {});
  await batchLabels((await group(req.params.id)).id, size);
  res.json(await fbsState());
}));
router.post('/ozon-fbs/carriage', h(async (req, res) => {
  const { batchIds } = z.object({ batchIds: z.array(z.string().uuid()).min(1).max(200) }).parse(req.body);
  const id = await formCarriage(batchIds);
  res.json({ carriageId: id, state: await fbsState() });
}));

router.get('/ozon-fbs/batches/:id/act.pdf', h(async (req, res) => {
  const b = await group(req.params.id);
  const buf = await carriageAct(b.id);
  setShareText(res, [`Акт Ozon FBS · поставка ${b.carriageId} · группа №${b.no}`, `Отправлений: ${b.postings} · ${b.units} шт`]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName(['OZON_FBS_ACT', b.carriageId, groupTag(b)]))}`);
  res.end(buf);
}));
router.get('/ozon-fbs/batches/:id/pending-labels.pdf', h(async (req, res) => {
  const b = await group(req.params.id);
  const { numbers, pdf } = await pendingLabels(b.id);
  const items = await postingItems(numbers);
  setShareText(res, [
    `Этикетки Ozon FBS 58×40 · ${KIND[b.kind] ?? 'группа'} №${b.no} · только несданные`,
    ...qtyLines(items), `Этикеток: ${numbers.length} из ${b.postings}`, b.carriageId && `Поставка ${b.carriageId}`,
  ]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName(['OZON_FBS', b.carriageId ?? dayTag(b.day), itemsToken(items), groupTag(b), `REST${numbers.length}`]))}`);
  res.end(await calibrate(pdf));
}));
// ЧЗ на тубы 30×20 для группы: при первом скачивании выдаются коды на тубы «без ЧЗ», дальше — те же
router.get('/ozon-fbs/batches/:id/cz-tube.pdf', h(async (req, res) => {
  const b = await group(req.params.id);
  const { codeIds, noCodes } = await groupCzCodes(b.id);
  if (!codeIds.length) throw new StockError(noCodes ? `Тубы группы №${b.no} — из начальных остатков «с ЧЗ»: их кодов в портале нет, малую этикетку не напечатать` : `В группе №${b.no} нет туб с обязательной маркировкой`);
  const items = await postingItems(await prisma.ozonFbsPosting.findMany({ where: { batchId: b.id }, select: { postingNumber: true } }).then((r) => r.map((x) => x.postingNumber)));
  setShareText(res, [`ЧЗ на тубу 30×20 · ${KIND[b.kind] ?? 'группа'} №${b.no}`, `Этикеток: ${codeIds.length}`, noCodes > 0 && `Ещё ${noCodes} туб из начальных остатков — без этикетки`]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName(['OZON_FBS', itemsToken(items).replace(/_\d+QT$/, ''), `${codeIds.length}QT`, groupTag(b), 'CZ30x20']))}`);
  res.end(await calibrate(await tubeLabelsPdf(codeIds)));
}));
router.get('/ozon-fbs/batches/:id/labels.pdf', h(async (req, res) => {
  const b = await group(req.params.id);
  if (!b.labelS3Key) throw new StockError('Этикетки группы ещё не сформированы');
  const nums = (await prisma.ozonFbsPosting.findMany({ where: { batchId: b.id, status: { not: 'cancelled' } }, select: { postingNumber: true } })).map((p) => p.postingNumber);
  const items = await postingItems(nums);
  setShareText(res, [
    `Этикетки Ozon FBS 58×40 · ${KIND[b.kind] ?? 'группа'} №${b.no} · ${ddmm(b.day)}`,
    ...qtyLines(items),
    `Этикеток: ${nums.length} (по одной на отправление)`,
    b.carriageId && `Поставка ${b.carriageId}`,
  ]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName(['OZON_FBS', b.carriageId ?? dayTag(b.day), itemsToken(items), groupTag(b)]))}`);
  res.end(await calibrate(await downloadFile(b.labelS3Key)));
}));

export default router;
