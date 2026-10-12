import { Prisma } from '@prisma/client';
import prisma from '../prisma/client';
import { PdfJob, StockError, allocateFefo, consume, nextDocNumber } from './stock';
import { looseCodes, markLot } from './marking';
import { uploadFile } from './s3';
import { PDFDocument } from 'pdf-lib';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { sleep } from './ozon';
import { WbOrderApi, WbSupplyApi, chunk, fmtRuDate, printOrder, wb, wbOrdersByIds } from './wb';

type Tx = Prisma.TransactionClient;

const CANCELED = new Set(['cancel', 'reject']);
const WB_CANCELED = new Set(['canceled', 'canceled_by_client', 'declined_by_client', 'defect', 'canceled_by_seller']);

interface MetaDetail { key: string; value: string | null; decision: string }
const metaHas = (meta: any, key: string) => Array.isArray(meta?.metaDetails) && meta.metaDetails.some((d: MetaDetail) => d.key === key);
const metaDecision = (meta: any, key: string): string | null =>
  (Array.isArray(meta?.metaDetails) && meta.metaDetails.find((d: MetaDetail) => d.key === key)?.decision) || null;
// Решения WB по КИЗ, при которых код не прошёл проверку в Честном знаке (sgtinIntroduced / sgtinSoldB2B — прошёл)
const KIZ_OK = new Set(['sgtinIntroduced', 'sgtinSoldB2B']);
export const KIZ_BAD = (d: string | null) => !!d && (d === 'required' || (d.startsWith('sgtin') && !KIZ_OK.has(d)));
const metaRequired = (meta: any, key: string) =>
  Array.isArray(meta?.metaDetails) && meta.metaDetails.some((d: MetaDetail) => d.key === key && d.decision === 'required');

// SKU портала по артикулу WB
async function itemsByArticle(articles: string[]) {
  const specs = await prisma.productSpec.findMany({ where: { wbArticle: { in: articles } }, include: { item: true } });
  return new Map(specs.map((s) => [s.wbArticle!, s]));
}

async function upsertSupply(s: WbSupplyApi) {
  const data = {
    name: s.name, createdAt: new Date(s.createdAt), done: s.done, closedAt: s.closedAt ? new Date(s.closedAt) : null,
    cargoType: s.cargoType, shippingType: s.shippingType, shippingPointId: s.shippingPointId, shippingDt: s.shippingDt, syncedAt: new Date(),
  };
  return prisma.wbSupply.upsert({ where: { id: s.id }, create: { id: s.id, ...data }, update: data });
}

async function upsertOrders(orders: WbOrderApi[], supplyId: string | null) {
  const map = await itemsByArticle([...new Set(orders.map((o) => o.article))]);
  for (const o of orders) {
    const data = {
      supplyId, article: o.article, nmId: o.nmId, barcode: o.skus?.[0] ?? null, price: o.price,
      wbCreatedAt: new Date(o.createdAt), cargoType: o.cargoType, itemId: map.get(o.article)?.itemId ?? null,
    };
    await prisma.wbOrder.upsert({ where: { id: String(o.id) }, create: { id: String(o.id), ...data }, update: data });
  }
}

/** Новые задания WB (ещё не в поставке) с привязкой к SKU портала. */
export async function newOrders() {
  const r = await wb<{ orders: WbOrderApi[] }>('GET', '/api/v3/orders/new', undefined, undefined, false);
  const orders = r.orders ?? [];
  const map = await itemsByArticle([...new Set(orders.map((o) => o.article))]);
  return orders.map((o) => {
    const sp = map.get(o.article);
    return {
      id: String(o.id), article: o.article, nmId: o.nmId, barcode: o.skus?.[0] ?? null, price: o.price, createdAt: o.createdAt,
      cargoType: o.cargoType, item: sp ? { id: sp.itemId, name: sp.item.name, requiresCz: sp.requiresCz } : null,
    };
  });
}

