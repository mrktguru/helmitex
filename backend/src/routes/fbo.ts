import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { StockError } from '../services/stock';
import {
  OZON_DEFAULTS_KEY, OZON_STATE_LABEL, OzonDefaults, defaultOzonSettings, getSetting, ozon, ozonConfigured, setSetting,
} from '../services/ozon';
import { book, cancelShipment, createOzonDraft, createShipment, getTimeslots, makeLabels, setCargoes, ship, syncShipment, syncSkus } from '../services/fbo';
import { downloadFile } from '../services/s3';

const router = Router();
router.use(authMiddleware);

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;
// Ошибки бизнес-логики и Ozon — 400 с текстом, остальное — в общий обработчик
const h = (fn: Handler) => async (req: AuthRequest, res: Response, next: (e: unknown) => void) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof StockError) res.status(400).json({ error: e.message });
    else next(e);
  }
};

const shipmentInclude = {
  user: { select: { email: true } },
  cargoes: {
    orderBy: { sort: 'asc' as const },
    include: { quant: { include: { lot: { select: { number: true, expiresAt: true } }, quantType: { include: { productItem: { include: { spec: true } } } } } } },
  },
};

async function full(id: string) {
  const s = await prisma.fboShipment.findUnique({ where: { id }, include: shipmentInclude });
  if (!s) throw new StockError('Поставка не найдена');
  return { ...s, ozonStateLabel: s.ozonState ? OZON_STATE_LABEL[s.ozonState] ?? s.ozonState : null };
}

// ───────────── Настройки и справочники Ozon ─────────────

router.get('/ozon/settings', h(async (_req, res) => {
  res.json({ configured: ozonConfigured(), defaults: await getSetting<OzonDefaults>(OZON_DEFAULTS_KEY, defaultOzonSettings) });
}));

const settingsSchema = z.object({
  supplyType: z.enum(['CROSSDOCK', 'DIRECT']),
  clusterId: z.string().nullable(),
  clusterName: z.string().nullable(),
  dropOffWarehouseId: z.string().nullable(),
  dropOffName: z.string().nullable(),
  dropOffType: z.string().nullable(),
});
router.put('/ozon/settings', h(async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  await setSetting(OZON_DEFAULTS_KEY, parsed.data);
  res.json({ ok: true });
}));

router.get('/ozon/clusters', h(async (_req, res) => {
  const r = await ozon('/v2/cluster/list', {});
  res.json((r.result ?? []).map((c: any) => ({
    id: String(c.macrolocal_cluster_id), name: c.data?.macrolocal_cluster?.name, country: c.data?.macrolocal_cluster?.country?.name,
  })));
}));

router.get('/ozon/dropoff', h(async (req, res) => {
  const search = String(req.query.search ?? '').trim();
  if (search.length < 4) { res.json([]); return; }
  const r = await ozon('/v1/warehouse/fbo/list', { filter_by_supply_type: ['CREATE_TYPE_CROSSDOCK'], search });
  res.json((r.search ?? []).map((w: any) => ({
    id: String(w.warehouse_id), name: w.name, address: w.address, type: String(w.warehouse_type ?? '').replace(/^WAREHOUSE_TYPE_/, ''),
  })));
}));

// Пункт отгрузки из последней кросс-докинг заявки — подсказка для настроек
router.get('/ozon/last-dropoff', h(async (_req, res) => {
  const list = await ozon('/v3/supply-order/list', {
    filter: { states: ['DATA_FILLING', 'READY_TO_SUPPLY', 'ACCEPTED_AT_SUPPLY_WAREHOUSE', 'IN_TRANSIT', 'ACCEPTANCE_AT_STORAGE_WAREHOUSE', 'REPORTS_CONFIRMATION_AWAITING', 'COMPLETED'] },
    limit: 20, sort_by: 'ORDER_CREATION', sort_dir: 'DESC',
  });
  const ids = (list.order_ids ?? []).slice(0, 20);
  if (!ids.length) { res.json(null); return; }
  const r = await ozon('/v3/supply-order/get', { order_ids: ids });
  const o = (r.orders ?? []).find((x: any) => x.supplies?.[0]?.is_crossdock && x.drop_off_warehouse);
  if (!o) { res.json(null); return; }
  const found = await ozon('/v1/warehouse/fbo/list', { filter_by_supply_type: ['CREATE_TYPE_CROSSDOCK'], search: o.drop_off_warehouse.name });
  const w = (found.search ?? []).find((x: any) => String(x.warehouse_id) === String(o.drop_off_warehouse.warehouse_id));
  res.json({
    id: String(o.drop_off_warehouse.warehouse_id), name: o.drop_off_warehouse.name, address: o.drop_off_warehouse.address,
    type: String(w?.warehouse_type ?? 'DELIVERY_POINT').replace(/^WAREHOUSE_TYPE_/, ''),
    clusterId: o.supplies[0].macrolocal_cluster_id ? String(o.supplies[0].macrolocal_cluster_id) : null,
  });
}));

// Товары Ozon для выбора артикула в карточке SKU
router.get('/ozon/products', h(async (_req, res) => {
  const items: any[] = [];
  let last_id = '';
  for (let page = 0; page < 10; page++) {
    const r = await ozon('/v3/product/list', { filter: { visibility: 'ALL' }, limit: 1000, last_id });
    items.push(...(r.result?.items ?? []));
    last_id = r.result?.last_id ?? '';
    if (!last_id || (r.result?.items ?? []).length < 1000) break;
  }
  const names = new Map<string, string>();
  for (let i = 0; i < items.length; i += 1000) {
    const info = await ozon('/v3/product/info/list', { offer_id: items.slice(i, i + 1000).map((x) => x.offer_id) });
    for (const it of info.items ?? []) names.set(it.offer_id, it.name);
  }
  res.json(items.filter((x) => !x.archived).map((x) => ({ offerId: x.offer_id, name: names.get(x.offer_id) ?? x.offer_id })));
}));

