import prisma from '../prisma/client';
import { kick, track } from './syncStatus';
import { getSetting, ozonCall, ozonConfigured, setSetting, sleep } from './ozon';
import { allocatedCharges, campaignMeta, dateRange, todayMsk, ymd } from './ads';

// Графики «Аналитики рекламы»: отправления FBO/FBS с кластерами, поставки FBO и оценка остатков по кластерам.
// Ozon не хранит историю остатков, поэтому остаток считается от «нулевой» даты (сток кончился везде)
// вперёд: + поставки, − FBO-отгрузки со складов кластера.

const DAY = 86_400_000;
const HISTORY = 150; // дней отправлений и поставок в базе — хватает на 92-дневный период и точку отсчёта остатков
const dt = (s: string) => new Date(s + 'T00:00:00Z');
const addDays = (s: string, n: number) => ymd(new Date(dt(s).getTime() + n * DAY));
const mskDay = (iso: string | Date) => ymd(new Date(new Date(iso).getTime() + 3 * 3600_000));
const num = (x: unknown) => Number(String(x ?? 0).replace(',', '.').replace(/\s/g, '')) || 0;
const r1 = (v: number) => Math.round(v * 10) / 10;

async function seller<T = any>(path: string, body: unknown): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await ozonCall<T>('POST', path, body, undefined, false); } catch (e) {
      if (i < 3 && /лимит/.test((e as Error).message)) { await sleep(20_000 * (i + 1)); continue; }
      throw e;
    }
  }
}

// ───────────── Отправления ─────────────

async function fetchPostings(scheme: 'FBO' | 'FBS', from: string, to: string) {
  const path = scheme === 'FBO' ? '/v3/posting/fbo/list' : '/v4/posting/fbs/list';
  // границы дней по Москве
  const since = new Date(dt(from).getTime() - 3 * 3600_000).toISOString();
  const until = new Date(dt(to).getTime() + DAY - 3 * 3600_000 - 1000).toISOString();
  const out: { postingNumber: string; sku: string; scheme: string; status: string; orderDay: string; orderAt: Date; qty: number; price: number; clusterFrom: string | null; clusterTo: string | null; warehouse: string | null }[] = [];
  let cursor = '';
  for (let page = 0; page < 1000; page++) {
    const r = await seller(path, { dir: 'ASC', filter: { since, to: until }, limit: 100, ...(cursor ? { cursor } : {}), with: { analytics_data: true, financial_data: true } });
    const list: any[] = r.postings ?? r.result?.postings ?? r.result ?? [];
    for (const p of list) {
      const at = p.in_process_at || p.created_at;
      if (!at) continue;
      const fin = p.financial_data ?? {};
      const byKey = new Map<string, (typeof out)[number]>();
      for (const it of p.products ?? []) {
        const sku = String(it.sku);
        const prev = byKey.get(sku);
        if (prev) { prev.qty += it.quantity ?? 1; continue; }
        byKey.set(sku, {
          postingNumber: p.posting_number, sku, scheme, status: p.status ?? '', orderDay: mskDay(at), orderAt: new Date(at),
          qty: it.quantity ?? 1, price: num(it.price?.amount ?? it.price),
          clusterFrom: fin.cluster_from || null, clusterTo: fin.cluster_to || null,
          warehouse: p.analytics_data?.warehouse_name ?? p.analytics_data?.warehouse ?? p.delivery_method?.warehouse ?? null,
        });
      }
      out.push(...byKey.values());
    }
    if (!r.has_next || !r.cursor || list.length === 0) break;
    cursor = r.cursor;
  }
  return out;
}

async function stalePostingDays(dates: string[], force: boolean) {
  const today = todayMsk();
  const want = dates.filter((d) => d <= today);
  if (force) return want;
  const rows = await prisma.adSyncDay.findMany({ where: { kind: 'postings', date: { in: want.map(dt) } } });
  const got = new Map(rows.map((r) => [ymd(r.date), r.fetchedAt.getTime()]));
  const fresh = addDays(today, -21); // статусы (отмены) меняются ещё пару недель
  return want.filter((d) => {
    const at = got.get(d);
    if (at == null) return true;
    if (d === today) return Date.now() - at > 15 * 60_000;
    return d >= fresh && Date.now() - at > 2 * 3600_000;
  });
}