/** Синхронизация поставки: состав, статусы, идентификаторы (ЧЗ, срок годности), стикеры. */
export async function syncSupply(id: string) {
  const s = await wb<WbSupplyApi>('GET', `/api/v3/supplies/${encodeURIComponent(id)}`, undefined, id, false);
  await upsertSupply(s);
  const { orderIds } = await wb<{ orderIds: number[] }>('GET', `/api/marketplace/v3/supplies/${encodeURIComponent(id)}/order-ids`, undefined, id, false);
  const ids = orderIds ?? [];
  const known = await prisma.wbOrder.findMany({ where: { id: { in: ids.map(String) } }, select: { id: true } });
  const knownIds = new Set(known.map((k) => k.id));
  const missing = ids.filter((x) => !knownIds.has(String(x)));
  if (missing.length) {
    const since = new Date(new Date(s.createdAt).getTime() - 30 * 86400_000);
    await upsertOrders(await wbOrdersByIds(missing, since), id);
  }
  await prisma.wbOrder.updateMany({ where: { id: { in: ids.map(String) } }, data: { supplyId: id } });
  // Задания, убранные из поставки в кабинете WB
  await prisma.wbOrder.updateMany({ where: { supplyId: id, id: { notIn: ids.map(String) } }, data: { supplyId: null } });
  // Перепривязка SKU — артикулы могли сопоставить после загрузки
  const orders = await prisma.wbOrder.findMany({ where: { supplyId: id } });
  const map = await itemsByArticle([...new Set(orders.map((o) => o.article))]);
  for (const o of orders) {
    const itemId = map.get(o.article)?.itemId ?? null;
    if (itemId !== o.itemId) await prisma.wbOrder.update({ where: { id: o.id }, data: { itemId } });
  }

  for (const part of chunk(ids, 1000)) {
    const r = await wb<{ orders: { id: number; supplierStatus: string; wbStatus: string }[] }>('POST', '/api/v3/orders/status', { orders: part }, id, false);
    for (const st of r.orders ?? []) {
      await prisma.wbOrder.update({
        where: { id: String(st.id) },
        data: { supplierStatus: st.supplierStatus, wbStatus: st.wbStatus, canceled: CANCELED.has(st.supplierStatus) || WB_CANCELED.has(st.wbStatus) },
      }).catch(() => {});
    }
  }
  for (const part of chunk(ids, 100)) {
    const r = await wb<{ orders: { id: number; meta: any; metaDetails: MetaDetail[] }[] }>('POST', '/api/marketplace/v3/orders/meta', { orders: part }, id, false);
    for (const m of r.orders ?? []) {
      await prisma.wbOrder.update({ where: { id: String(m.id) }, data: { meta: { meta: m.meta, metaDetails: m.metaDetails } as any } }).catch(() => {});
    }
  }
  await loadStickers(id);
}

/** Стикеры заданий 58×40 из API WB → S3. Если WB отказывает — запоминаем ошибку, номера можно взять из листа подбора. */
export async function loadStickers(supplyId: string) {
  const orders = await prisma.wbOrder.findMany({ where: { supplyId, canceled: false, stickerS3Key: null } });
  if (!orders.length) return;
  try {
    for (const part of chunk(orders.map((o) => Number(o.id)), 100)) {
      const r = await wb<{ stickers: { orderId: number; partA: string | number; partB: string | number; barcode: string; file: string }[] }>(
        'POST', '/api/v3/orders/stickers?type=png&width=58&height=40', { orders: part }, supplyId, false);
      for (const st of r.stickers ?? []) {
        const key = `wb/stickers/${st.orderId}.png`;
        await uploadFile(key, Buffer.from(st.file, 'base64'), 'image/png');
        await prisma.wbOrder.update({
          where: { id: String(st.orderId) },
          data: { stickerA: String(st.partA), stickerB: String(st.partB).padStart(4, '0'), stickerBarcode: st.barcode, stickerS3Key: key },
        });
      }
    }
    await prisma.wbSupply.update({ where: { id: supplyId }, data: { stickerError: null } });
  } catch (e: any) {
    await prisma.wbSupply.update({ where: { id: supplyId }, data: { stickerError: String(e?.message ?? e).slice(0, 500) } });
  }
}

/** Номера стикеров из «Листа подбора» WB (PDF из кабинета) — запасной путь, если API стикеров недоступен. */
export async function applyPickList(supplyId: string, text: string): Promise<number> {
  let n = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d{9,12})\s.*?\s(\d{5,9})\s(\d{4})\s*$/);
    if (!m) continue;
    const r = await prisma.wbOrder.updateMany({ where: { id: m[1], supplyId }, data: { stickerA: m[2], stickerB: m[3] } });
    n += r.count;
  }
  return n;
}

