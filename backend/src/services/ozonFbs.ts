import { PDFDocument } from 'pdf-lib';
import prisma from '../prisma/client';
import { ozon, ozonCall, ozonPdf, ozonGetFile } from './ozon';
import { allocateFefo, consume, nextDocNumber, StockError } from './stock';
import { uploadFile } from './s3';
import { looseCodes, lotLabelVars } from './marking';
import { syncStatus, track } from './syncStatus';

// Отправки Ozon FBS: зеркало отправлений, сборка группами (кванты, пакеты) со списанием товара и упаковки, этикетки 58×40, поставки.

export interface FbsProduct { offerId: string; sku: string; name: string; qty: number; price: number }

const MSK = 3 * 3600_000;
const mskDay = (iso: string) => new Date(Date.parse(iso) + MSK).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────── Синхронизация ─────────────

const ACTIVE = ['awaiting_packaging', 'awaiting_deliver'];
let lastFull = 0;

/** Синхронизация с Ozon — одна за раз (повторный вызов ждёт идущую), статус виден на странице.
 *  Обычно — только активные отправления (ждут сборки/отгрузки): втрое меньше запросов; полный список за 14 дней — раз в час. */
export function syncFbs(userId?: string, full = false): Promise<number> {
  return track('fbs', () => pullFbs(userId, full || Date.now() - lastFull > 60 * 60_000));
}

async function pullFbs(userId: string | undefined, full: boolean): Promise<number> {
  const since = new Date(Date.now() - 14 * 86400_000);
  const seen = new Set<string>();
  let n = await pullList(since, full ? {} : { statuses: ACTIVE }, seen);
  if (full) lastFull = Date.now();
  else {
    // пропавшие из активных — отменены или переданы в Ozon: немного — уточняем по одному, много — полный список
    const gone = await prisma.ozonFbsPosting.findMany({
      where: { status: { in: ACTIVE }, inProcessAt: { gte: since }, postingNumber: { notIn: [...seen] } }, select: { postingNumber: true },
    });
    if (gone.length > 60) { n += await pullList(since, {}, seen); lastFull = Date.now(); }
    for (const g of gone.length <= 60 ? gone : []) {
      const r: any = await ozonCall('POST', '/v3/posting/fbs/get', { posting_number: g.postingNumber }, undefined, false).catch(() => null);
      const p = r?.result;
      if (!p?.status) continue;
      await prisma.ozonFbsPosting.update({
        where: { postingNumber: g.postingNumber },
        data: { status: p.status, substatus: p.substatus ?? null, deliveringAt: p.delivering_date ? new Date(p.delivering_date) : null },
      });
      n++;
    }
  }
  await writeOffPassed(userId);
  await markShipped();
  // где отправления — видно по их подстатусам; статусы самих поставок обновляем раз в час, с полным списком
  if (full) await refreshCarriages().catch((e) => console.warn('[ozon fbs carriages]', e));
  return n;
}

/** Страницы списка отправлений (v4: до 100 за запрос, по cursor); пишет только новые и изменившиеся */
async function pullList(sinceDate: Date, extra: object, seen: Set<string>): Promise<number> {
  const since = sinceDate.toISOString();
  const to = new Date(Date.now() + 86400_000).toISOString();
  let cursor: string | null = null, n = 0;
  for (let page = 0; page < 500; page++) {
    // v3 Ozon отключил («obsolete method»); v4 — до 100 за запрос, страницы по cursor, ответ без обёртки result.
    // Объёмный ответ — в журнал API только ошибки
    const r: any = await ozonCall('POST', '/v4/posting/fbs/list', {
      dir: 'ASC', filter: { since, to, ...extra }, limit: 100, ...(cursor ? { cursor } : {}), with: { analytics_data: false, financial_data: false },
    }, undefined, false);
    const postings: any[] = r.postings ?? r.result?.postings ?? [];
    // пишем только новые и изменившиеся — из тысяч отправлений за раз меняются десятки
    const known = new Map((await prisma.ozonFbsPosting.findMany({
      where: { postingNumber: { in: postings.map((p) => p.posting_number) } },
      select: { postingNumber: true, status: true, substatus: true, shipmentDate: true, deliveringAt: true, deliveryMethodId: true, products: true },
    })).map((k) => [k.postingNumber, k]));
    for (const p of postings) {
      seen.add(p.posting_number);
      const products: FbsProduct[] = (p.products ?? []).map((x: any) => ({
        offerId: x.offer_id, sku: String(x.sku), name: x.name, qty: x.quantity, price: Math.round(Number(x.price) * 100) / 100,
      }));
      const data = {
        orderNumber: p.order_number ?? null,
        status: p.status, substatus: p.substatus ?? null,
        shipDay: mskDay(p.shipment_date), shipmentDate: new Date(p.shipment_date),
        inProcessAt: p.in_process_at ? new Date(p.in_process_at) : null,
        deliveringAt: p.delivering_date ? new Date(p.delivering_date) : null,
        deliveryMethodId: p.delivery_method?.id ? String(p.delivery_method.id) : null,
        products: products as any,
      };
      const k = known.get(p.posting_number);
      const same = k && k.status === data.status && k.substatus === data.substatus && k.deliveryMethodId === data.deliveryMethodId
        && k.shipmentDate.getTime() === data.shipmentDate.getTime() && (k.deliveringAt?.getTime() ?? null) === (data.deliveringAt?.getTime() ?? null)
        && JSON.stringify((k.products as unknown as FbsProduct[]).map((x) => [x.offerId, x.qty])) === JSON.stringify(products.map((x) => [x.offerId, x.qty]));
      if (same) continue;
      await prisma.ozonFbsPosting.upsert({ where: { postingNumber: p.posting_number }, create: { postingNumber: p.posting_number, ...data }, update: data });
      n++;
    }
    cursor = (r.has_next ?? r.result?.has_next) ? (r.cursor ?? null) : null;
    if (!cursor || postings.length === 0) break;
  }
  return n;
}