export async function syncPostings(from: string, to: string, force = false) {
  if (!ozonConfigured()) return;
  const days = await stalePostingDays(dateRange(from, to), force);
  if (!days.length) return;
  // непрерывные отрезки не длиннее 31 дня
  const spans: [string, string][] = [];
  for (const d of days) {
    const l = spans[spans.length - 1];
    if (l && addDays(l[1], 1) === d && (dt(d).getTime() - dt(l[0]).getTime()) / DAY < 31) l[1] = d; else spans.push([d, d]);
  }
  for (const [a, b] of spans) {
    const rows = [...await fetchPostings('FBO', a, b), ...await fetchPostings('FBS', a, b)];
    const numbers = [...new Set(rows.map((r) => r.postingNumber))];
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < numbers.length; i += 1000) await tx.ozonPosting.deleteMany({ where: { postingNumber: { in: numbers.slice(i, i + 1000) } } });
      for (let i = 0; i < rows.length; i += 1000) await tx.ozonPosting.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true });
    }, { timeout: 120_000 });
    for (const d of dateRange(a, b)) {
      await prisma.adSyncDay.upsert({ where: { kind_date: { kind: 'postings', date: dt(d) } }, create: { kind: 'postings', date: dt(d) }, update: { fetchedAt: new Date() } });
    }
  }
}

// ───────────── Поставки FBO ─────────────

const ARRIVED = ['COMPLETED', 'REPORTS_CONFIRMATION_AWAITING', 'REPORT_REJECTED'];
const LIST_STATES = ['READY_TO_SUPPLY', 'ACCEPTED_AT_SUPPLY_WAREHOUSE', 'IN_TRANSIT', 'ACCEPTANCE_AT_STORAGE_WAREHOUSE', ...ARRIVED];

let clusterCache: { at: number; map: Map<string, string> } | null = null;
async function clusterNames(): Promise<Map<string, string>> {
  if (clusterCache && Date.now() - clusterCache.at < 24 * 3600_000) return clusterCache.map;
  const r = await seller('/v2/cluster/list', {});
  const map = new Map<string, string>();
  for (const c of r.result ?? r.clusters ?? []) map.set(String(c.macrolocal_cluster_id), c.data?.macrolocal_cluster?.name ?? '');
  clusterCache = { at: Date.now(), map };
  return map;
}

async function bundleItems(bundleId: string) {
  const items: { sku: string; qty: number }[] = [];
  let last = '';
  for (let i = 0; i < 50; i++) {
    const r = await seller('/v1/supply-order/bundle', { bundle_ids: [bundleId], limit: 100, ...(last ? { last_id: last } : {}) });
    for (const it of r.items ?? []) items.push({ sku: String(it.sku), qty: it.quantity ?? 0 });
    if (!r.has_next || !r.last_id) break;
    last = r.last_id;
  }
  return items;
}