export function pdfToText(buf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('pdftotext', ['-layout', '-', '-']);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new StockError('Не удалось прочитать PDF'))));
    p.stdin.end(buf);
  });
}

/**
 * Стикеры заданий из кабинета WB (PDF, страница = стикер): номер стикера со страницы → задание поставки
 * (номера заданий известны из API или листа подбора). Каждая страница сохраняется отдельным PDF.
 */
export async function uploadStickers(supplyId: string, buf: Buffer) {
  const orders = await prisma.wbOrder.findMany({ where: { supplyId, canceled: false } });
  const byNo = new Map(orders.filter((o) => o.stickerA && o.stickerB).map((o) => [`${o.stickerA} ${o.stickerB}`, o]));
  if (!byNo.size) throw new StockError('Номера стикеров заданий неизвестны — сначала загрузите «Лист подбора» этой поставки');
  const pagesText = (await pdfToText(buf)).split('\f');
  const src = await PDFDocument.load(buf);
  // Файл хранится один раз; у задания — ссылка «файл#страница» (страницы одного файла делят шрифты)
  const srcKey = `wb/stickers-src/${supplyId}/${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}.pdf`;
  await uploadFile(srcKey, buf, 'application/pdf');
  const unmatched: string[] = [];
  const unreadable: number[] = [];
  const done = new Set<string>();
  for (let i = 0; i < src.getPageCount(); i++) {
    const tok = pagesText[i]?.match(/\d+/g) ?? [];
    const a = tok.findIndex((x) => x.length >= 5 && x.length <= 9);
    const b = a >= 0 ? tok.slice(a + 1).find((x) => x.length === 4) : undefined;
    if (a < 0 || !b) { unreadable.push(i + 1); continue; }
    const no = `${tok[a]} ${b}`;
    const o = byNo.get(no);
    if (!o) { unmatched.push(no); continue; }
    await prisma.wbOrder.update({ where: { id: o.id }, data: { stickerS3Key: `${srcKey}#${i}` } });
    done.add(o.id);
  }
  const missing = orders.filter((o) => !done.has(o.id) && !o.stickerS3Key).length;
  return { pages: src.getPageCount(), matched: done.size, unmatched, unreadable, missing };
}

export async function addOrders(supplyId: string, ids: string[]) {
  for (const part of chunk(ids.map(Number), 100)) {
    await wb('PATCH', `/api/marketplace/v3/supplies/${encodeURIComponent(supplyId)}/orders`, { orders: part }, supplyId);
  }
  await syncSupply(supplyId);
}

export async function createSupply(name: string): Promise<string> {
  const r = await wb<{ id: string }>('POST', '/api/v3/supplies', { name }, undefined);
  await syncSupply(r.id);
  return r.id;
}

// ───────────── Состояние поставки для мастера ─────────────