// Статусы, при которых Ozon уже принял груз
export const PASSED = ['delivering', 'driver_pickup', 'delivered', 'not_accepted'];
// Отгрузки раньше этого дня ушли до ввода остатков на портале — их не списываем
const WRITE_OFF_SINCE = '2026-10-13';

/** Переданное в Ozon списывается со склада автоматически — по дню отгрузки, одним документом на день. */
async function writeOffPassed(userId?: string) {
  const uid = userId ?? (await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' } }))?.id;
  if (!uid) return;
  const rows = await prisma.ozonFbsPosting.findMany({ where: { stockDocId: null, status: { in: PASSED }, shipDay: { gte: WRITE_OFF_SINCE } }, select: { postingNumber: true, shipDay: true } });
  const byDay = new Map<string, string[]>();
  for (const r of rows) byDay.set(r.shipDay, [...(byDay.get(r.shipDay) ?? []), r.postingNumber]);
  for (const [day, nums] of byDay) {
    try {
      await writeOff(nums, uid);
      await prisma.ozonFbsDay.updateMany({ where: { day, lastError: { startsWith: 'Списание' } }, data: { lastError: null } });
    } catch (e) {
      await prisma.ozonFbsDay.upsert({ where: { day }, create: { day, lastError: `Списание: ${(e as Error).message}` }, update: { lastError: `Списание: ${(e as Error).message}` } });
    }
  }
}

/** Группа отправлена, когда все её отправления переданы в Ozon или отменены */
async function markShipped() {
  const open = await prisma.ozonFbsBatch.findMany({ where: { shippedAt: null }, select: { id: true } });
  for (const b of open) {
    const g = await prisma.ozonFbsPosting.groupBy({ by: ['status'], where: { batchId: b.id }, _count: true });
    if (!g.length) continue;
    const pending = g.filter((x) => !PASSED.includes(x.status) && x.status !== 'cancelled').reduce((t, x) => t + x._count, 0);
    if (pending === 0) await prisma.ozonFbsBatch.update({ where: { id: b.id }, data: { shippedAt: new Date() } });
  }
}

// ───────────── Состояние ─────────────

async function itemsByOffer(offers: string[]) {
  const specs = await prisma.productSpec.findMany({ where: { ozonOfferId: { in: offers } }, include: { item: true } });
  return new Map(specs.map((s) => [s.ozonOfferId!, { id: s.itemId, name: s.item.name, requiresCz: s.requiresCz }]));
}

async function stockOf(itemIds: string[], states: ('LABELED' | 'UNLABELED' | 'NONE')[] = ['LABELED', 'UNLABELED']) {
  const g = await prisma.stockMove.groupBy({ by: ['lotId', 'state'], where: { lot: { itemId: { in: itemIds } }, state: { in: states } }, _sum: { qty: true } });
  const lots = await prisma.lot.findMany({ where: { id: { in: g.map((x) => x.lotId) } }, select: { id: true, itemId: true } });
  const itemOf = new Map(lots.map((l) => [l.id, l.itemId]));
  const out = new Map<string, { labeled: number; unlabeled: number; none: number }>();
  for (const x of g) {
    const qty = x._sum.qty ?? 0;
    if (qty <= 1e-9) continue;
    const id = itemOf.get(x.lotId)!;
    const s = out.get(id) ?? { labeled: 0, unlabeled: 0, none: 0 };
    if (x.state === 'LABELED') s.labeled += qty; else if (x.state === 'UNLABELED') s.unlabeled += qty; else s.none += qty;
    out.set(id, s);
  }
  return out;
}

export const todayMsk = () => mskDay(new Date().toISOString());
// Пакет упаковочный — индивидуальная упаковка; если SKU заведён в «Упаковке», списывается по одному на отправление
const bagItem = () => prisma.item.findFirst({ where: { type: 'PACKAGING', name: { contains: 'Пакет', mode: 'insensitive' } } });

/** Всё для страницы: текущие заказы всех дней, группы, типы квантов, остатки товара и коробов. */
export async function fbsState() {
  const recent = new Date(Date.now() - 4 * 86400_000);
  const postings = await prisma.ozonFbsPosting.findMany({
    // + все отправления неотправленных групп, даже старые — чтобы счётчики группы сходились
    where: { OR: [{ status: { in: ['awaiting_packaging', 'awaiting_deliver'] } }, { shipmentDate: { gte: recent } }, { batch: { shippedAt: null } }] },
    orderBy: [{ shipmentDate: 'asc' }, { inProcessAt: 'asc' }, { postingNumber: 'asc' }],
  });
  const offers = [...new Set(postings.flatMap((p) => (p.products as unknown as FbsProduct[]).map((x) => x.offerId)))];
  const items = await itemsByOffer(offers);
  const quantTypes = await prisma.quantType.findMany({ where: { archived: false }, include: { boxItem: true, productItem: true }, orderBy: { name: 'asc' } });
  const bag = await bagItem();
  const boxIds = [...new Set([...quantTypes.map((q) => q.boxItemId).filter((x): x is string => !!x), ...(bag ? [bag.id] : [])])];
  const stock = await stockOf([...items.values()].map((i) => i.id));
  const packStock = await stockOf(boxIds, ['NONE']);
  const batchIds = [...new Set(postings.map((p) => p.batchId).filter((x): x is string => !!x))];
  const batches = await prisma.ozonFbsBatch.findMany({
    where: { OR: [{ id: { in: batchIds } }, { createdAt: { gte: recent } }, { shippedAt: null }] },
    include: { quantType: { include: { boxItem: true } } }, orderBy: [{ createdAt: 'desc' }],
  });
  // сколько кодов ЧЗ на тубы уже выдано по группе (тиражи привязаны к документам списания)
  const docOfBatch = new Map<string, Set<string>>();
  for (const p of postings) if (p.batchId && p.stockDocId) docOfBatch.set(p.batchId, (docOfBatch.get(p.batchId) ?? new Set()).add(p.stockDocId));
  const allDocs = [...new Set([...docOfBatch.values()].flatMap((x) => [...x]))];
  const czByDoc = new Map((await prisma.outputBatch.groupBy({ by: ['docId'], where: { docId: { in: allDocs } }, _sum: { count: true } }))
    .map((g) => [g.docId!, g._sum.count ?? 0]));
  for (const g of await prisma.shipmentCode.groupBy({ by: ['docId'], where: { docId: { in: allDocs } }, _count: true })) czByDoc.set(g.docId, (czByDoc.get(g.docId) ?? 0) + g._count);
  const notWritten = postings.filter((p) => !p.stockDocId && p.shipDay >= WRITE_OFF_SINCE && (p.status === 'awaiting_deliver' || PASSED.includes(p.status))).length;
  return {
    now: new Date().toISOString(),
    postings: postings.map((p) => ({
      postingNumber: p.postingNumber, status: p.status, substatus: p.substatus, shipDay: p.shipDay, shipmentDate: p.shipmentDate, inProcessAt: p.inProcessAt,
      batchId: p.batchId, stockDocId: p.stockDocId, shipError: p.shipError,
      // длинное название Ozon нужно только для непривязанных артикулов
      products: (p.products as unknown as FbsProduct[]).map(({ name, ...x }) => ({ ...x, name: items.has(x.offerId) ? undefined : name, item: items.get(x.offerId) ?? null })),
    })),
    unmapped: offers.filter((o) => !items.has(o)),
    items: [...items.values()].map((i) => ({ ...i, ...(stock.get(i.id) ?? { labeled: 0, unlabeled: 0, none: 0 }) })),
    quantTypes: quantTypes.map((q) => ({
      id: q.id, name: q.name, productItemId: q.productItemId, productName: q.productItem.name, units: q.unitsPerQuant,
      boxItemId: q.boxItemId, boxName: q.boxItem?.name ?? null, boxStock: q.boxItemId ? packStock.get(q.boxItemId)?.none ?? 0 : null,
    })),
    bag: bag ? { id: bag.id, name: bag.name, stock: packStock.get(bag.id)?.none ?? 0 } : null,
    batches: batches.map((b) => ({
      id: b.id, day: b.day, no: b.no, kind: b.kind, postings: b.postings, units: b.units, limit: b.limit,
      quantTypeName: b.quantType?.name ?? null, boxName: b.quantType?.boxItem?.name ?? null,
      czIssued: [...(docOfBatch.get(b.id) ?? [])].reduce((t, d) => t + (czByDoc.get(d) ?? 0), 0),
      labels: !!b.labelS3Key, labelAt: b.labelAt, carriageId: b.carriageId, carriageStatus: b.carriageStatus, createdAt: b.createdAt, shippedAt: b.shippedAt,
    })),
    notWritten,
    lastNo: (await prisma.ozonFbsBatch.findFirst({ orderBy: { no: 'desc' }, select: { no: true } }))?.no ?? 0,
    sync: await syncStatus(['fbs']),
  };
}

/** Товары и штуки по отправлениям — для текста «Поделиться» */
export async function postingItems(numbers: string[]) {
  const rows = await prisma.ozonFbsPosting.findMany({ where: { postingNumber: { in: numbers } } });
  const products = rows.flatMap((p) => p.products as unknown as FbsProduct[]);
  const items = await itemsByOffer([...new Set(products.map((x) => x.offerId))]);
  return products.map((x) => ({ name: items.get(x.offerId)?.name ?? x.name, qty: x.qty }));
}

// ───────────── Списание со склада ─────────────

interface Extra { itemId: string; name: string; qty: number }

/** Списывает единицы отправлений: сначала «с ЧЗ», затем «без ЧЗ», по FEFO; плюс упаковка (короб/пакеты). Один документ «Отгрузка Ozon FBS». */
async function writeOff(numbers: string[], userId: string, extras: Extra[] = [], note = '') {
  if (!numbers.length) return null;
  const postings = await prisma.ozonFbsPosting.findMany({ where: { postingNumber: { in: numbers }, stockDocId: null } });
  if (!postings.length) return null;
  const items = await itemsByOffer([...new Set(postings.flatMap((p) => (p.products as unknown as FbsProduct[]).map((x) => x.offerId)))]);
  const need = new Map<string, { name: string; qty: number }>();
  for (const p of postings) for (const x of p.products as unknown as FbsProduct[]) {
    const it = items.get(x.offerId);
    if (!it) throw new StockError(`Артикул Ozon ${x.offerId} не привязан к SKU портала — укажите его в карточке SKU`);
    const n = need.get(it.id) ?? { name: it.name, qty: 0 };
    n.qty += x.qty;
    need.set(it.id, n);
  }
  const days = [...new Set(postings.map((p) => p.shipDay))].sort().map((d) => d.split('-').reverse().slice(0, 2).join('.'));
  return prisma.$transaction(async (tx) => {
    const doc = await tx.stockDoc.create({
      data: {
        type: 'SHIPMENT', status: 'POSTED', postedAt: new Date(), number: await nextDocNumber(tx, 'SHIPMENT'), userId,
        comment: `Ozon FBS · ${note ? note + ' · ' : ''}отгрузка ${days.join(', ')} · ${postings.length} отпр.`,
      },
    });
    let sort = 0;
    for (const [itemId, n] of need) {
      let left = n.qty;
      for (const state of ['LABELED', 'UNLABELED'] as const) {
        if (left <= 1e-9) break;
        const { allocations } = await allocateFefo(tx, itemId, left, state);
        for (const a of allocations) {
          await consume(tx, doc.id, a.lotId!, state, a.qty, n.name);
          await tx.stockDocLine.create({ data: { docId: doc.id, itemId, lotId: a.lotId, qty: -a.qty, state, sort: sort++ } });
          left -= a.qty;
        }
      }
      if (left > 1e-9) throw new StockError(`«${n.name}»: на складе не хватает ${Math.round(left)} шт. (нужно ${n.qty})`);
    }
    for (const e of extras) {
      const { allocations, shortage } = await allocateFefo(tx, e.itemId, e.qty, 'NONE');
      if (shortage > 1e-9) throw new StockError(`«${e.name}»: на складе не хватает ${Math.round(shortage)} шт.`);
      for (const a of allocations) {
        await consume(tx, doc.id, a.lotId!, 'NONE', a.qty, e.name);
        await tx.stockDocLine.create({ data: { docId: doc.id, itemId: e.itemId, lotId: a.lotId, qty: -a.qty, state: 'NONE', sort: sort++ } });
      }
    }
    await tx.ozonFbsPosting.updateMany({ where: { postingNumber: { in: postings.map((p) => p.postingNumber) } }, data: { stockDocId: doc.id } });
    return doc;
  }, { isolationLevel: 'Serializable', timeout: 60000 });
}

/** Списать отправления, которые уже собраны (в т. ч. в кабинете Ozon), но не списаны. */
export async function writeOffPending(userId: string) {
  const rows = await prisma.ozonFbsPosting.findMany({
    where: { shipDay: { gte: WRITE_OFF_SINCE }, stockDocId: null, status: { in: ['awaiting_deliver', ...PASSED] } },
  });
  return writeOff(rows.map((r) => r.postingNumber), userId);
}

// ───────────── Сборка ─────────────

/** Данные экземпляров, которые Ozon требует перед «Собрано». Товар российский: ГТД и РНПТ — «отсутствует».
 *  Коды ЧЗ, если Ozon их потребует, сами не заполняются — ошибка с понятным текстом. */
export async function fillExemplars(postingNumber: string) {
  const e = await ozon('/v6/fbs/posting/product/exemplar/create-or-get', { posting_number: postingNumber });
  const products = e.products ?? [];
  const mark = products.find((p: any) => p.is_mandatory_mark_needed && (p.exemplars ?? []).some((x: any) => !(x.marks ?? []).length));
  if (mark) throw new StockError('Ozon требует коды ЧЗ экземпляров для этого отправления — заполните их в кабинете Ozon');
  await ozon('/v6/fbs/posting/product/exemplar/set', {
    posting_number: postingNumber,
    multi_box_qty: e.multi_box_qty ?? 1,
    products: products.map((p: any) => ({
      product_id: p.product_id, quantity: p.quantity,
      exemplars: (p.exemplars ?? []).map((x: any) => ({
        exemplar_id: x.exemplar_id, marks: x.marks ?? [], weight: x.weight ?? 0,
        gtd: x.gtd ?? '', is_gtd_absent: p.is_gtd_needed && !x.gtd ? true : !!x.is_gtd_absent,
        rnpt: x.rnpt ?? '', is_rnpt_absent: p.is_rnpt_needed && !x.rnpt ? true : !!x.is_rnpt_absent,
      })),
    })),
  });
  // Ozon проверяет данные асинхронно — ждём, пока сборка станет доступна
  for (let k = 0; k < 10; k++) {
    await sleep(1500);
    const st = await ozon('/v5/fbs/posting/product/exemplar/status', { posting_number: postingNumber });
    if (st.status === 'ship_available') return;
    if (st.status === 'ship_not_available' && k >= 4) {
      const errs = (st.products ?? []).flatMap((p: any) => (p.exemplars ?? []).flatMap((x: any) => [...(x.gtd_error_codes ?? []), ...(x.rnpt_error_codes ?? []), ...(x.weight_error_codes ?? [])]));
      throw new StockError(`Ozon не принял данные экземпляров${errs.length ? `: ${errs.join(', ')}` : ''}`);
    }
  }
}

export interface ShipOpts {
  kind: 'quant' | 'multi' | 'manual' | 'bag';
  quantTypeId?: string | null; // тип кванта: короб списывается один на группу
  limit?: number | null; // лимит, с которым собирали (для истории)
  labels?: boolean; // сразу этикетки 58×40 группы
  carriage?: boolean; // сразу поставка в Ozon из отправлений группы
  reserve?: string[]; // запасные заказы (тот же товар и штук) — взамен отменённых покупателем, чтобы собрать ровно столько, сколько выбрано
}

/** Собрать группу: «Собрано» в Ozon (одна коробка на отправление), списание товара и упаковки,
 *  номер группы дня, этикетки одним PDF и (по желанию) поставка. */
export async function ship(numbers: string[], userId: string, opts: ShipOpts) {
  const rows = await prisma.ozonFbsPosting.findMany({ where: { postingNumber: { in: numbers } } });
  const order = new Map([...numbers, ...(opts.reserve ?? [])].map((n, i) => [n, i]));
  const todo = rows.filter((r) => r.status === 'awaiting_packaging').sort((a, b) => order.get(a.postingNumber)! - order.get(b.postingNumber)!);
  if (!todo.length) throw new StockError('Нет отправлений в статусе «Ждёт сборки»');

  // Проверка до вызова Ozon: артикулы привязаны, товара и упаковки хватает
  const items = await itemsByOffer([...new Set(todo.flatMap((p) => (p.products as unknown as FbsProduct[]).map((x) => x.offerId)))]);
  const need = new Map<string, { name: string; qty: number }>();
  for (const p of todo) for (const x of p.products as unknown as FbsProduct[]) {
    const it = items.get(x.offerId);
    if (!it) throw new StockError(`Артикул Ozon ${x.offerId} не привязан к SKU портала — укажите его в карточке SKU`);
    const n = need.get(it.id) ?? { name: it.name, qty: 0 };
    n.qty += x.qty;
    need.set(it.id, n);
  }
  const stock = await stockOf([...need.keys()]);
  for (const [id, n] of need) {
    const have = (stock.get(id)?.labeled ?? 0) + (stock.get(id)?.unlabeled ?? 0);
    if (have < n.qty) throw new StockError(`«${n.name}»: нужно ${n.qty} шт., на складе ${Math.floor(have)} — расфасуйте или соберите меньше`);
  }
  const qt = opts.quantTypeId ? await prisma.quantType.findUnique({ where: { id: opts.quantTypeId }, include: { boxItem: true } }) : null;
  if (opts.quantTypeId && !qt) throw new StockError('Тип кванта не найден');
  const bag = opts.kind === 'bag' ? await bagItem() : null;
  const pack: Extra | null = qt?.boxItem ? { itemId: qt.boxItem.id, name: qt.boxItem.name, qty: 1 } : bag ? { itemId: bag.id, name: bag.name, qty: todo.length } : null;
  if (pack) {
    const have = (await stockOf([pack.itemId], ['NONE'])).get(pack.itemId)?.none ?? 0;
    if (have < pack.qty) throw new StockError(`«${pack.name}»: нужно ${pack.qty} шт., на складе ${Math.floor(have)}`);
  }

  const unitsOf = (p: { products: unknown }) => (p.products as FbsProduct[]).reduce((t, x) => t + x.qty, 0);
  // запасные — только ждущие сборки и с уже проверенными артикулами
  const spare = (opts.reserve?.length ? await prisma.ozonFbsPosting.findMany({ where: { postingNumber: { in: opts.reserve }, status: 'awaiting_packaging' } }) : [])
    .filter((r) => (r.products as unknown as FbsProduct[]).every((x) => items.has(x.offerId)))
    .sort((a, b) => order.get(a.postingNumber)! - order.get(b.postingNumber)!);

  const ok: string[] = [];
  const shipped: typeof todo = [];
  const failed: { postingNumber: string; error: string }[] = [];
  const cancelled: string[] = [];
  let queue = [...todo];
  // Волнами: отменённые покупателем (POSTING_ALREADY_CANCELLED) заменяем следующими запасными на те же штуки
  while (queue.length) {
    const wave = queue;
    queue = [];
    let lost = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let p = wave.shift(); p; p = wave.shift()) {
        const body = {
          posting_number: p.postingNumber,
          packages: [{ products: (p.products as unknown as FbsProduct[]).map((x) => ({ product_id: Number(x.sku), quantity: x.qty })) }],
          with: { additional_data: false },
        };
        try {
          // превышен лимит запросов Ozon — ждём и повторяем, а не теряем заказ из группы
          const shipOnce = async () => {
            for (let k = 0; ; k++) {
              try { return await ozon('/v4/posting/fbs/ship', body); } catch (e) {
                if (k >= 5 || !/лимит/.test((e as Error).message)) throw e;
                await sleep(3000 * (k + 1));
              }
            }
          };
          try { await shipOnce(); } catch (e) {
            // Ozon требует ГТД/РНПТ экземпляров — заполняем «отсутствует» и собираем повторно
            if (!/EXEMPLAR_INFO_NOT_FILLED/.test((e as Error).message)) throw e;
            await fillExemplars(p.postingNumber);
            await shipOnce();
          }
          await prisma.ozonFbsPosting.update({ where: { postingNumber: p.postingNumber }, data: { status: 'awaiting_deliver', shipError: null } });
          ok.push(p.postingNumber);
          shipped.push(p);
        } catch (e) {
          const error = (e as Error).message;
          if (/POSTING_ALREADY_CANCELLED/.test(error)) {
            // покупатель отказался — это не ошибка сборки; статус догонит синхронизация, отмечаем сразу
            await prisma.ozonFbsPosting.update({ where: { postingNumber: p.postingNumber }, data: { status: 'cancelled', shipError: null } });
            cancelled.push(p.postingNumber);
            lost += unitsOf(p);
          } else {
            await prisma.ozonFbsPosting.update({ where: { postingNumber: p.postingNumber }, data: { shipError: error } });
            failed.push({ postingNumber: p.postingNumber, error });
          }
        }
      }
    }));
    while (lost > 0 && spare.length) {
      const i = spare.findIndex((r) => unitsOf(r) <= lost);
      if (i < 0) break;
      const [r] = spare.splice(i, 1);
      queue.push(r);
      lost -= unitsOf(r);
    }
  }
  ok.sort((a, b) => order.get(a)! - order.get(b)!);
  if (!ok.length) return { shipped: 0, failed, cancelled, doc: null, writeOffError: null, batch: null, labelError: null, carriageError: null };

  // Номер группы — сквозной по всем товарам и дням; day — день сборки (МСК)
  const day = todayMsk();
  const units = shipped.reduce((t, p) => t + unitsOf(p), 0);
  let batch;
  for (let k = 0; ; k++) {
    const last = await prisma.ozonFbsBatch.findFirst({ orderBy: { no: 'desc' } });
    try {
      batch = await prisma.ozonFbsBatch.create({
        data: { day, no: (last?.no ?? 0) + 1, kind: opts.kind, quantTypeId: qt?.id ?? null, limit: opts.limit ?? null, postings: ok.length, units },
      });
      break;
    } catch (e) {
      // две сборки одновременно взяли один номер — берём следующий
      if (k < 3 && (e as { code?: string }).code === 'P2002') continue;
      throw e;
    }
  }
  await prisma.ozonFbsPosting.updateMany({ where: { postingNumber: { in: ok } }, data: { batchId: batch.id, batchNo: batch.no } });

  let doc = null, writeOffError: string | null = null;
  const note = `${qt ? `квант ${qt.name}` : opts.kind === 'bag' ? 'пакеты' : 'группа'} №${batch.no}`;
  try {
    // упаковку списываем только если собрано всё (короб — один на группу; пакеты — по числу собранных)
    const extras = pack ? [{ ...pack, qty: bag ? ok.length : 1 }] : [];
    doc = await writeOff(ok, userId, extras, note);
  } catch (e) { writeOffError = (e as Error).message; }

  let labelError: string | null = null, carriageError: string | null = null;
  if (opts.labels !== false) {
    if (ok.length <= 150) {
      try { await batchLabels(batch.id, 'small', ok); } catch (e) { labelError = (e as Error).message; }
    } else labelError = 'группа больше 150 отправлений — сформируйте этикетки кнопкой у группы';
  }
  if (opts.carriage) {
    try { await formCarriage([batch.id]); } catch (e) { carriageError = (e as Error).message; }
  }
  return { shipped: ok.length, failed, cancelled, doc: doc ? { id: doc.id, number: doc.number } : null, writeOffError, batch: { id: batch.id, no: batch.no }, labelError, carriageError };
}

