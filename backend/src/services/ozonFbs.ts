import { PDFDocument } from 'pdf-lib';
import prisma from '../prisma/client';
import { ozon, ozonCall, ozonPdf, ozonGetFile } from './ozon';
import { allocateFefo, consume, nextDocNumber, StockError } from './stock';
import { uploadFile } from './s3';

// Отправки Ozon FBS: зеркало отправлений, сборка в Ozon со списанием со склада, этикетки 58×40, акт.

export interface FbsProduct { offerId: string; sku: string; name: string; qty: number; price: number }

const MSK = 3 * 3600_000;
const mskDay = (iso: string) => new Date(Date.parse(iso) + MSK).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────── Синхронизация ─────────────

export async function syncFbs(userId?: string): Promise<number> {
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const to = new Date(Date.now() + 86400_000).toISOString();
  let offset = 0, n = 0;
  for (;;) {
    // объёмный ответ — в журнал API только ошибки
    const r: any = await ozonCall('POST', '/v3/posting/fbs/list', {
      dir: 'ASC', filter: { since, to }, limit: 1000, offset, with: { analytics_data: false, financial_data: false },
    }, undefined, false);
    const postings: any[] = r.result?.postings ?? [];
    for (const p of postings) {
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
      await prisma.ozonFbsPosting.upsert({ where: { postingNumber: p.posting_number }, create: { postingNumber: p.posting_number, ...data }, update: data });
      n++;
    }
    if (!r.result?.has_next || postings.length === 0) break;
    offset += postings.length;
  }
  await writeOffPassed(userId);
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

// ───────────── Состояние ─────────────

async function itemsByOffer(offers: string[]) {
  const specs = await prisma.productSpec.findMany({ where: { ozonOfferId: { in: offers } }, include: { item: true } });
  return new Map(specs.map((s) => [s.ozonOfferId!, { id: s.itemId, name: s.item.name, requiresCz: s.requiresCz }]));
}

async function stockOf(itemIds: string[]) {
  const g = await prisma.stockMove.groupBy({
    by: ['lotId', 'state'], where: { lot: { itemId: { in: itemIds } }, state: { in: ['LABELED', 'UNLABELED'] } }, _sum: { qty: true },
  });
  const lots = await prisma.lot.findMany({ where: { id: { in: g.map((x) => x.lotId) } }, select: { id: true, number: true, itemId: true, expiresAt: true } });
  const lotOf = new Map(lots.map((l) => [l.id, l]));
  const out = new Map<string, { labeled: number; unlabeled: number; lots: { number: string; state: string; qty: number }[] }>();
  for (const x of g) {
    const qty = x._sum.qty ?? 0;
    if (qty <= 1e-9) continue;
    const l = lotOf.get(x.lotId)!;
    const s = out.get(l.itemId) ?? { labeled: 0, unlabeled: 0, lots: [] };
    if (x.state === 'LABELED') s.labeled += qty; else s.unlabeled += qty;
    s.lots.push({ number: l.number, state: x.state, qty });
    out.set(l.itemId, s);
  }
  return out;
}

export async function days() {
  const rows = await prisma.ozonFbsPosting.groupBy({ by: ['shipDay', 'status'], _count: true, orderBy: { shipDay: 'desc' } });
  const m = new Map<string, Record<string, number>>();
  for (const r of rows) { const d = m.get(r.shipDay) ?? {}; d[r.status] = r._count; m.set(r.shipDay, d); }
  return [...m.entries()].map(([day, counts]) => ({ day, counts }));
}

export async function dayState(day: string) {
  const postings = await prisma.ozonFbsPosting.findMany({ where: { shipDay: day }, orderBy: [{ inProcessAt: 'asc' }, { postingNumber: 'asc' }] });
  const offers = [...new Set(postings.flatMap((p) => (p.products as unknown as FbsProduct[]).map((x) => x.offerId)))];
  const items = await itemsByOffer(offers);
  const stock = await stockOf([...items.values()].map((i) => i.id));
  const docs = await prisma.stockDoc.findMany({ where: { id: { in: postings.map((p) => p.stockDocId).filter((x): x is string => !!x) } }, select: { id: true, number: true } });
  const dayRow = await prisma.ozonFbsDay.findUnique({ where: { day } });
  const batches = await prisma.ozonFbsBatch.findMany({ where: { day }, orderBy: { no: 'asc' } });
  return {
    day,
    info: dayRow,
    batches,
    postings: postings.map((p) => ({
      ...p,
      products: (p.products as unknown as FbsProduct[]).map((x) => ({ ...x, item: items.get(x.offerId) ?? null })),
    })),
    unmapped: offers.filter((o) => !items.has(o)),
    stock: [...items.values()].map((i) => ({ ...i, ...(stock.get(i.id) ?? { labeled: 0, unlabeled: 0, lots: [] }) })),
    docs,
  };
}

// ───────────── Списание со склада ─────────────

/** Списывает единицы отправлений: сначала «с ЧЗ», затем «без ЧЗ», по FEFO. Один документ «Отгрузка Ozon FBS». */
async function writeOff(numbers: string[], userId: string) {
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
  const day = postings[0].shipDay;
  return prisma.$transaction(async (tx) => {
    const doc = await tx.stockDoc.create({
      data: {
        type: 'SHIPMENT', status: 'POSTED', postedAt: new Date(), number: await nextDocNumber(tx, 'SHIPMENT'), userId,
        comment: `Ozon FBS · отгрузка ${day.split('-').reverse().join('.')} · ${postings.length} отпр.`,
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
    await tx.ozonFbsPosting.updateMany({ where: { postingNumber: { in: postings.map((p) => p.postingNumber) } }, data: { stockDocId: doc.id } });
    return doc;
  }, { isolationLevel: 'Serializable', timeout: 60000 });
}

/** Списать отправления, которые уже собраны (в т. ч. в кабинете Ozon), но не списаны. */
export async function writeOffDay(day: string, numbers: string[] | undefined, userId: string) {
  const rows = await prisma.ozonFbsPosting.findMany({
    where: { shipDay: { equals: day, gte: WRITE_OFF_SINCE }, stockDocId: null, status: { notIn: ['awaiting_packaging', 'awaiting_registration', 'acceptance_in_progress', 'awaiting_approve', 'cancelled'] }, ...(numbers ? { postingNumber: { in: numbers } } : {}) },
  });
  return writeOff(rows.map((r) => r.postingNumber), userId);
}

// ───────────── Сборка ─────────────

/** «Собрано» в Ozon (одна коробка на отправление) и списание собранного со склада.
 *  batch — собрать группой (квант 42 шт., заказы по 2+ шт., ручной выбор): собранным присваивается номер группы дня
 *  и сразу формируются их этикетки одним PDF. */
export async function ship(numbers: string[], userId: string, batch: 'quant' | 'multi' | 'manual' | null = null) {
  const rows = await prisma.ozonFbsPosting.findMany({ where: { postingNumber: { in: numbers } } });
  const todo = rows.filter((r) => r.status === 'awaiting_packaging');
  if (!todo.length) throw new StockError('Нет отправлений в статусе «Ждёт сборки»');

  // Проверка до вызова Ozon: все артикулы привязаны и единиц хватает
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

  const ok: string[] = [];
  const failed: { postingNumber: string; error: string }[] = [];
  const queue = [...todo];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        await ozon('/v4/posting/fbs/ship', {
          posting_number: p.postingNumber,
          packages: [{ products: (p.products as unknown as FbsProduct[]).map((x) => ({ product_id: Number(x.sku), quantity: x.qty })) }],
          with: { additional_data: false },
        });
        await prisma.ozonFbsPosting.update({ where: { postingNumber: p.postingNumber }, data: { status: 'awaiting_deliver', shipError: null } });
        ok.push(p.postingNumber);
      } catch (e) {
        const error = (e as Error).message;
        await prisma.ozonFbsPosting.update({ where: { postingNumber: p.postingNumber }, data: { shipError: error } });
        failed.push({ postingNumber: p.postingNumber, error });
      }
    }
  }));
  let doc = null, writeOffError: string | null = null;
  try { doc = await writeOff(ok, userId); } catch (e) { writeOffError = (e as Error).message; }

  let batchNo: number | null = null, labelError: string | null = null;
  if (batch && ok.length) {
    const day = todo[0].shipDay;
    const last = await prisma.ozonFbsBatch.findFirst({ where: { day }, orderBy: { no: 'desc' } });
    batchNo = (last?.no ?? 0) + 1;
    // порядок этикеток — как отправления шли в выборке
    const order = new Map(numbers.map((n, i) => [n, i]));
    ok.sort((a, b) => order.get(a)! - order.get(b)!);
    const units = todo.filter((p) => ok.includes(p.postingNumber))
      .reduce((t, p) => t + (p.products as unknown as FbsProduct[]).reduce((s, x) => s + x.qty, 0), 0);
    await prisma.ozonFbsBatch.create({ data: { day, no: batchNo, kind: batch, postings: ok.length, units } });
    await prisma.ozonFbsPosting.updateMany({ where: { postingNumber: { in: ok } }, data: { batchNo } });
    // большую группу этикеток Ozon формирует минутами — её печатают общим PDF дня на шаге 3
    if (ok.length <= 150) {
      try { await batchLabels(day, batchNo, 'small', ok); } catch (e) { labelError = (e as Error).message; }
    } else labelError = 'группа больше 150 отправлений — сформируйте этикетки на шаге 3';
  }
  return { shipped: ok.length, failed, doc: doc ? { id: doc.id, number: doc.number } : null, writeOffError, batchNo, labelError };
}