export async function supplyState(id: string) {
  const supply = await prisma.wbSupply.findUnique({ where: { id } });
  if (!supply) throw new StockError('Поставка не найдена — обновите список');
  const orders = await prisma.wbOrder.findMany({ where: { supplyId: id }, include: { czCode: { include: { outputBatch: true } } } });
  const items = await prisma.item.findMany({
    where: { id: { in: [...new Set(orders.map((o) => o.itemId).filter((x): x is string => !!x))] } },
    include: { spec: true },
  });
  const itemOf = new Map(items.map((i) => [i.id, i]));
  const lots = await prisma.lot.findMany({ where: { id: { in: orders.map((o) => o.lotId).filter((x): x is string => !!x) } } });
  const lotOf = new Map(lots.map((l) => [l.id, l]));
  const rows = printOrder(orders.map((o) => {
    const item = o.itemId ? itemOf.get(o.itemId) : undefined;
    const lot = o.lotId ? lotOf.get(o.lotId) : undefined;
    const needCz = !!item?.spec?.requiresCz || metaRequired(o.meta, 'sgtin');
    return {
      id: o.id, article: o.article, barcode: o.barcode, itemId: o.itemId, itemName: item?.name ?? null,
      stickerA: o.stickerA, stickerB: o.stickerB, hasSticker: !!o.stickerS3Key, canceled: o.canceled, wbStatus: o.wbStatus,
      // needCz — банку маркируем (код назначается); wbKiz — WB принимает КИЗ для этого задания (есть поле sgtin)
      needCz, wbKiz: needCz && metaHas(o.meta, 'sgtin'), kizDecision: metaDecision(o.meta, 'sgtin'),
      needExpiration: metaHas(o.meta, 'expiration'),
      wbExpiration: (o.meta as any)?.meta?.expiration?.value ?? null,
      lot: lot ? { id: lot.id, number: lot.number, expiresAt: lot.expiresAt } : null,
      kiz: o.czCode?.code ?? null, kizPending: !!o.czCodeId && !o.czCode?.code,
      labelBatch: o.czCode?.outputBatch ? { id: o.czCode.outputBatch.id, jobStatus: o.czCode.outputBatch.jobStatus } : null,
      kizSentAt: o.kizSentAt, kizError: o.kizError, expirationSent: o.expirationSent, expirationError: o.expirationError,
    };
  }));
  // Сводка по SKU: сколько заданий, остатки на складе, свободные коды
  const groups = await prisma.stockMove.groupBy({
    by: ['lotId', 'state'], where: { lot: { itemId: { in: items.map((i) => i.id) } }, state: { in: ['UNLABELED', 'LABELED'] } }, _sum: { qty: true },
  });
  const gLots = await prisma.lot.findMany({ where: { id: { in: groups.map((g) => g.lotId) } }, select: { id: true, itemId: true } });
  const itemOfLot = new Map(gLots.map((l) => [l.id, l.itemId]));
  const summary = new Map<string, { itemId: string | null; article: string; name: string | null; requiresCz: boolean; count: number; unlabeled: number; labeled: number; freeCodes: number }>();
  for (const o of rows.filter((r) => !r.canceled)) {
    const key = o.itemId ?? `a:${o.article}`;
    const it = o.itemId ? itemOf.get(o.itemId) : undefined;
    const sm = summary.get(key) ?? { itemId: o.itemId, article: o.article, name: o.itemName, requiresCz: o.needCz, count: 0, unlabeled: 0, labeled: 0, freeCodes: 0 };
    sm.count++;
    if (it && !summary.has(key)) {
      for (const g of groups) if (itemOfLot.get(g.lotId) === it.id) sm[g.state === 'LABELED' ? 'labeled' : 'unlabeled'] += g._sum.qty ?? 0;
      if (it.spec?.czProjectId) sm.freeCodes = await prisma.czCode.count({ where: { status: 'PENDING', czBatch: { projectId: it.spec.czProjectId } } });
    }
    summary.set(key, sm);
  }
  return { supply, orders: rows, items: [...summary.values()] };
}

// ───────────── Честный знак ─────────────

type Prep = Awaited<ReturnType<typeof supplyState>>['orders'][number];
const waitingCz = (o: Prep) => !o.canceled && o.needCz && !o.kiz && !o.kizPending;

/**
 * Назначить коды ЧЗ заданиям.
 *   fresh — новые коды из базы SKU: партия списывается FEFO из «без ЧЗ» документом «Маркировка», печатаются объединённые стикеры.
 *   loose — коды с уже промаркированных банок (россыпь «с ЧЗ»), ничего не печатается.
 * Заданиям без ЧЗ назначается партия FEFO (для срока годности и списания).
 */