// ───────────── Этикетки ─────────────

const SIZE_ERROR = {
  small: 'Ozon не сформировал этикетку 58×40. В кабинете Ozon: FBS → Логистика → метод доставки «Рощино» → Дополнительные настройки → включите «Печатать этикетку 58 × 40».',
  big: 'Ozon не сформировал этикетку 75×120',
};

// Одно задание Ozon на этикетки: файл и отправления, которые Ozon не напечатал
async function labelTask(numbers: string[], size: 'small' | 'big') {
  const want = size === 'small' ? 'small_label' : 'big_label';
  // сразу после «Собрано» Ozon может ещё не видеть отправления — NO_POSTINGS_FOR_BATCH_DOWNLOAD, ждём
  let c: any;
  for (let k = 0; ; k++) {
    try { c = await ozon('/v2/posting/fbs/package-label/create', { posting_number: numbers }); break; } catch (e) {
      if (k >= 8 || !/NO_POSTINGS_FOR_BATCH_DOWNLOAD/.test((e as Error).message)) throw e;
      await sleep(10_000);
    }
  }
  const tasks: { task_id: number; task_type: string }[] = c.result?.tasks ?? (c.result?.task_id ? [{ task_id: c.result.task_id, task_type: 'big_label' }] : []);
  const task = tasks.find((t) => t.task_type === want);
  if (!task) throw new StockError(SIZE_ERROR[size]);
  for (let k = 0; k < 30; k++) {
    await sleep(2000);
    const g = await ozon('/v1/posting/fbs/package-label/get', { task_id: task.task_id });
    const st = g.result?.status;
    if (st === 'error') throw new StockError(`Ozon: ошибка формирования этикеток — ${g.result?.error ?? ''}`);
    if (st === 'completed' && g.result?.file_url) {
      const missed: string[] = (g.result.unprinted_postings ?? []).map((x: any) => x.posting_number ?? x);
      return { pdf: await PDFDocument.load(await ozonGetFile(g.result.file_url)), missed };
    }
  }
  throw new StockError('Ozon долго формирует этикетки — повторите через минуту');
}

