import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { StockError } from '../services/stock';
import { ozonConfigured } from '../services/ozon';
import { perfConfigured } from '../services/perf';
import {
  createCampaign, getProducts, getReport, lastFullDay, setActionPrice, setBudget, setCampaignState, setCpcBid, setPrice, setSelected, setSelectedBid,
} from '../services/ads';

const router = Router();
router.use(authMiddleware);

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;
const h = (fn: Handler) => async (req: AuthRequest, res: Response, next: (e: unknown) => void) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof StockError) res.status(400).json({ error: e.message });
    else if (e instanceof z.ZodError) res.status(400).json({ error: e.flatten() });
    else next(e);
  }
};

async function actor(req: AuthRequest) {
  const u = req.user ? await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true } }) : null;
  return { email: u?.email ?? null };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// Период: по умолчанию последние 14 полных дней; не дальше вчерашнего дня и не длиннее 92 дней
function period(q: any): { from: string; to: string; refresh: boolean } {
  const max = lastFullDay();
  let to = typeof q.to === 'string' && ISO.test(q.to) ? q.to : max;
  if (to > max) to = max;
  let from = typeof q.from === 'string' && ISO.test(q.from) ? q.from : new Date(new Date(to + 'T00:00:00Z').getTime() - 13 * 86_400_000).toISOString().slice(0, 10);
  if (from > to) from = to;
  const days = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000 + 1;
  if (days > 92) throw new StockError('Период не может быть длиннее 92 дней');
  return { from, to, refresh: q.refresh === '1' };
}

router.get('/status', h(async (_req, res) => {
  res.json({ seller: ozonConfigured(), perf: perfConfigured(), lastDay: lastFullDay() });
}));

router.get('/products', h(async (req, res) => {
  const p = period(req.query);
  res.json({ ...p, products: await getProducts(p.from, p.to, p.refresh) });
}));

router.get('/report/:sku', h(async (req, res) => {
  const p = period(req.query);
  res.json(await getReport(req.params.sku, p.from, p.to, p.refresh));
}));

const id = z.string().regex(/^\d+$/);
const money = z.number().positive().max(10_000_000);

router.post('/campaigns/:id/state', h(async (req, res) => {
  const b = z.object({ on: z.boolean() }).parse(req.body);
  await setCampaignState(id.parse(req.params.id), b.on, await actor(req));
  res.json({ ok: true });
}));

router.put('/campaigns/:id/bid', h(async (req, res) => {
  const b = z.object({ sku: id, bid: money }).parse(req.body);
  await setCpcBid(id.parse(req.params.id), b.sku, b.bid, await actor(req));
  res.json({ ok: true });
}));

router.patch('/campaigns/:id/budget', h(async (req, res) => {
  const b = z.object({ weeklyBudget: money.nullable().optional(), dailyBudget: money.nullable().optional() }).parse(req.body);
  await setBudget(id.parse(req.params.id), b, await actor(req));
  res.json({ ok: true });
}));

router.post('/campaigns', h(async (req, res) => {
  const b = z.object({
    title: z.string().trim().min(1).max(120),
    placement: z.enum(['PLACEMENT_TOP_PROMOTION', 'PLACEMENT_SEARCH_AND_CATEGORY']),
    weeklyBudget: money.nullable().optional(),
    dailyBudget: money.nullable().optional(),
    skus: z.array(z.object({ sku: id, bid: money })).min(1).max(50),
    activate: z.boolean(),
  }).parse(req.body);
  res.json(await createCampaign(b, await actor(req)));
}));

router.post('/selected/:sku', h(async (req, res) => {
  const b = z.object({ on: z.boolean() }).parse(req.body);
  await setSelected(id.parse(req.params.sku), b.on, await actor(req));
  res.json({ ok: true });
}));

router.put('/selected/:sku/bid', h(async (req, res) => {
  const b = z.object({ bid: z.number().positive().max(99) }).parse(req.body);
  await setSelectedBid(id.parse(req.params.sku), b.bid, await actor(req));
  res.json({ ok: true });
}));

router.put('/price/:sku', h(async (req, res) => {
  const b = z.object({ price: money.nullable().optional(), oldPrice: money.nullable().optional(), minPrice: money.nullable().optional() }).parse(req.body);
  if (b.price == null && b.oldPrice == null && b.minPrice == null) throw new StockError('Укажите новую цену');
  if (b.price != null && b.oldPrice != null && b.oldPrice > 0 && b.oldPrice <= b.price) throw new StockError('Зачёркнутая цена должна быть выше цены');
  await setPrice(id.parse(req.params.sku), b, await actor(req));
  res.json({ ok: true });
}));

router.put('/action-price/:sku', h(async (req, res) => {
  const b = z.object({ actionId: z.number().int().positive(), actionPrice: money }).parse(req.body);
  await setActionPrice(id.parse(req.params.sku), b.actionId, b.actionPrice, await actor(req));
  res.json({ ok: true });
}));

const KINDS = ['PRICE', 'ACTION_PRICE', 'BID', 'BUDGET', 'CAMPAIGN_ON', 'CAMPAIGN_OFF', 'CAMPAIGN_NEW', 'CPO_ON', 'CPO_OFF', 'CPO_BID', 'PROMO', 'NOTE'] as const;

router.post('/journal', h(async (req, res) => {
  const b = z.object({
    sku: id.nullable(),
    at: z.string().datetime({ offset: true }),
    kind: z.enum(KINDS),
    text: z.string().trim().min(1).max(500),
  }).parse(req.body);
  const a = await actor(req);
  res.json(await prisma.adJournal.create({ data: { sku: b.sku, at: new Date(b.at), kind: b.kind, text: b.text, source: 'MANUAL', userEmail: a.email } }));
}));

router.delete('/journal/:id', h(async (req, res) => {
  const j = await prisma.adJournal.findUnique({ where: { id: req.params.id } });
  if (!j) throw new StockError('Запись не найдена');
  if (j.source !== 'MANUAL') throw new StockError('Автоматические записи не удаляются — это история действий');
  await prisma.adJournal.delete({ where: { id: j.id } });
  res.json({ ok: true });
}));

export default router;