// ───────────── Этикетки ─────────────

const SIZE_ERROR = {
  small: 'Ozon не сформировал этикетку 58×40. В кабинете Ozon: FBS → Логистика → метод доставки «Рощино» → Дополнительные настройки → включите «Печатать этикетку 58 × 40».',
  big: 'Ozon не сформировал этикетку 75×120',
};

/** Этикетки отправлений одним PDF в заданном порядке. small — 58×40 (новый образец), big — 75×120. */
async function fetchLabels(numbers: string[], size: 'small' | 'big'): Promise<Buffer> {
  const want = size === 'small' ? 'small_label' : 'big_label';
  const out = await PDFDocument.create();
  for (let i = 0; i < numbers.length; i += 50) {
    const chunk = numbers.slice(i, i + 50);
    // Сразу после «Собрано» Ozon печатает не все отправления (unprinted_postings) — повторяем пачку целиком,
    // пока не напечатает все, чтобы сохранить порядок этикеток
    let file: Buffer | null = null;
    for (let attempt = 0; attempt < 6 && !file; attempt++) {
      if (attempt) await sleep(10_000);
      const c = await ozon('/v2/posting/fbs/package-label/create', { posting_number: chunk });
      const tasks: { task_id: number; task_type: string }[] = c.result?.tasks ?? (c.result?.task_id ? [{ task_id: c.result.task_id, task_type: 'big_label' }] : []);
      const task = tasks.find((t) => t.task_type === want);
      if (!task) throw new StockError(SIZE_ERROR[size]);
      let res: any = null;
      for (let k = 0; k < 30 && !res; k++) {
        await sleep(2000);
        const g = await ozon('/v1/posting/fbs/package-label/get', { task_id: task.task_id });
        const st = g.result?.status;
        if (st === 'completed' && g.result?.file_url) res = g.result;
        else if (st === 'error') throw new StockError(`Ozon: ошибка формирования этикеток — ${g.result?.error ?? ''}`);
      }
      if (!res) throw new StockError('Ozon долго формирует этикетки — повторите через минуту');
      const missed: string[] = (res.unprinted_postings ?? []).map((x: any) => x.posting_number ?? x);
      if (!res.unprinted_postings_count && !missed.length) file = await ozonGetFile(res.file_url);
      else if (attempt === 5) {
        throw new StockError(`Ozon не напечатал ${res.unprinted_postings_count || missed.length} из ${chunk.length} этикеток${missed.length ? ` (${missed.slice(0, 5).join(', ')}${missed.length > 5 ? '…' : ''})` : ''} — повторите через минуту`);
      }
    }
    const part = await PDFDocument.load(file!);
    for (const page of await out.copyPages(part, part.getPageIndices())) out.addPage(page);
  }
  return Buffer.from(await out.save());
}