/** Этикетки отправлений одним PDF в заданном порядке. small — 58×40 (новый образец), big — 75×120. */
async function fetchLabels(numbers: string[], size: 'small' | 'big'): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (let i = 0; i < numbers.length; i += 50) {
    const chunk = numbers.slice(i, i + 50);
    const { pdf, missed } = await labelTask(chunk, size);
    // страница на отправление, в порядке запроса без ненапечатанных
    const printed = chunk.filter((n) => !missed.includes(n));
    if (pdf.getPageCount() !== printed.length) throw new StockError(`Ozon вернул ${pdf.getPageCount()} этикеток вместо ${printed.length} — повторите`);
    const pages = new Map<string, { doc: PDFDocument; idx: number }>(printed.map((n, idx) => [n, { doc: pdf, idx }]));
    // Ненапечатанные (сразу после «Собрано» бывает «not valid»): Ozon кэширует задание на тот же набор,
    // поэтому добираем их по одному, с паузами до ~2,5 мин
    for (const n of missed) {
      for (let attempt = 0; attempt < 10 && !pages.has(n); attempt++) {
        if (attempt) await sleep(15_000);
        const one = await labelTask([n], size);
        if (!one.missed.length && one.pdf.getPageCount() === 1) pages.set(n, { doc: one.pdf, idx: 0 });
      }
      if (!pages.has(n)) throw new StockError(`Ozon не напечатал этикетку ${n} — повторите через минуту`);
    }
    for (const n of chunk) {
      const p = pages.get(n)!;
      const [page] = await out.copyPages(p.doc, [p.idx]);
      out.addPage(page);
    }
  }
  return Buffer.from(await out.save());
}