export async function assignCodes(supplyId: string, mode: 'fresh' | 'loose', userId: string) {
  const { orders } = await supplyState(supplyId);
  const unmapped = orders.filter((o) => !o.canceled && !o.itemId);
  if (unmapped.length) throw new StockError(`Есть задания без SKU портала (артикул ${unmapped[0].article}) — сопоставьте артикулы на шаге «Задания»`);
  const jobs: PdfJob[] = [];
  const notes: string[] = [];

  await prisma.$transaction(async (tx) => {
    const byItem = new Map<string, Prep[]>();
    for (const o of orders.filter(waitingCz)) byItem.set(o.itemId!, [...(byItem.get(o.itemId!) ?? []), o]);
    for (const [itemId, list] of byItem) {
      const name = list[0].itemName;
      if (mode === 'fresh') {
        const { allocations, shortage } = await allocateFefo(tx, itemId, list.length, 'UNLABELED');
        if (shortage) notes.push(`«${name}»: на складе без ЧЗ не хватает ${shortage} шт. — проведите фасовку или возьмите коды с промаркированных банок`);
        let i = 0;
        for (const a of allocations) {
          const n = Math.floor(a.qty);
          if (n < 1) continue;
          const r = await markLot(tx, a.lotId!, n, userId, `Маркировка для WB ${supplyId}: ${n} шт.`);
          jobs.push(r.job);
          for (const codeId of r.job.codeIds) {
            await tx.wbOrder.update({ where: { id: list[i].id }, data: { czCodeId: codeId, lotId: a.lotId, kizSentAt: null, kizError: null } });
            i++;
          }
        }
      } else {
        const { allocations, shortage } = await allocateFefo(tx, itemId, list.length, 'LABELED');
        let i = 0;
        for (const a of allocations) {
          const codes = await looseCodes(tx, a.lotId!, Math.floor(a.qty));
          for (const codeId of codes) {
            await tx.wbOrder.update({ where: { id: list[i].id }, data: { czCodeId: codeId, lotId: a.lotId, kizSentAt: null, kizError: null } });
            i++;
          }
        }
        if (i < list.length) notes.push(`«${name}»: с промаркированных банок найдено ${i} кодов из ${list.length}${shortage ? `, на складе «с ЧЗ» не хватает ${shortage} шт.` : ''}`);
      }
    }
    await assignLots(tx, orders.filter((o) => !o.canceled && !o.needCz && !o.lot));
  }, { isolationLevel: 'Serializable', timeout: 60000 });

  const { pdfQueue } = await import('../workers/pdfQueue');
  for (const j of jobs) await pdfQueue.add('generate-pdf', j);
  return { notes, printed: jobs.reduce((s, j) => s + j.codeIds.length, 0) };
}

// Партия для заданий без ЧЗ: FEFO по «без ЧЗ» (резерв не создаётся, списание — при передаче в доставку)
async function assignLots(tx: Tx, orders: Prep[]) {
  const byItem = new Map<string, Prep[]>();
  for (const o of orders) if (o.itemId) byItem.set(o.itemId, [...(byItem.get(o.itemId) ?? []), o]);
  for (const [itemId, list] of byItem) {
    const { allocations } = await allocateFefo(tx, itemId, list.length, 'UNLABELED');
    let i = 0;
    for (const a of allocations) {
      for (let k = 0; k < Math.floor(a.qty) && i < list.length; k++, i++) {
        await tx.wbOrder.update({ where: { id: list[i].id }, data: { lotId: a.lotId } });
      }
    }
  }
}

const normCode = (s: string) => s.replace(/[\x1d␝]/g, '').replace(/\s+/g, '').trim();

