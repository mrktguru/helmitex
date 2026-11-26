import prisma from '../prisma/client';
import { kick, track } from './syncStatus';
import { ozonCall, ozonConfigured, sleep } from './ozon';
import { dateRange, todayMsk, ymd } from './ads';

// Поисковые запросы товаров: позиция в выдаче, поиски, просмотры, заказы — снимок по дням.
// Ozon (/v1/analytics/product-queries/details) отдаёт до 15 запросов на товар за одну сортировку,
// поэтому берём объединение нескольких сортировок — ~45–50 запросов в день. История у Ozon — около 5 недель.

const DAY = 86_400_000;
const HISTORY = 36;
const dt = (s: string) => new Date(s + 'T00:00:00Z');
const addDays = (s: string, n: number) => ymd(new Date(dt(s).getTime() + n * DAY));
// сортировки, которые дают новые запросы (проверено: остальные повторяют эти)
const SORTS: [string, string][] = [
  ['BY_SEARCHES', 'DESCENDING'], ['BY_SEARCHES', 'ASCENDING'], ['BY_VIEWS', 'DESCENDING'],
  ['BY_POSITION', 'DESCENDING'], ['BY_POSITION', 'ASCENDING'], ['BY_CONVERSION', 'DESCENDING'], ['BY_CONVERSION', 'ASCENDING'],
];

async function call<T = any>(body: unknown): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await ozonCall<T>('POST', '/v1/analytics/product-queries/details', body, undefined, false); } catch (e) {
      if (i < 3 && /лимит/.test((e as Error).message)) { await sleep(20_000 * (i + 1)); continue; }
      throw e;
    }
  }
}

export async function querySkus(): Promise<string[]> {
  const specs = await prisma.productSpec.findMany({ where: { ozonSku: { not: null }, item: { archived: false } }, select: { ozonSku: true } });
  return [...new Set(specs.map((s) => s.ozonSku!))];
}

async function fetchDay(day: string, skus: string[]) {
  const rows = new Map<string, { date: Date; sku: string; query: string; position: number | null; searches: number; viewers: number; orders: number; gmv: number; conversion: number | null }>();
  for (const [sort_by, sort_dir] of SORTS) {
    const r = await call({ date_from: `${day}T00:00:00Z`, date_to: `${day}T23:59:59Z`, skus, page: 0, page_size: 100, limit_by_sku: 15, sort_by, sort_dir });
    for (const q of r.queries ?? []) {
      const sku = String(q.sku); const query = String(q.query ?? '').trim();
      if (!query) continue;
      rows.set(`${sku}|${query}`, {
        date: dt(day), sku, query, position: q.position ? Number(q.position) : null,
        searches: Number(q.unique_search_users) || 0, viewers: Number(q.unique_view_users) || 0,
        orders: Number(q.order_count) || 0, gmv: Number(q.gmv) || 0, conversion: q.view_conversion != null ? Number(q.view_conversion) : null,
      });
    }
  }
  return [...rows.values()];
}

/** Загрузить дни, которых нет, и обновить последние 2 дня (данные за них дозревают) */
export async function syncQueries(force = false) {
  if (!ozonConfigured()) return;
  const skus = await querySkus();
  if (!skus.length) return;
  const today = todayMsk();
  const days = dateRange(addDays(today, -HISTORY), today);
  const got = new Map((await prisma.adSyncDay.findMany({ where: { kind: 'queries', date: { in: days.map(dt) } } })).map((r) => [ymd(r.date), r.fetchedAt.getTime()]));
  const stale = days.filter((d) => {
    const at = got.get(d);
    if (force || at == null) return true;
    return d >= addDays(today, -2) && Date.now() - at > 3 * 3600_000;
  });
  for (const d of stale.reverse()) { // свежие дни — первыми
    let rows: Awaited<ReturnType<typeof fetchDay>> = [];
    try { rows = await fetchDay(d, skus); } catch (e) {
      // за дни старше окна Ozon отвечает «There is no data» — отмечаем день, чтобы не спрашивать снова
      if (!/no data/i.test((e as Error).message)) throw e;
    }
    await prisma.$transaction([
      prisma.adQueryDay.deleteMany({ where: { date: dt(d), sku: { in: skus } } }),
      prisma.adQueryDay.createMany({ data: rows, skipDuplicates: true }),
    ]);
    await prisma.adSyncDay.upsert({ where: { kind_date: { kind: 'queries', date: dt(d) } }, create: { kind: 'queries', date: dt(d) }, update: { fetchedAt: new Date() } });
  }
}