const groupPostings = async (batchId: string, where: object = { status: { not: 'cancelled' } }) =>
  (await prisma.ozonFbsPosting.findMany({ where: { batchId, ...where }, orderBy: { postingNumber: 'asc' }, select: { postingNumber: true } })).map((p) => p.postingNumber);

/** Этикетки группы одним PDF. numbers — порядок печати (по умолчанию по номеру отправления). */
export async function batchLabels(batchId: string, size: 'small' | 'big', numbers?: string[]) {
  const b = await prisma.ozonFbsBatch.findUnique({ where: { id: batchId } });
  if (!b) throw new StockError('Группа не найдена');
  numbers ??= await groupPostings(b.id);
  if (!numbers.length) throw new StockError(`В группе №${b.no} нет отправлений`);
  const key = `ozon-fbs/${b.day}/batch-${b.no}-${size}.pdf`;
  await uploadFile(key, await fetchLabels(numbers, size), 'application/pdf');
  return prisma.ozonFbsBatch.update({ where: { id: b.id }, data: { labelS3Key: key, labelType: size === 'small' ? 'small_label' : 'big_label', labelAt: new Date() } });
}

/** Этикетки только несданных отправлений группы (собраны, ещё не приняты Ozon) — PDF сразу, без сохранения */
export async function pendingLabels(batchId: string) {
  const numbers = await groupPostings(batchId, { status: 'awaiting_deliver' });
  if (!numbers.length) throw new StockError('Все отправления группы уже приняты Ozon');
  return { numbers, pdf: await fetchLabels(numbers, 'small') };
}

