import { Router, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { StockError } from '../services/stock';
import { getSetting, setSetting } from '../services/ozon';
import { wb, wbConfigured, wbSupplies } from '../services/wb';
import {
  addOrders, applyPickList, assignCodes, resendRejected, refreshMeta, supplyKi, uploadStickers, pdfToText, createSupply, deliver, detachCode, newOrders, resetMetaErrors, scanCode, sendMeta,
  supplyState, syncSupply, writeOff,
} from '../services/wbSupply';
import { comboPdf, czXlsx, kiXlsx, supplyQrPdf, trbxPdf, wbStickersPdf } from '../services/wbPdf';

// Отправки WB FBS: мастер сборки поставки
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

const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

function sendFile(res: Response, buf: Buffer, name: string, type = 'application/pdf') {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
}

const SHIPPING_KEY = 'wb.shipping';

router.get('/wb/status', h(async (_req, res) => { res.json({ configured: wbConfigured() }); }));

// GET /api/stock/wb/supplies — открытые поставки и последние закрытые
router.get('/wb/supplies', h(async (_req, res) => {
  const list = await wbSupplies();
  for (const s of list) {
    const data = {
      name: s.name, createdAt: new Date(s.createdAt), done: s.done, closedAt: s.closedAt ? new Date(s.closedAt) : null,
      cargoType: s.cargoType, shippingType: s.shippingType, shippingPointId: s.shippingPointId, shippingDt: s.shippingDt,
    };
    await prisma.wbSupply.upsert({ where: { id: s.id }, create: { id: s.id, ...data }, update: data });
  }
  const supplies = await prisma.wbSupply.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  const counts = await prisma.wbOrder.groupBy({ by: ['supplyId'], where: { supplyId: { in: supplies.map((s) => s.id) }, canceled: false }, _count: true });
  const cnt = new Map(counts.map((c) => [c.supplyId, c._count]));
  const open = supplies.filter((s) => !s.done);
  const closed = supplies.filter((s) => s.done).slice(0, 20);
  res.json([...open, ...closed].map((s) => ({ ...s, orders: cnt.get(s.id) ?? null })));
}));

router.post('/wb/supplies', h(async (req, res) => {
  const name = z.string().trim().min(1).max(128).parse(req.body?.name);
  res.status(201).json({ id: await createSupply(name) });
}));

router.get('/wb/new-orders', h(async (_req, res) => { res.json(await newOrders()); }));

// POST /api/stock/wb/map-article { article, itemId } — артикул WB → SKU портала
router.post('/wb/map-article', h(async (req, res) => {
  const { article, itemId } = z.object({ article: z.string().min(1).max(100), itemId: z.string().uuid() }).parse(req.body);
  const item = await prisma.item.findUnique({ where: { id: itemId } });
  if (item?.type !== 'PRODUCT') throw new StockError('Выберите готовую продукцию');
  await prisma.$transaction(async (tx) => {
    await tx.productSpec.updateMany({ where: { wbArticle: article }, data: { wbArticle: null } });
    await tx.productSpec.upsert({ where: { itemId }, create: { itemId, wbArticle: article }, update: { wbArticle: article } });
    await tx.wbOrder.updateMany({ where: { article }, data: { itemId } });
  });
  res.json({ ok: true });
}));

router.get('/wb/supplies/:id', h(async (req, res) => {
  if (req.query.sync === '1' || !(await prisma.wbSupply.findUnique({ where: { id: req.params.id } }))) await syncSupply(req.params.id);
  res.json(await supplyState(req.params.id));
}));

router.post('/wb/supplies/:id/orders', h(async (req, res) => {
  const ids = z.array(z.string().regex(/^\d+$/)).min(1).max(2000).parse(req.body?.ids);
  await addOrders(req.params.id, ids);
  res.json(await supplyState(req.params.id));
}));

// POST /api/stock/wb/supplies/:id/picklist — PDF «Лист подбора» из кабинета WB: номера стикеров заданий
router.post('/wb/supplies/:id/picklist', uploadPdf.single('file'), h(async (req, res) => {
  if (!req.file) throw new StockError('Нужен PDF листа подбора');
  const n = await applyPickList(req.params.id, await pdfToText(req.file.buffer));
  if (!n) throw new StockError('В файле не найдено ни одного задания этой поставки');
  res.json({ matched: n });
}));

// POST /api/stock/wb/supplies/:id/stickers — PDF стикеров заданий из кабинета WB
router.post('/wb/supplies/:id/stickers', uploadPdf.single('file'), h(async (req, res) => {
  if (!req.file) throw new StockError('Нужен PDF стикеров заданий');
  res.json(await uploadStickers(req.params.id, req.file.buffer));
}));

router.post('/wb/supplies/:id/assign', h(async (req, res) => {
  const mode = z.enum(['fresh', 'loose']).parse(req.body?.mode);
  res.json(await assignCodes(req.params.id, mode, req.user!.id));
}));

router.post('/wb/supplies/:id/scan', h(async (req, res) => {
  const { code, orderId } = z.object({ code: z.string().min(10).max(300), orderId: z.string().optional() }).parse(req.body);
  res.json(await scanCode(req.params.id, code, orderId));
}));

router.post('/wb/supplies/:id/orders/:orderId/detach', h(async (req, res) => {
  await detachCode(req.params.id, req.params.orderId);
  res.json({ ok: true });
}));

// POST /api/stock/wb/supplies/:id/refresh-meta — свежий статус проверки КИЗ из WB
router.post('/wb/supplies/:id/refresh-meta', h(async (req, res) => {
  await refreshMeta(req.params.id);
  res.json(await supplyState(req.params.id));
}));

router.post('/wb/supplies/:id/send-meta', h(async (req, res) => { res.json(await sendMeta(req.params.id)); }));
router.post('/wb/supplies/:id/resend-rejected', h(async (req, res) => { res.json(await resendRejected(req.params.id)); }));

// GET /api/stock/wb/supplies/:id/ki.xlsx — коды поставки для ввода в оборот в Честном знаке
router.get('/wb/supplies/:id/ki.xlsx', h(async (req, res) => {
  sendFile(res, await kiXlsx(await supplyKi(req.params.id)), `КИ ${req.params.id}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}));

router.post('/wb/supplies/:id/reset-errors', h(async (req, res) => { await resetMetaErrors(req.params.id); res.json({ ok: true }); }));

// ───────────── Грузоместа ─────────────

router.get('/wb/supplies/:id/trbx', h(async (req, res) => {
  const r = await wb<{ trbxes: { id: string }[] }>('GET', `/api/v3/supplies/${encodeURIComponent(req.params.id)}/trbx`, undefined, req.params.id, false);
  res.json(r.trbxes ?? []);
}));

router.post('/wb/supplies/:id/trbx', h(async (req, res) => {
  const amount = z.number().int().min(1).max(100).parse(req.body?.amount);
  res.json(await wb('POST', `/api/v3/supplies/${encodeURIComponent(req.params.id)}/trbx`, { amount }, req.params.id));
}));

router.delete('/wb/supplies/:id/trbx', h(async (req, res) => {
  const trbxIds = z.array(z.string()).min(1).parse(req.body?.ids);
  await wb('DELETE', `/api/v3/supplies/${encodeURIComponent(req.params.id)}/trbx`, { trbxIds }, req.params.id);
  res.json({ ok: true });
}));

// ───────────── Отгрузка ─────────────

router.get('/wb/shipping-points', h(async (req, res) => {
  const city = z.string().trim().min(2).parse(req.query.city);
  const cargoType = Number(req.query.cargoType ?? 1) || 1;
  const r = await wb<{ shippingPoints: any[] }>('GET', `/api/marketplace/v3/fbs/shipping-points?city=${encodeURIComponent(city)}&cargoType=${cargoType}`, undefined, undefined, false);
  res.json(r.shippingPoints ?? []);
}));

router.get('/wb/shipping-defaults', h(async (_req, res) => { res.json(await getSetting(SHIPPING_KEY, null)); }));

router.patch('/wb/supplies/:id/shipping', h(async (req, res) => {
  const b = z.object({
    shippingType: z.enum(['selfShipping', 'transportCompany']),
    shippingPointId: z.number().int(),
    shippingDt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    pointName: z.string().max(300).optional(),
    city: z.string().max(100).optional(),
  }).parse(req.body);
  const todayMsk = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  if (b.shippingDt < todayMsk) throw new StockError(`Дата отгрузки ${b.shippingDt.split('-').reverse().join('.')} уже прошла — выберите сегодня или позже`);
  const r = await wb<{ results: { supplyId: string; success?: boolean; error?: { detail: string } }[] }>('PATCH', '/api/marketplace/v3/fbs/supplies/shipping-method',
    { data: [{ supplyId: req.params.id, shippingType: b.shippingType, shippingPointId: b.shippingPointId, shippingDt: b.shippingDt }] }, req.params.id);
  const err = r.results?.find((x) => !x.success)?.error;
  if (err?.detail === 'InvalidShippingDt') throw new StockError(`WB не принял дату отгрузки ${b.shippingDt.split('-').reverse().join('.')}: дата должна быть не раньше сегодняшней. Выберите другую дату.`);
  if (err) throw new StockError(`WB не принял способ отгрузки: ${err.detail}`);
  await prisma.wbSupply.update({ where: { id: req.params.id }, data: { shippingType: b.shippingType, shippingPointId: b.shippingPointId, shippingDt: b.shippingDt } });
  await setSetting(SHIPPING_KEY, { shippingType: b.shippingType, shippingPointId: b.shippingPointId, pointName: b.pointName ?? null, city: b.city ?? null });
  res.json({ ok: true });
}));

router.post('/wb/supplies/:id/deliver', h(async (req, res) => {
  await deliver(req.params.id);
  let stockError: string | null = null;
  if (req.body?.writeOff) {
    try { await writeOff(req.params.id, req.user!.id); } catch (e: any) { stockError = e.message; }
  }
  res.json({ ok: true, stockError });
}));

router.post('/wb/supplies/:id/write-off', h(async (req, res) => { res.json(await writeOff(req.params.id, req.user!.id)); }));

// ───────────── Печать и выгрузки ─────────────

router.get('/wb/supplies/:id/pdf/:kind', h(async (req, res) => {
  const id = req.params.id;
  const kind = req.params.kind;
  const make: Record<string, [() => Promise<Buffer>, string]> = {
    stickers: [() => wbStickersPdf(id), `Стикеры заданий ${id}.pdf`],
    combo: [() => comboPdf(id), `Стикеры ЧЗ ${id}.pdf`],
    pairs: [() => comboPdf(id, true), `Стикеры WB + ЧЗ ${id}.pdf`],
    trbx: [() => trbxPdf(id), `Грузоместа ${id}.pdf`],
    qr: [() => supplyQrPdf(id), `QR поставки ${id}.pdf`],
  };
  if (!make[kind]) throw new StockError('Неизвестный тип печати');
  sendFile(res, await make[kind][0](), make[kind][1]);
}));

// GET /api/stock/wb/cz.xlsx?supplies=WB-GI-1,WB-GI-2 — таблица использованных ЧЗ
router.get('/wb/cz.xlsx', h(async (req, res) => {
  const ids = String(req.query.supplies ?? '').split(',').filter(Boolean);
  const supplyIds = ids.length ? ids : (await prisma.wbSupply.findMany({ orderBy: { createdAt: 'desc' }, take: 50, select: { id: true } })).map((s) => s.id);
  sendFile(res, await czXlsx(supplyIds), ids.length === 1 ? `ЧЗ ${ids[0]}.xlsx` : 'ЧЗ WB FBS.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}));

export default router;