export async function syncSupplies() {
  if (!ozonConfigured()) return;
  const cutoff = Date.now() - HISTORY * DAY;
  const known = new Map((await prisma.ozonSupply.findMany({ select: { orderId: true, state: true } })).map((s) => [s.orderId, s.state]));
  const names = await clusterNames();
  let last = '';
  outer: for (let page = 0; page < 100; page++) {
    const l = await seller('/v3/supply-order/list', { filter: { states: LIST_STATES }, limit: 100, sort_by: 1, sort_dir: 'DESC', ...(last ? { last_id: last } : {}) });
    const ids: number[] = l.order_ids ?? [];
    if (!ids.length) break;
    for (let i = 0; i < ids.length; i += 50) {
      const g = await seller('/v3/supply-order/get', { order_ids: ids.slice(i, i + 50) });
      const orders: any[] = g.orders ?? [];
      let older = 0;
      for (const o of orders) {
        if (new Date(o.created_date).getTime() < cutoff) { older++; continue; }
        if (known.get(String(o.order_id)) === o.state) continue; // не изменилась
        for (const s of o.supplies ?? []) {
          const items = s.bundle_id ? await bundleItems(s.bundle_id) : [];
          const clusterId = s.macrolocal_cluster_id ? String(s.macrolocal_cluster_id) : null;
          const v = {
            orderId: String(o.order_id), state: o.state, clusterId, clusterName: clusterId ? names.get(clusterId) || null : null,
            createdAt: new Date(o.created_date), timeslotFrom: o.timeslot?.timeslot?.from ? new Date(o.timeslot.timeslot.from) : null,
            stateUpdatedAt: o.state_updated_date ? new Date(o.state_updated_date) : null, items,
          };
          await prisma.ozonSupply.upsert({ where: { supplyId: String(s.supply_id) }, create: { supplyId: String(s.supply_id), ...v }, update: v });
        }
      }
      if (orders.length && older === orders.length) break outer;
    }
    if (!l.last_id) break;
    last = l.last_id;
  }
}

// ───────────── Фоновое обновление ─────────────

let lastSupplies = 0;
/** Отправления за последние 3 недели и поставки — в фоне (вызывается при открытии графиков и по расписанию) */
export function refreshChartsBg(force = false) {
  const today = todayMsk();
  kick('ads-postings', () => syncPostings(addDays(today, -HISTORY), today, force));
  if (force || Date.now() - lastSupplies > 3 * 3600_000) {
    lastSupplies = Date.now();
    kick('ads-supplies', () => syncSupplies());
  }
}

export function startChartsSync() {
  setTimeout(() => refreshChartsBg(), 90_000);
  setInterval(() => refreshChartsBg(), 3 * 3600_000);
}

// Остаток сейчас по кластерам (Ozon часто отвечает 500/429 — тогда без него)
const snapCache = new Map<string, { at: number; v: Map<string, number> | null }>();
async function stockNow(sku: string): Promise<Map<string, number> | null> {
  const c = snapCache.get(sku);
  if (c && Date.now() - c.at < 30 * 60_000) return c.v;
  let v: Map<string, number> | null = null;
  try {
    const r = await seller('/v1/analytics/stocks', { skus: [sku] });
    v = new Map();
    for (const it of r.items ?? []) {
      if (String(it.sku) !== sku || !it.cluster_name) continue;
      v.set(it.cluster_name, (v.get(it.cluster_name) ?? 0) + (it.available_stock_count ?? 0));
    }
  } catch (e) { console.warn('[ads charts stocks]', (e as Error).message); }
  snapCache.set(sku, { at: Date.now(), v });
  return v;
}

// ───────────── Данные графиков ─────────────

const ANCHOR_KEY = 'ads.stockAnchor';
export async function setStockAnchor(sku: string, date: string | null) {
  const m = await getSetting<Record<string, string>>(ANCHOR_KEY, {});
  if (date) m[sku] = date; else delete m[sku];
  await setSetting(ANCHOR_KEY, m);
}

/** Точка отсчёта остатков: последний день, когда FBO-отгрузок почти не было (≤ 10% обычного дня) —
 *  сток кончился везде, отгружались только возвраты и единичные остатки. Последние 3 дня не берём: данные дозревают. */
function autoAnchor(days: string[], ship: (d: string) => number): string | null {
  const vals = days.map(ship).filter((v) => v > 0).sort((x, y) => x - y);
  if (vals.length < 14) return null;
  const median = vals[Math.floor(vals.length / 2)];
  const limit = Math.max(2, median * 0.1);
  const cand = days.slice(0, -3).filter((d) => ship(d) <= limit);
  return cand.length ? cand[cand.length - 1] : null;
}

type P = { orderDay: string; qty: number; scheme: string; clusterFrom: string | null; clusterTo: string | null };