// ───────────── ЧЗ на тубы группы ─────────────
// Ozon FBS коды ЧЗ не требует, но на тубе код должен быть. Малая этикетка 30×20 печатается для туб группы:
//  • «с ЧЗ» из партий, промаркированных в портале, — закрепляем за отгрузкой коды, уже выданные на партию при маркировке
//    (ShipmentCode; те же коды больше никуда не уйдут). Начальные остатки «с ЧЗ» кодов в портале не имеют — пропускаем;
//  • «без ЧЗ» — выдаём новые коды из пула товара (тираж привязан к документу списания).
// Только для неотправленных групп; повторная печать — те же коды.

export async function groupCzCodes(batchId: string): Promise<{ codeIds: string[]; noCodes: number }> {
  const b = await prisma.ozonFbsBatch.findUnique({ where: { id: batchId } });
  if (!b) throw new StockError('Группа не найдена');
  const docIds = [...new Set((await prisma.ozonFbsPosting.findMany({ where: { batchId, stockDocId: { not: null } }, select: { stockDocId: true } })).map((p) => p.stockDocId!))];
  if (!docIds.length) throw new StockError(`Группа №${b.no} ещё не списана со склада — ЧЗ печатается на списанные тубы`);
  const lines = await prisma.stockDocLine.findMany({ where: { docId: { in: docIds }, qty: { lt: 0 }, state: { in: ['LABELED', 'UNLABELED'] } }, include: { item: { include: { spec: true } } } });

  return prisma.$transaction(async (tx) => {
    const fixed = await tx.shipmentCode.findMany({ where: { docId: { in: docIds } }, orderBy: { createdAt: 'asc' } });
    const issued = await tx.outputBatch.findMany({ where: { docId: { in: docIds } }, include: { codes: { select: { id: true, pageIndex: true }, orderBy: { pageIndex: 'asc' } } }, orderBy: { createdAt: 'asc' } });
    if (fixed.length || issued.length) return { codeIds: [...fixed.map((f) => f.czCodeId), ...issued.flatMap((o) => o.codes.map((c) => c.id))], noCodes: 0 };
    if (b.shippedAt) throw new StockError(`Группа №${b.no} уже отправлена — ЧЗ на неё не выдаём`);

    const codeIds: string[] = [];
    let noCodes = 0;
    for (const l of lines.filter((x) => x.item.spec?.requiresCz)) {
      const n = Math.round(-l.qty);
      if (l.state === 'LABELED') {
        // коды, напечатанные на эту партию маркировкой и ещё не ушедшие в квант / WB / другую отгрузку
        const ids = l.lotId ? await looseCodes(tx, l.lotId, n) : [];
        noCodes += n - ids.length;
        if (ids.length) await tx.shipmentCode.createMany({ data: ids.map((czCodeId) => ({ docId: l.docId, czCodeId })) });
        codeIds.push(...ids);
        continue;
      }
      const projectId = l.item.spec!.czProjectId;
      if (!projectId) throw new StockError(`Для «${l.item.name}» не выбран проект ЧЗ в карточке SKU`);
      const codes = await tx.$queryRaw<{ id: string; pageIndex: number }[]>`
        SELECT c.id, c."pageIndex" FROM "CzCode" c JOIN "CzBatch" cb ON cb.id = c."czBatchId"
        WHERE cb."projectId" = ${projectId} AND c.status = 'PENDING'
        ORDER BY cb."uploadedAt" ASC, c."pageIndex" ASC LIMIT ${n} FOR UPDATE OF c SKIP LOCKED`;
      if (codes.length < n) throw new StockError(`Свободных кодов ЧЗ для «${l.item.name}»: ${codes.length}, нужно ${n}. Загрузите коды в «Маркировка → База ЧЗ».`);
      const ob = await tx.outputBatch.create({
        data: {
          projectId, fromIndex: codes[0].pageIndex, toIndex: codes[codes.length - 1].pageIndex, count: n, jobStatus: 'tube',
          lotId: l.lotId, docId: l.docId, variables: l.lotId ? await lotLabelVars(tx, l.lotId) : undefined,
        },
      });
      await tx.czCode.updateMany({ where: { id: { in: codes.map((c) => c.id) } }, data: { status: 'USED', usedAt: new Date(), outputBatchId: ob.id } });
      codeIds.push(...codes.map((c) => c.id));
    }
    return { codeIds, noCodes };
  }, { timeout: 60_000 });
}