/** Отсканированный с банки код → задание (указанное или первое того же SKU без кода). */
export async function scanCode(supplyId: string, raw: string, orderId?: string) {
  const code = normCode(raw);
  if (code.length < 16) throw new StockError('Это не код Честного знака');
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "CzCode" WHERE replace(code, chr(29), '') = ${code} OR replace(code, chr(29), '') LIKE ${code + '%'} LIMIT 2`;
  if (rows.length !== 1) throw new StockError(rows.length ? 'Код неоднозначен — отсканируйте полностью' : 'Код не найден в базе ЧЗ портала');
  const cz = await prisma.czCode.findUnique({
    where: { id: rows[0].id },
    include: { wbOrder: true, czBatch: true, outputBatch: { include: { quant: true } }, quantCodes: { where: { active: true }, include: { quant: true } } },
  });
  if (!cz) throw new StockError('Код не найден');
  if (cz.wbOrder) throw new StockError(`Код уже привязан к заданию ${cz.wbOrder.id}`);
  if (cz.quantCodes.length) throw new StockError(`Код в кванте ${cz.quantCodes[0].quant.number}`);
  if (cz.status === 'SPOILED') throw new StockError('Код списан в брак');
  const specs = await prisma.productSpec.findMany({ where: { czProjectId: cz.czBatch.projectId } });
  const { orders } = await supplyState(supplyId);
  const target = orderId
    ? orders.find((o) => o.id === orderId)
    : orders.find((o) => waitingCz(o) && specs.some((s) => s.itemId === o.itemId));
  if (!target) throw new StockError('Нет задания этого товара, которому нужен код');
  if (!specs.some((s) => s.itemId === target.itemId)) throw new StockError(`Код от другого товара, а задание — «${target.itemName}»`);
  const lotId = cz.outputBatch?.lotId ?? cz.outputBatch?.quant?.lotId ?? null;
  await prisma.$transaction(async (tx) => {
    if (cz.status === 'PENDING') await tx.czCode.update({ where: { id: cz.id }, data: { status: 'USED', usedAt: new Date() } });
    await tx.wbOrder.update({ where: { id: target.id }, data: { czCodeId: cz.id, lotId: lotId ?? target.lot?.id ?? null, kizSentAt: null, kizError: null } });
  });
  return { orderId: target.id };
}

/** Отвязать код от задания (код остаётся на банке, «с ЧЗ»). Если уже отправлен в WB — удаляется и там. */
export async function detachCode(supplyId: string, orderId: string) {
  const o = await prisma.wbOrder.findUnique({ where: { id: orderId } });
  if (!o || o.supplyId !== supplyId) throw new StockError('Задание не найдено');
  if (o.kizSentAt) await wb('DELETE', `/api/v3/orders/${orderId}/meta?key=sgtin`, undefined, supplyId);
  await prisma.wbOrder.update({ where: { id: orderId }, data: { czCodeId: null, kizSentAt: null, kizError: null } });
}

/** Отправка в WB: КИЗ и срок годности. Порциями — фронтенд повторяет, пока remaining > 0. */
export async function sendMeta(supplyId: string, limit = 25) {
  const orders = await prisma.wbOrder.findMany({
    where: { supplyId, canceled: false },
    include: { czCode: true },
  });
  const lots = await prisma.lot.findMany({ where: { id: { in: orders.map((o) => o.lotId).filter((x): x is string => !!x) } } });
  const expOf = new Map(lots.map((l) => [l.id, l.expiresAt ? fmtRuDate(l.expiresAt) : null]));
  const todo = orders.filter((o) => {
    const exp = o.lotId ? expOf.get(o.lotId) : null;
    const kiz = metaHas(o.meta, 'sgtin') && o.czCodeId && o.czCode?.code && !o.kizSentAt && !o.kizError;
    const expiration = metaHas(o.meta, 'expiration') && exp && o.expirationSent !== exp && !o.expirationError;
    return kiz || expiration;
  });
  let sent = 0;
  const errors: string[] = [];
  for (const o of todo.slice(0, limit)) {
    const exp = o.lotId ? expOf.get(o.lotId) : null;
    if (metaHas(o.meta, 'sgtin') && o.czCodeId && o.czCode?.code && !o.kizSentAt && !o.kizError) {
      try {
        await wb('PUT', `/api/v3/orders/${o.id}/meta/sgtin`, { sgtins: [o.czCode.code] }, supplyId);
        await prisma.wbOrder.update({ where: { id: o.id }, data: { kizSentAt: new Date(), kizError: null } });
        sent++;
      } catch (e: any) {
        errors.push(`${o.id}: ${e.message}`);
        await prisma.wbOrder.update({ where: { id: o.id }, data: { kizError: String(e.message).slice(0, 300) } });
      }
      await sleep(220);
    }
    if (metaHas(o.meta, 'expiration') && exp && o.expirationSent !== exp && !o.expirationError) {
      try {
        await wb('PUT', `/api/v3/orders/${o.id}/meta/expiration`, { expiration: exp }, supplyId);
        await prisma.wbOrder.update({ where: { id: o.id }, data: { expirationSent: exp, expirationError: null } });
      } catch (e: any) {
        errors.push(`${o.id}: ${e.message}`);
        await prisma.wbOrder.update({ where: { id: o.id }, data: { expirationError: String(e.message).slice(0, 300) } });
      }
      await sleep(220);
    }
  }
  return { sent, errors, remaining: Math.max(0, todo.length - limit) };
}

/** Сбросить ошибки отправки, чтобы повторить. */
export async function resetMetaErrors(supplyId: string) {
  await prisma.wbOrder.updateMany({ where: { supplyId }, data: { kizError: null, expirationError: null } });
}

/** Повторная отправка КИЗ, которые WB отклонил при проверке (например, «эмитирован» — код ещё не введён в оборот). */
export async function resendRejected(supplyId: string) {
  await syncSupply(supplyId);
  const orders = await prisma.wbOrder.findMany({ where: { supplyId, canceled: false, kizSentAt: { not: null } } });
  const ids = orders.filter((o) => KIZ_BAD(metaDecision(o.meta, 'sgtin'))).map((o) => o.id);
  await prisma.wbOrder.updateMany({ where: { id: { in: ids } }, data: { kizSentAt: null, kizError: null } });
  return { reset: ids.length, ...(await sendMeta(supplyId)) };
}

/** Коды ЧЗ поставки списком (КИ без криптохвоста) — для ввода в оборот в личном кабинете Честного знака. */
export async function supplyKi(supplyId: string): Promise<string[]> {
  const orders = await prisma.wbOrder.findMany({ where: { supplyId, canceled: false, czCodeId: { not: null } }, include: { czCode: true } });
  return orders.map((o) => o.czCode?.code?.split('\x1d')[0]).filter((x): x is string => !!x);
}

// ───────────── Отгрузка ─────────────

export async function deliver(supplyId: string) {
  const { orders } = await supplyState(supplyId);
  const active = orders.filter((o) => !o.canceled);
  if (!active.length) throw new StockError('В поставке нет заданий');
  const noKiz = active.filter((o) => o.wbKiz && !o.kizSentAt);
  if (noKiz.length) throw new StockError(`ЧЗ не отправлен в WB у ${noKiz.length} заданий — завершите шаг «Честный знак»`);
  const bad = active.filter((o) => o.wbKiz && KIZ_BAD(o.kizDecision));
  if (bad.length) throw new StockError(`WB не принял КИЗ у ${bad.length} заданий (${bad[0].kizDecision}) — введите коды в оборот в Честном знаке и отправьте повторно`);
  await wb('PATCH', `/api/v3/supplies/${encodeURIComponent(supplyId)}/deliver`, undefined, supplyId);
  await syncSupply(supplyId);
}

/** Списание со склада отправленных заданий: с ЧЗ — из «с ЧЗ» своей партии, без ЧЗ — из «без ЧЗ». */
export async function writeOff(supplyId: string, userId: string) {
  const supply = await prisma.wbSupply.findUnique({ where: { id: supplyId } });
  if (supply?.stockDocId) throw new StockError('Поставка уже списана со склада');
  const { orders } = await supplyState(supplyId);
  const active = orders.filter((o) => !o.canceled);
  if (active.some((o) => !o.itemId)) throw new StockError('Есть задания без SKU портала — сопоставьте артикулы');
  return prisma.$transaction(async (tx) => {
    const doc = await tx.stockDoc.create({
      data: {
        type: 'SHIPMENT', status: 'POSTED', postedAt: new Date(), number: await nextDocNumber(tx, 'SHIPMENT'),
        userId, comment: `WB FBS ${supplyId}`,
      },
    });
    // группируем по (партия, состояние); без партии — FEFO
    const need = new Map<string, { itemId: string; name: string; lotId: string | null; state: 'LABELED' | 'UNLABELED'; qty: number }>();
    for (const o of active) {
      const state = o.kiz || o.needCz ? 'LABELED' : 'UNLABELED';
      const key = `${o.lot?.id ?? o.itemId}|${state}`;
      const n = need.get(key) ?? { itemId: o.itemId!, name: o.itemName!, lotId: o.lot?.id ?? null, state, qty: 0 };
      n.qty++;
      need.set(key, n);
    }
    let sort = 0;
    for (const n of need.values()) {
      const parts = n.lotId ? [{ lotId: n.lotId, qty: n.qty }] : await (async () => {
        const { allocations, shortage } = await allocateFefo(tx, n.itemId, n.qty, n.state);
        if (shortage) throw new StockError(`«${n.name}»: на складе ${n.state === 'LABELED' ? '«с ЧЗ»' : '«без ЧЗ»'} не хватает ${shortage} шт.`);
        return allocations.map((a) => ({ lotId: a.lotId!, qty: a.qty }));
      })();
      for (const p of parts) {
        await consume(tx, doc.id, p.lotId, n.state, p.qty, n.name);
        await tx.stockDocLine.create({ data: { docId: doc.id, itemId: n.itemId, lotId: p.lotId, qty: -p.qty, state: n.state, sort: sort++ } });
      }
    }
    await tx.wbSupply.update({ where: { id: supplyId }, data: { stockDocId: doc.id } });
    return doc;
  }, { isolationLevel: 'Serializable', timeout: 60000 });
}