export function refreshQueriesBg(force = false) { kick('ads-queries', () => syncQueries(force)); }
export function startQueriesSync() {
  setTimeout(() => refreshQueriesBg(), 120_000);
  setInterval(() => refreshQueriesBg(), 3 * 3600_000);
}

/** Средняя позиция товара за день по всем запросам, взвешенная по числу поисков */
export function weightedPosition(rows: { position: number | null; searches: number }[]): number | null {
  let w = 0, s = 0;
  for (const r of rows) if (r.position != null && r.position > 0) { const k = Math.max(1, r.searches); w += k; s += r.position * k; }
  return w ? Math.round(s / w * 10) / 10 : null;
}

export async function getQueries(sku: string, from: string, to: string) {
  if (ozonConfigured()) {
    const have = await prisma.adSyncDay.count({ where: { kind: 'queries' } });
    if (!have) await track('ads-queries', () => syncQueries()).catch(() => {});
    else refreshQueriesBg();
  }
  const days = dateRange(from, to);
  const rows = await prisma.adQueryDay.findMany({ where: { sku, date: { gte: dt(from), lte: dt(to) } }, orderBy: { date: 'asc' } });
  const byQ = new Map<string, typeof rows>();
  for (const r of rows) byQ.set(r.query, [...(byQ.get(r.query) ?? []), r]);
  const firstDay = rows.length ? ymd(rows[0].date) : null;

  const queries = [...byQ].map(([query, rs]) => {
    const pos = rs.filter((r) => r.position != null && r.position > 0);
    const byDay = new Map(rs.map((r) => [ymd(r.date), r]));
    const last = pos[pos.length - 1];
    return {
      query,
      searches: rs.reduce((t, r) => t + r.searches, 0),
      viewers: rs.reduce((t, r) => t + r.viewers, 0),
      orders: rs.reduce((t, r) => t + r.orders, 0),
      gmv: Math.round(rs.reduce((t, r) => t + r.gmv, 0)),
      daysSeen: rs.length,
      position: weightedPosition(rs),
      best: pos.length ? Math.min(...pos.map((r) => r.position!)) : null,
      last: last ? { date: ymd(last.date), position: last.position } : null,
      series: days.map((d) => { const r = byDay.get(d); return r ? { position: r.position, searches: r.searches, orders: r.orders } : null; }),
    };
  }).sort((a, b) => b.searches - a.searches);

  // по дням: средняя позиция по всем запросам и сколько запросов видно
  const daily = days.map((d) => {
    const rs = rows.filter((r) => ymd(r.date) === d);
    return { date: d, position: weightedPosition(rs), queries: rs.length, searches: rs.reduce((t, r) => t + r.searches, 0), orders: rs.reduce((t, r) => t + r.orders, 0) };
  });
  // рекламный расход товара по дням — чтобы видеть связь позиции и рекламы
  const ad = await prisma.adDayCampaign.groupBy({ by: ['date'], where: { sku, date: { gte: dt(from), lte: dt(to) } }, _sum: { spend: true, views: true } });
  const adBy = new Map(ad.map((a) => [ymd(a.date), a._sum]));
  return {
    sku, from, to, firstDay, days,
    daily: daily.map((x) => ({ ...x, adSpend: Math.round(adBy.get(x.date)?.spend ?? 0), adViews: adBy.get(x.date)?.views ?? 0 })),
    queries,
  };
}