// ───────────── Поставка (отгрузка в Ozon) ─────────────

// Отправление уже в сформированной отгрузке Ozon. Отгрузка — одна на день отгрузки: если её не сдали в свой день,
// Ozon её закрывает, а отправления снова ждут новую отгрузку; при формировании с выбранным составом остальные исключаются.
export const IN_CARRIAGE = 'posting_in_carriage';

/** Поставка в Ozon из отправлений групп, которые ещё не в отгрузке: создаём (Ozon берёт все собранные без поставки),
 *  оставляем в ней отправления групп, при необходимости подтверждаем. */
export async function formCarriage(batchIds: string[]) {
  const bs = await prisma.ozonFbsBatch.findMany({ where: { id: { in: batchIds } } });
  if (!bs.length) throw new StockError('Группы не найдены');
  const rows = await prisma.ozonFbsPosting.findMany({ where: { batchId: { in: bs.map((b) => b.id) }, status: 'awaiting_deliver', NOT: { substatus: IN_CARRIAGE } } });
  if (!rows.length) throw new StockError('Все собранные отправления этих групп уже в отгрузке или переданы в Ozon');
  const method = rows.find((r) => r.deliveryMethodId)?.deliveryMethodId;
  if (!method) throw new StockError('Не известен метод доставки отправлений');
  // просроченные отправления Ozon переносит на сегодня — поставку создаём сегодняшним днём
  const id = await openCarriage(method);
  await prisma.ozonFbsBatch.updateMany({ where: { id: { in: bs.map((b) => b.id) } }, data: { carriageId: String(id), carriageStatus: 'created', carriageAt: new Date() } });
  await ozon('/v1/carriage/set-postings', { carriage_id: Number(id), posting_numbers: rows.map((r) => r.postingNumber) });
  await prisma.ozonFbsPosting.updateMany({ where: { postingNumber: { in: rows.map((r) => r.postingNumber) } }, data: { substatus: IN_CARRIAGE } });
  let g = await ozon('/v1/carriage/get', { carriage_id: Number(id) });
  if (g.status !== 'formed' && (g.available_actions ?? []).includes('approve')) {
    await ozon('/v1/carriage/approve', { carriage_id: Number(id), containers_count: 1 });
    g = await ozon('/v1/carriage/get', { carriage_id: Number(id) });
  }
  await prisma.ozonFbsBatch.updateMany({ where: { carriageId: String(id) }, data: { carriageStatus: g.status ?? null } });
  return String(id);
}