/** Этикетки собранных отправлений дня одним PDF. */
export async function labels(day: string, size: 'small' | 'big') {
  const rows = await prisma.ozonFbsPosting.findMany({ where: { shipDay: day, status: 'awaiting_deliver' }, orderBy: [{ batchNo: 'asc' }, { postingNumber: 'asc' }] });
  if (!rows.length) throw new StockError('Нет собранных отправлений, ожидающих отгрузки — сначала соберите их');
  const want = size === 'small' ? 'small_label' : 'big_label';
  const key = `ozon-fbs/${day}/labels-${size}.pdf`;
  await uploadFile(key, await fetchLabels(rows.map((r) => r.postingNumber), size), 'application/pdf');
  await prisma.ozonFbsDay.upsert({
    where: { day },
    create: { day, labelS3Key: key, labelType: want, labelCount: rows.length, labelAt: new Date() },
    update: { labelS3Key: key, labelType: want, labelCount: rows.length, labelAt: new Date(), lastError: null },
  });
  return prisma.ozonFbsDay.findUnique({ where: { day } });
}

/** Этикетки одного кванта сборки. numbers — порядок печати (по умолчанию по номеру отправления). */
export async function batchLabels(day: string, no: number, size: 'small' | 'big', numbers?: string[]) {
  const b = await prisma.ozonFbsBatch.findUnique({ where: { day_no: { day, no } } });
  if (!b) throw new StockError(`Группа №${no} не найдена`);
  if (!numbers) {
    const rows = await prisma.ozonFbsPosting.findMany({ where: { shipDay: day, batchNo: no, status: { not: 'cancelled' } }, orderBy: { postingNumber: 'asc' } });
    numbers = rows.map((r) => r.postingNumber);
  }
  if (!numbers.length) throw new StockError(`В группе №${no} нет отправлений`);
  const key = `ozon-fbs/${day}/batch-${no}-${size}.pdf`;
  await uploadFile(key, await fetchLabels(numbers, size), 'application/pdf');
  return prisma.ozonFbsBatch.update({ where: { id: b.id }, data: { labelS3Key: key, labelType: size === 'small' ? 'small_label' : 'big_label', labelAt: new Date() } });
}