export async function getCharts(sku: string, from: string, to: string, force = false) {
  const today = todayMsk();
  const hist = addDays(today, -HISTORY);
  const anchors = await getSetting<Record<string, string>>(ANCHOR_KEY, {});
  const lo = [addDays(from, -4), hist, anchors[sku] ?? hist].sort()[0];

  // ждём Ozon, только если в базе ещё ничего нет; иначе — что есть, обновление в фоне
  if (ozonConfigured()) {
    const have = await prisma.adSyncDay.count({ where: { kind: 'postings', date: { gte: dt(lo) } } });
    if (!have) await track('ads-postings', () => syncPostings(lo, today));
    else if (lo < hist) kick('ads-postings', () => syncPostings(lo, today)); // период старше истории
    const sup = await prisma.ozonSupply.count();
    if (!sup) { lastSupplies = Date.now(); await track('ads-supplies', () => syncSupplies()).catch(() => {}); }
    refreshChartsBg(force);
  }

  const days = dateRange(from, to);
  const [skuDays, camDays, postingsRaw, supplies, meta, snap, alloc] = await Promise.all([
    prisma.adDaySku.findMany({ where: { sku, date: { gte: dt(from), lte: dt(to) } } }),
    prisma.adDayCampaign.findMany({ where: { sku, date: { gte: dt(from), lte: dt(to) } } }),
    prisma.ozonPosting.findMany({ where: { sku, orderDay: { gte: lo, lte: today }, NOT: { status: 'cancelled' } }, select: { orderDay: true, qty: true, scheme: true, clusterFrom: true, clusterTo: true } }),
    prisma.ozonSupply.findMany({ where: { createdAt: { gte: new Date(dt(lo).getTime() - 30 * DAY) } }, orderBy: { createdAt: 'asc' } }),
    campaignMeta().catch(() => null),
    stockNow(sku),
    allocatedCharges(from, to).catch(() => new Map<string, Map<string, number>>()),
  ]);
  const cpoBy = alloc.get(sku) ?? new Map<string, number>();
  const postings = postingsRaw as P[];

  // ── по дням
  const sd = new Map(skuDays.map((r) => [ymd(r.date), r]));
  const camByDay = new Map<string, typeof camDays>();
  for (const c of camDays) { const k = ymd(c.date); camByDay.set(k, [...(camByDay.get(k) ?? []), c]); }
  const ordersByDay = new Map<string, { fbo: number; fbs: number; loc: number }>();
  for (const p of postings) {
    const o = ordersByDay.get(p.orderDay) ?? { fbo: 0, fbs: 0, loc: 0 };
    if (p.scheme === 'FBO') o.fbo += p.qty; else o.fbs += p.qty;
    if (p.clusterFrom && p.clusterFrom === p.clusterTo) o.loc += p.qty;
    ordersByDay.set(p.orderDay, o);
  }
  const campTot = new Map<string, { clicks: number; spend: number }>();
  for (const c of camDays) { const t = campTot.get(c.campaignId) ?? { clicks: 0, spend: 0 }; t.clicks += c.clicks; t.spend += c.spend; campTot.set(c.campaignId, t); }
  const titles = new Map((meta?.cpcAll ?? []).map((c) => [c.id, c.title]));
  const campaigns = [...campTot].filter(([, t]) => t.clicks > 0)
    .map(([id, t]) => ({ id, title: titles.get(id) ?? `Кампания ${id}`, clicks: t.clicks, spend: Math.round(t.spend), cpc: r1(t.spend / t.clicks) }))
    .sort((a, b) => b.spend - a.spend);

  const series = days.map((d) => {
    const s = sd.get(d);
    const cs = camByDay.get(d) ?? [];
    const sum = (k: 'views' | 'clicks' | 'toCart' | 'orders' | 'spend') => cs.reduce((t, x) => t + x[k], 0);
    const o = ordersByDay.get(d) ?? { fbo: 0, fbs: 0, loc: 0 };
    // локальные заказы — скользящее за 5 дней, включая дни до начала периода
    let n5 = 0; let l5 = 0;
    for (let k = 0; k < 5; k++) { const x = ordersByDay.get(addDays(d, -k)); if (x) { n5 += x.fbo + x.fbs; l5 += x.loc; } }
    const cpcBy: Record<string, number | null> = {};
    for (const c of campaigns) {
      const x = cs.filter((r) => r.campaignId === c.id);
      const cl = x.reduce((t, r) => t + r.clicks, 0);
      cpcBy[c.id] = cl > 0 ? r1(x.reduce((t, r) => t + r.spend, 0) / cl) : null;
    }
    const adViews = sum('views'); const adCart = sum('toCart'); const adClicks = sum('clicks'); const spend = sum('spend');
    const sale = s?.accrSale ?? 0; const buyer = s?.accrBuyer ?? 0; const q = s?.accrQty ?? 0;
    return {
      date: d,
      orders: s?.orders ?? 0, // аналитика Ozon (ordered_units)
      fbo: o.fbo, fbs: o.fbs, loc: o.loc,
      local: n5 > 0 ? r1(l5 / n5 * 100) : null,
      views: s?.views ?? 0, toCart: s?.toCart ?? 0,
      adViews, adClicks, adCart, adOrders: sum('orders'),
      orgViews: Math.max(0, (s?.views ?? 0) - adViews),
      orgCart: Math.max(0, (s?.toCart ?? 0) - adCart),
      spend: Math.round(spend),
      // оплата за заказ — списания из начислений, распределённые по выручке товаров
      spendCpo: Math.round((cpoBy.get(`${d}|sel`) ?? 0) + (cpoBy.get(`${d}|all`) ?? 0)),
      cpc: adClicks > 0 ? r1(spend / adClicks) : null, cpcBy,
      // СПП — скидка за счёт Ozon от цены продавца; по начислениям дня (FBO — после выкупа)
      spp: sale > 0 && buyer > 0 && q > 0 ? r1((sale - buyer) / sale * 100) : null,
      buyerPrice: sale > 0 && buyer > 0 && q > 0 ? Math.round(buyer / q) : null,
    };
  });

  // ── кластеры: отгрузки FBO со складов кластера по дням (вся история — для остатков)
  const histDays = dateRange(lo, today);
  const ship = new Map<string, Map<string, number>>(); // кластер → день → шт
  const shipAll = new Map<string, number>();
  for (const p of postings) {
    if (p.scheme !== 'FBO' || !p.clusterFrom) continue;
    const m = ship.get(p.clusterFrom) ?? new Map<string, number>();
    m.set(p.orderDay, (m.get(p.orderDay) ?? 0) + p.qty);
    ship.set(p.clusterFrom, m);
    shipAll.set(p.orderDay, (shipAll.get(p.orderDay) ?? 0) + p.qty);
  }
  const shipOf = (c: string, d: string) => ship.get(c)?.get(d) ?? 0;

  // поставки этого SKU: кластер, слот, дата завершения
  const sups = supplies.flatMap((s) => {
    const qty = (s.items as { sku: string; qty: number }[]).filter((i) => i.sku === sku).reduce((t, i) => t + i.qty, 0);
    if (!qty || !s.clusterName) return [];
    const slot = mskDay(s.timeslotFrom ?? s.createdAt);
    const done = ARRIVED.includes(s.state) && s.stateUpdatedAt ? mskDay(s.stateUpdatedAt) : null;
    const accepting = s.state === 'ACCEPTANCE_AT_STORAGE_WAREHOUSE';
    return [{ cluster: s.clusterName, qty, slot, done, accepting }];
  });

  const manual = anchors[sku] ?? null;
  const auto = autoAnchor(histDays.filter((d) => d < today), (d) => shipAll.get(d) ?? 0);
  const anchor = manual ?? auto;
  const clusterSet = new Set<string>([...ship.keys(), ...sups.map((s) => s.cluster), ...(snap ? [...snap.keys()] : [])]);
  for (const p of postings) if (p.clusterTo && p.orderDay >= from && p.orderDay <= to) clusterSet.add(p.clusterTo);

  // stock: кластер → день → шт (на конец дня), arrived: кластер → день → шт
  const stock = new Map<string, Map<string, number>>();
  const arrived = new Map<string, Map<string, number>>();
  let method: 'anchor' | 'snapshot' | null = null;
  // заказы покупателей кластера по дням (любая схема) — признак «стока нет»: покупатели заказывали, а со складов кластера не отгрузили ничего
  const buyers = new Map<string, Map<string, number>>();
  for (const p of postings) {
    if (!p.clusterTo) continue;
    const m = buyers.get(p.clusterTo) ?? new Map<string, number>();
    m.set(p.orderDay, (m.get(p.orderDay) ?? 0) + p.qty);
    buyers.set(p.clusterTo, m);
  }
  const stockout = (c: string, d: string) => shipOf(c, d) === 0 && (buyers.get(c)?.get(d) ?? 0) >= 3;

  if (anchor) {
    method = 'anchor';
    for (const c of clusterSet) {
      // Вперёд от точки отсчёта: + поставки − отгрузки. Начальный остаток — минимальный, при котором хватило бы на отгрузки
      // до первого подтверждённого «стока нет» (если кластер к точке отсчёта ещё не опустел).
      const run = (s0: number) => {
        const st = new Map<string, number>(); const ar = new Map<string, number>();
        const pending = sups.filter((s) => s.cluster === c && !(s.done && s.done <= anchor)).map((s) => ({ ...s, applied: false }));
        let v = s0; let deficit = 0; let confirmed = false; let lastZero = anchor;
        st.set(anchor, v);
        for (const d of dateRange(addDays(anchor, 1), today)) {
          const apply = (s: (typeof pending)[number]) => { s.applied = true; v += s.qty; ar.set(d, (ar.get(d) ?? 0) + s.qty); };
          for (const s of pending) if (!s.applied && s.done && s.done <= d) apply(s);
          v -= shipOf(c, d);
          // отгрузили больше, чем было, — значит, приехала ближайшая поставка, у которой прошёл слот
          while (v < 0) {
            const s = pending.find((x) => !x.applied && x.slot <= d && (x.done || x.accepting));
            if (!s) break;
            apply(s);
          }
          if (v < 0) { if (!confirmed) deficit -= v; v = 0; }
          // стока точно не было — оценка сбрасывается, ошибка не копится (кроме дней прихода: товар ещё принимают)
          if (stockout(c, d) && !ar.has(d) && !ar.has(addDays(d, -1))) { v = 0; confirmed = true; lastZero = d; }
          st.set(d, v);
        }
        return { st, ar, deficit, lastZero };
      };
      const first = run(0);
      const { st, ar, lastZero } = first.deficit > 0 ? run(first.deficit) : first;
      // Сверка с текущим остатком Ozon: расхождение (в основном возвраты покупателей) распределяем
      // пропорционально отгрузкам от последнего «стока нет» до сегодня — сегодняшняя оценка совпадает с Ozon
      const now = snap?.get(c);
      if (now != null) {
        const diff = now - (st.get(today) ?? 0);
        const tail = dateRange(addDays(lastZero, 1), today).filter((d) => d > anchor);
        const total = tail.reduce((t, d) => t + shipOf(c, d), 0);
        let acc = 0;
        tail.forEach((d, i) => {
          acc += total > 0 ? shipOf(c, d) : 1;
          const k = acc / (total > 0 ? total : tail.length);
          st.set(d, Math.max(0, Math.round((st.get(d) ?? 0) + diff * k)));
          if (i === tail.length - 1) st.set(d, now);
        });
      }
      // до точки отсчёта — назад от неё: + отгрузки − поставки
      let v = st.get(anchor) ?? 0;
      const before = histDays.filter((d) => d <= anchor);
      for (const s of sups.filter((x) => x.cluster === c && x.done && x.done <= anchor)) {
        const firstShip = before.find((d) => d >= s.slot && shipOf(c, d) > 0);
        const day = firstShip && firstShip < s.done! ? firstShip : s.done!;
        ar.set(day, (ar.get(day) ?? 0) + s.qty);
      }
      for (let i = before.length - 1; i > 0; i--) {
        const d = before[i];
        v = Math.max(0, v + shipOf(c, d) - (ar.get(d) ?? 0));
        st.set(before[i - 1], stockout(c, before[i - 1]) ? 0 : v);
        if (stockout(c, before[i - 1])) v = 0;
      }
      stock.set(c, st); arrived.set(c, ar);
    }
  } else if (snap) {
    // нет точки отсчёта — восстанавливаем назад от текущего остатка
    method = 'snapshot';
    for (const c of clusterSet) {
      const st = new Map<string, number>(); const ar = new Map<string, number>();
      for (const s of sups.filter((x) => x.cluster === c)) {
        const first = histDays.find((d) => d >= s.slot && shipOf(c, d) > 0);
        const day = first && (!s.done || first < s.done) ? first : s.done;
        if (day) ar.set(day, (ar.get(day) ?? 0) + s.qty);
      }
      let v = snap.get(c) ?? 0;
      for (let i = histDays.length - 1; i >= 0; i--) {
        const d = histDays[i];
        st.set(d, Math.max(0, v) <= 1 ? 0 : Math.round(v));
        v = v + shipOf(c, d) - (ar.get(d) ?? 0);
      }
      stock.set(c, st); arrived.set(c, ar);
    }
  }

  // заказы покупателей кластера за период
  const per = new Map<string, Map<string, { own: number; other: number }>>();
  const tot = new Map<string, { total: number; local: number }>();
  const fromAgg = new Map<string, number>();
  for (const p of postings) {
    if (p.orderDay < from || p.orderDay > to) continue;
    const c = p.clusterTo ?? 'Не указан';
    const m = per.get(c) ?? new Map(); per.set(c, m);
    const x = m.get(p.orderDay) ?? { own: 0, other: 0 };
    const own = !!p.clusterFrom && p.clusterFrom === p.clusterTo;
    if (own) x.own += p.qty; else x.other += p.qty;
    m.set(p.orderDay, x);
    const t = tot.get(c) ?? { total: 0, local: 0 }; t.total += p.qty; if (own) t.local += p.qty; tot.set(c, t);
    const k = `${p.scheme}|${p.clusterFrom ?? 'Не указан'}`;
    fromAgg.set(k, (fromAgg.get(k) ?? 0) + p.qty);
  }

  const names = new Set<string>([...per.keys()]);
  // кластеры без заказов за период, но со стоком или поставками — тоже показываем
  for (const c of clusterSet) {
    const st = stock.get(c);
    if (days.some((d) => (st?.get(d) ?? 0) > 0 || (arrived.get(c)?.get(d) ?? 0) > 0 || shipOf(c, d) > 0)) names.add(c);
  }
  const clusters = [...names].map((name) => {
    const st = stock.get(name); const ar = arrived.get(name); const m = per.get(name);
    const t = tot.get(name) ?? { total: 0, local: 0 };
    return {
      name, total: t.total, local: t.local,
      supplied: days.reduce((s, d) => s + (ar?.get(d) ?? 0), 0),
      stockEst: st?.get(today) ?? null,
      stockNow: snap ? (snap.get(name) ?? 0) : null,
      days: days.map((d) => ({
        own: m?.get(d)?.own ?? 0, other: m?.get(d)?.other ?? 0, ship: shipOf(name, d),
        stock: st && st.has(d) ? st.get(d)! : null, sup: ar?.get(d) ?? 0,
      })),
    };
  }).sort((a, b) => b.total - a.total || (b.stockEst ?? 0) - (a.stockEst ?? 0));

  const shippedFrom = [...fromAgg].map(([k, qty]) => { const [scheme, cluster] = k.split('|'); return { scheme, cluster, qty }; }).sort((a, b) => b.qty - a.qty);

  return {
    sku, from, to, today, series, campaigns, clusters, shippedFrom,
    stock: { method, anchor, manual: manual != null, auto, snapshot: snap != null },
  };
}