/** Новая отгрузка на сегодня. Ozon держит одну несформированную на метод доставки (THERE_IS_AN_UNFORMED_CARRIAGE):
 *  если она на сегодня или позже — берём её (состав всё равно задаём сами); если зависла со старой датой — отменяем
 *  (отправления остаются собранными) и создаём новую. */
async function openCarriage(method: string): Promise<string> {
  const today = todayMsk();
  const create = async () => {
    const c = await ozon('/v1/carriage/create', { delivery_method_id: Number(method), departure_date: `${today}T00:00:00Z` });
    const id = c.carriage_id ?? c.result?.carriage_id ?? c.id ?? c.result?.id;
    if (!id) throw new StockError(`Ozon не вернул номер поставки: ${JSON.stringify(c).slice(0, 200)}`);
    return String(id);
  };
  try { return await create(); } catch (e) {
    if (!/THERE_IS_AN_UNFORMED_CARRIAGE/.test((e as Error).message)) throw e;
  }
  const shift = (d: number) => new Date(Date.parse(today) + d * 86400_000).toISOString().slice(0, 10);
  const list = await ozon('/v2/posting/fbs/act/list', { filter: { date_from: shift(-14), date_to: shift(7) }, limit: 50 });
  const un = (list.result ?? []).find((x: any) => String(x.delivery_method_id) === method && x.status === 'new');
  if (!un) throw new StockError('В Ozon есть несформированная отгрузка, но найти её не удалось — сформируйте или отмените её в кабинете Ozon');
  if (String(un.departure_date).slice(0, 10) >= today) return String(un.id);
  await ozon('/v1/carriage/cancel', { carriage_id: Number(un.id) });
  return create();
}

/** Статусы поставок из Ozon (сформирована, отгружена…) — для групп последних дней */
async function refreshCarriages() {
  // закрытые и отменённые поставки уже не меняются — их не перезапрашиваем
  const bs = await prisma.ozonFbsBatch.findMany({
    // только у групп, где ещё есть неотправленное: у отгруженных Ozon оставляет «formed», но смотреть там нечего
    where: { carriageId: { not: null }, shippedAt: null, createdAt: { gte: new Date(Date.now() - 5 * 86400_000) }, NOT: { carriageStatus: { in: ['closed', 'cancelled'] } } },
    select: { carriageId: true },
  });
  for (const id of [...new Set(bs.map((b) => b.carriageId!))]) {
    const g = await ozonCall<any>('POST', '/v1/carriage/get', { carriage_id: Number(id) }, undefined, false).catch(() => null);
    if (g?.status) await prisma.ozonFbsBatch.updateMany({ where: { carriageId: id }, data: { carriageStatus: g.status } });
  }
}

/** Акт приёма-передачи поставки группы (PDF от Ozon). */
export async function carriageAct(batchId: string): Promise<Buffer> {
  const b = await prisma.ozonFbsBatch.findUnique({ where: { id: batchId } });
  if (!b?.carriageId) throw new StockError('Поставка группы ещё не сформирована');
  return ozonPdf('/v2/posting/fbs/act/get-pdf', { id: Number(b.carriageId) });
}