// ───────────── Акт ─────────────

/** Акт приёма-передачи на день: берём уже созданный Ozon, иначе создаём; PDF сохраняем. */
export async function act(day: string) {
  const p = await prisma.ozonFbsPosting.findFirst({ where: { shipDay: day, deliveryMethodId: { not: null } } });
  if (!p) throw new StockError('Нет отправлений на этот день');
  const list = await ozon('/v2/posting/fbs/act/list', { filter: { date_from: day, date_to: day }, limit: 50 });
  let a = (list.result ?? []).find((x: any) => String(x.delivery_method_id) === p.deliveryMethodId && x.status !== 'closed');
  let id: string | null = a ? String(a.id) : null;
  if (!id) {
    const c = await ozon('/v2/posting/fbs/act/create', { delivery_method_id: Number(p.deliveryMethodId), departure_date: `${day}T00:00:00Z`, containers_count: 1 });
    id = String(c.result?.id ?? c.id);
  }
  let status: string | null = a?.status ?? null;
  for (let k = 0; k < 20; k++) {
    const s = await ozon('/v2/posting/fbs/digital/act/check-status', { id: Number(id) }).catch(() => null);
    status = s?.status ?? status;
    if (s && !['FORMING', 'formation', 'in_process'].includes(String(s.status))) break;
    await sleep(2000);
  }
  const pdf = await ozonPdf('/v2/posting/fbs/act/get-pdf', { id: Number(id) });
  const key = `ozon-fbs/${day}/act-${id}.pdf`;
  await uploadFile(key, pdf, 'application/pdf');
  await prisma.ozonFbsDay.upsert({
    where: { day },
    create: { day, actId: id, actStatus: status, actS3Key: key, actAt: new Date() },
    update: { actId: id, actStatus: status, actS3Key: key, actAt: new Date(), lastError: null },
  });
  return prisma.ozonFbsDay.findUnique({ where: { day } });
}