router.put('/specs/:itemId/ozon', h(async (req, res) => {
  const offerId = req.body?.ozonOfferId ? String(req.body.ozonOfferId).trim() : null;
  const item = await prisma.item.findUnique({ where: { id: req.params.itemId } });
  if (item?.type !== 'PRODUCT') throw new StockError('Не SKU готовой продукции');
  await prisma.productSpec.upsert({
    where: { itemId: item.id },
    create: { itemId: item.id, ozonOfferId: offerId },
    update: { ozonOfferId: offerId, ozonSku: null, ozonName: null },
  });
  res.json(offerId ? await syncSkus() : { updated: 0, notFound: [] });
}));

// Создать SKU готовой продукции из товаров Ozon (артикул и SKU Ozon заполняются сразу)
router.post('/ozon/import-products', h(async (req, res) => {
  const parsed = z.object({ products: z.array(z.object({ offerId: z.string().min(1), name: z.string().min(1).max(200) })).min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const created: string[] = [];
  for (const p of parsed.data.products) {
    const exists = await prisma.productSpec.findFirst({ where: { ozonOfferId: p.offerId } });
    if (exists) continue;
    const item = await prisma.item.create({ data: { type: 'PRODUCT', name: p.name, unit: 'шт', spec: { create: { ozonOfferId: p.offerId } } } });
    created.push(item.id);
  }
  const sync = await syncSkus();
  res.json({ created: created.length, ids: created, notFound: sync.notFound });
}));

router.post('/ozon/sync-skus', h(async (_req, res) => { res.json(await syncSkus()); }));

// ───────────── Поставки FBO ─────────────

router.get('/fbo', h(async (req, res) => {
  const list = await prisma.fboShipment.findMany({
    where: req.query.active === '1' ? { status: { notIn: ['CANCELLED', 'COMPLETED'] } } : {},
    orderBy: { createdAt: 'desc' }, take: 200,
    include: { user: { select: { email: true } }, cargoes: { include: { quant: { select: { units: true } } } } },
  });
  res.json(list.map(({ cargoes, ...s }) => ({
    ...s, boxes: cargoes.length, units: cargoes.reduce((t, c) => t + c.quant.units, 0),
    ozonStateLabel: s.ozonState ? OZON_STATE_LABEL[s.ozonState] ?? s.ozonState : null,
  })));
}));

router.get('/fbo/:id', h(async (req, res) => { res.json(await full(req.params.id)); }));

router.post('/fbo', h(async (req, res) => {
  const parsed = z.object({
    picks: z.array(z.object({ quantTypeId: z.string().uuid(), count: z.number().int().min(0).max(30) })).min(1),
    comment: z.string().max(500).nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const s = await createShipment(req.user!.id, parsed.data.picks, parsed.data.comment);
  res.status(201).json(s);
}));

router.post('/fbo/:id/draft', h(async (req, res) => {
  const parsed = z.object({
    supplyType: z.enum(['CROSSDOCK', 'DIRECT']),
    clusterId: z.string().min(1),
    clusterName: z.string().nullable().optional(),
    dropOffWarehouseId: z.string().nullable().optional(),
    dropOffName: z.string().nullable().optional(),
    dropOffType: z.string().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  await createOzonDraft(req.params.id, parsed.data);
  res.json(await full(req.params.id));
}));

router.get('/fbo/:id/timeslots', h(async (req, res) => {
  res.json(await getTimeslots(req.params.id, req.query.storageWarehouseId ? String(req.query.storageWarehouseId) : null));
}));

router.post('/fbo/:id/book', h(async (req, res) => {
  const parsed = z.object({
    from: z.string().min(10), to: z.string().min(10),
    storageWarehouseId: z.string().nullable().optional(), storageName: z.string().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  await book(req.params.id, parsed.data);
  res.json(await full(req.params.id));
}));

router.post('/fbo/:id/cargoes', h(async (req, res) => { await setCargoes(req.params.id); res.json(await full(req.params.id)); }));
router.post('/fbo/:id/labels', h(async (req, res) => { await makeLabels(req.params.id); res.json(await full(req.params.id)); }));
router.post('/fbo/:id/ship', h(async (req, res) => { await ship(req.params.id, req.user!.id); res.json(await full(req.params.id)); }));
router.post('/fbo/:id/cancel', h(async (req, res) => { await cancelShipment(req.params.id); res.json(await full(req.params.id)); }));
router.post('/fbo/:id/sync', h(async (req, res) => { await syncShipment(req.params.id); res.json(await full(req.params.id)); }));

router.get('/fbo/:id/labels.pdf', h(async (req, res) => {
  const s = await prisma.fboShipment.findUnique({ where: { id: req.params.id } });
  if (!s?.labelS3Key) throw new StockError('Этикетки ещё не получены');
  const buf = await downloadFile(s.labelS3Key);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`Грузоместа ${s.number}.pdf`)}`);
  res.end(buf);
}));

router.get('/fbo/:id/log', h(async (req, res) => {
  res.json(await prisma.ozonApiLog.findMany({ where: { shipmentId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 100 }));
}));

export default router;
