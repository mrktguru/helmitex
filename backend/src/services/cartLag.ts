import prisma from '../prisma/client';
import { kick } from './syncStatus';
import { increments, lastFullDay, todayMsk, ymd } from './ads';
import { syncPostings } from './adsCharts';

// «Отложенные корзины»: через сколько после добавления в корзину приходит заказ.
// Ozon не связывает корзину и заказ одного покупателя, поэтому лаг оценивается тремя независимыми способами:
//  1. все корзины → все заказы по дням (аналитика продавца): заказы дня = база по дню недели + K × Σ wᵢ·корзины(t−i);
//  2. рекламная атрибуция Ozon: заказы кампании идут по дню заказа (не клика) — та же модель на рекламных корзинах,
//     плюс «хвосты» остановленных кампаний: заказы после последнего клика прямо показывают долю поздних заказов;
//  3. по часам: снимки рекламы каждые 30 минут и время каждого отправления.
// Распределение лага w — «доля в день 0» + геометрический хвост (2 параметра, подбор по сетке): устойчиво к шуму,
// в отличие от свободных коэффициентов, которые на дневных данных скачут и уходят в минус.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const dt = (s: string) => new Date(s + 'T00:00:00Z');
const addDays = (s: string, n: number) => ymd(new Date(dt(s).getTime() + n * DAY));
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const MATURE_DAYS = 3; // аналитика Ozon дозаполняет корзины ~3 дня — свежие дни в подбор модели не берём

// ───────────── Подбор распределения лага ─────────────

export interface LagFit {
  k: number; // заказов на одну корзину (из корзин)
  w: number[]; // доля заказов с задержкой i (сумма = 1)
  p0: number; r: number; // параметры формы
  base: number[]; // база без корзин: по дням недели (7, вс=0), константа (1) или []
  r2: number; n: number;
  fromCarts: number; // доля заказов, объяснённая корзинами
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    if (Math.abs(M[p][i]) < 1e-12) return null;
    [M[i], M[p]] = [M[p], M[i]];
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i] / M[i][i];
      if (f) for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function lagWeights(p0: number, r: number, L: number): number[] {
  const w = [p0];
  const norm = r > 0 ? 1 - r ** L : 1;
  for (let i = 1; i <= L; i++) w.push(((1 - p0) * (1 - r) * r ** (i - 1)) / norm);
  return w;
}

const P0 = Array.from({ length: 51 }, (_, i) => i / 50);
const RS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97];

/**
 * y[t] — заказы, x[t] — корзины (null — нет данных). groups[t] — группа базы (день недели, 0 — константа).
 * baseKind: 'dow' — 7 баз по дням недели, 'const' — одна, 'none' — без базы (все заказы из корзин).
 */
export function fitLag(y: (number | null)[], x: (number | null)[], L: number, baseKind: 'dow' | 'const' | 'none', groups?: number[]): LagFit | null {
  const rows: number[] = [];
  for (let t = L; t < y.length; t++) {
    if (y[t] == null) continue;
    let ok = true;
    for (let i = 0; i <= L; i++) if (x[t - i] == null) { ok = false; break; }
    if (ok) rows.push(t);
  }
  const nb = baseKind === 'dow' ? 7 : baseKind === 'const' ? 1 : 0;
  if (rows.length < Math.max(20, 3 * (nb + 3))) return null;
  const g = (t: number) => (baseKind === 'dow' ? groups![t] : 0);
  const ys = rows.map((t) => y[t]!);
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sst = ys.reduce((a, v) => a + (v - mean) ** 2, 0) || 1;

  let best: { sse: number; k: number; base: number[]; p0: number; r: number; w: number[] } | null = null;
  for (const r of RS) {
    for (const p0 of P0) {
      if (r > 0 && p0 === 1) continue; // при p0 = 1 хвоста нет — r не важен, считаем один раз
      const w = lagWeights(p0, r, L);
      const z = rows.map((t) => { let s = 0; for (let i = 0; i <= L; i++) s += w[i] * x[t - i]!; return s; });
      // y = K·z + base[g]
      const n = 1 + nb;
      const A = Array.from({ length: n }, () => new Array(n).fill(0));
      const b = new Array(n).fill(0);
      rows.forEach((t, j) => {
        const f = new Array(n).fill(0);
        f[0] = z[j];
        if (nb) f[1 + g(t)] = 1;
        for (let a = 0; a < n; a++) { b[a] += f[a] * ys[j]; for (let c = 0; c < n; c++) A[a][c] += f[a] * f[c]; }
      });
      // пустые группы (дня недели нет в выборке) — фиксируем базу нулём
      for (let a = 1; a < n; a++) if (A[a][a] === 0) A[a][a] = 1;
      const sol = solve(A, b);
      if (!sol || sol[0] < 0) continue;
      let sse = 0;
      rows.forEach((t, j) => { const e = ys[j] - sol[0] * z[j] - (nb ? sol[1 + g(t)] : 0); sse += e * e; });
      if (!best || sse < best.sse) best = { sse, k: sol[0], base: sol.slice(1), p0, r, w };
    }
  }
  if (!best) return null;
  const fromCarts = rows.reduce((t, row, j) => { let s = 0; for (let i = 0; i <= L; i++) s += best!.w[i] * x[row - i]!; return t + best!.k * s; }, 0) / (ys.reduce((a, b) => a + b, 0) || 1);
  return { k: r3(best.k), w: best.w.map(r3), p0: best.p0, r: best.r, base: best.base.map(r2), r2: r2(1 - best.sse / sst), n: rows.length, fromCarts: r2(fromCarts) };
}

// Средняя задержка и медиана распределения (в единицах шага)
function lagStats(w: number[]) {
  const mean = w.reduce((t, v, i) => t + v * i, 0);
  let acc = 0; let median = 0;
  for (let i = 0; i < w.length; i++) { acc += w[i]; if (acc >= 0.5) { median = i; break; } }
  return { mean: r2(mean), median };
}

// ───────────── Данные ─────────────

// Кампании, где этот SKU даёт ≥ 90% кликов (снимки кампании можно целиком отнести к товару)
async function skuCampaigns(sku: string): Promise<string[]> {
  const since = dt(addDays(todayMsk(), -120));
  const rows = await prisma.adDayCampaign.groupBy({ by: ['campaignId', 'sku'], where: { date: { gte: since } }, _sum: { clicks: true, orders: true } });
  const tot = new Map<string, number>();
  for (const r of rows) tot.set(r.campaignId, (tot.get(r.campaignId) ?? 0) + (r._sum.clicks ?? 0) + (r._sum.orders ?? 0));
  return rows.filter((r) => r.sku === sku && ((r._sum.clicks ?? 0) + (r._sum.orders ?? 0)) >= 0.9 * (tot.get(r.campaignId) || Infinity)).map((r) => r.campaignId);
}

let backfillAsked = 0;
// Время заказа у отправлений появилось позже — один раз перезагружаем историю отправлений в фоне
async function ensurePostingTimes() {
  if (Date.now() - backfillAsked < 6 * HOUR) return;
  const missing = await prisma.ozonPosting.count({ where: { orderAt: null } });
  if (!missing) return;
  backfillAsked = Date.now();
  const first = await prisma.ozonPosting.findFirst({ where: { orderAt: null }, orderBy: { orderDay: 'asc' }, select: { orderDay: true } });
  kick('ads-postings', () => syncPostings(first?.orderDay ?? addDays(todayMsk(), -150), todayMsk(), true));
}

export async function getCartLag(sku: string, days: number) {
  ensurePostingTimes().catch((e) => console.warn('[cart lag] postings', (e as Error).message));
  const last = lastFullDay();
  const today = todayMsk();
  const from = addDays(last, -(days - 1));
  const dates: string[] = [];
  for (let d = addDays(from, -30); d <= last; d = addDays(d, 1)) dates.push(d); // +30 дней истории под лаги
  const idx = new Map(dates.map((d, i) => [d, i]));

  // 1. Все корзины и заказы по дням
  const skuDays = await prisma.adDaySku.findMany({ where: { sku, date: { gte: dt(dates[0]), lte: dt(last) } } });
  const cart: (number | null)[] = dates.map(() => null);
  const ord: (number | null)[] = dates.map(() => null);
  for (const r of skuDays) { const i = idx.get(ymd(r.date)); if (i != null) { cart[i] = r.toCart; ord[i] = r.orders; } }
  const mature = addDays(last, -MATURE_DAYS + 1); // дни ≥ mature ещё дозаполняются
  const ordFit = ord.map((v, i) => (dates[i] < from || dates[i] >= mature ? null : v));
  const dow = dates.map((d) => dt(d).getUTCDay());
  const L1 = 14;
  const total = fitLag(ordFit, cart, L1, 'dow', dow);

  // 2. Реклама: корзины и заказы кампаний (атрибуция Ozon — по дню заказа)
  const adRows = await prisma.adDayCampaign.groupBy({ by: ['date'], where: { sku, date: { gte: dt(dates[0]), lte: dt(last) } }, _sum: { clicks: true, toCart: true, orders: true } });
  const perfLoaded = new Set((await prisma.adSyncDay.findMany({ where: { kind: 'perf', date: { gte: dt(dates[0]), lte: dt(last) } }, select: { date: true } })).map((r) => ymd(r.date)));
  const adCart: (number | null)[] = dates.map((d) => (perfLoaded.has(d) ? 0 : null));
  const adOrd: (number | null)[] = dates.map((d) => (perfLoaded.has(d) ? 0 : null));
  const adClicks: (number | null)[] = dates.map((d) => (perfLoaded.has(d) ? 0 : null));
  for (const r of adRows) {
    const i = idx.get(ymd(r.date));
    if (i == null) continue;
    adCart[i] = r._sum.toCart ?? 0; adOrd[i] = r._sum.orders ?? 0; adClicks[i] = r._sum.clicks ?? 0;
  }
  const L2 = 21;
  const adOrdFit = adOrd.map((v, i) => (dates[i] < from ? null : v));
  // с базой: часть рекламных заказов Ozon приписывает кликам старше окна или без рекламной корзины
  const ad = adCart.some((v) => v) ? fitLag(adOrdFit, adCart, L2, 'const') : null;

  // 2б. Хвосты остановленных кампаний
  const tails = await stopTails(sku);

  // Разложение заказов дня по модели 1: база / корзины этого дня / корзины прошлых дней
  const show = dates.filter((d) => d >= from);
  const parts = show.map((d) => {
    const t = idx.get(d)!;
    let same = 0; let prev = 0; let complete = true;
    if (total) {
      for (let i = 0; i <= L1; i++) {
        const c = cart[t - i];
        if (c == null) { complete = false; continue; }
        if (i === 0) same = total.k * total.w[0] * c; else prev += total.k * total.w[i] * c;
      }
    }
    return {
      date: d, orders: ord[t], carts: cart[t], adCarts: adCart[t], adOrders: adOrd[t], adClicks: adClicks[t],
      base: total ? r2(total.base[dow[t]]) : null, fromSame: total && complete ? r2(same) : null, fromPrev: total && complete ? r2(prev) : null,
      fitted: total && complete ? r2(total.base[dow[t]] + same + prev) : null, fresh: d >= mature,
    };
  });

  // Отложенные корзины: сколько заказов ещё ожидается от корзин последних дней (по каждой модели)
  const pendingOf = (fit: LagFit | null, x: (number | null)[], L: number) => {
    if (!fit) return null;
    const list: { date: string; carts: number; expected: number; arrived: number; pending: number }[] = [];
    for (let a = 0; a <= L; a++) {
      const t = dates.length - 1 - a;
      if (t < 0 || x[t] == null) continue;
      const cum = fit.w.slice(0, a + 1).reduce((s, v) => s + v, 0);
      const exp = fit.k * x[t]!;
      list.push({ date: dates[t], carts: x[t]!, expected: r2(exp), arrived: r2(exp * cum), pending: r2(exp * (1 - cum)) });
    }
    return { days: list.reverse(), pending: r2(list.reduce((s, v) => s + v.pending, 0)) };
  };

  // 3. По часам
  const hourly = await hourlyLag(sku);

  return {
    sku, from, to: last, today, matureFrom: mature,
    total: total && { ...total, ...lagStats(total.w) },
    ad: ad && { ...ad, ...lagStats(ad.w) },
    tails,
    series: parts,
    pending: { total: pendingOf(total, cart, L1), ad: pendingOf(ad, adCart, L2) },
    hourly,
  };
}

// ───────────── Хвосты остановленных кампаний ─────────────
// Остановка: до неё ≥ 14 дней с кликами (в среднем ≥ 30 в день), после — ≥ 5 дней почти без кликов.
// Заказы после остановки ÷ средние заказы в день до неё = доля заказов, пришедших позже j дней (S(j) = Σ_{i≥j} wᵢ).
async function stopTails(sku: string) {
  const rows = await prisma.adDayCampaign.findMany({ where: { sku }, orderBy: { date: 'asc' }, select: { campaignId: true, date: true, clicks: true, orders: true } });
  const perfDays = new Set((await prisma.adSyncDay.findMany({ where: { kind: 'perf' }, select: { date: true } })).map((r) => ymd(r.date)));
  const lastPerf = [...perfDays].sort().pop();
  if (!lastPerf) return { events: [], curve: [] };
  const byCamp = new Map<string, Map<string, { clicks: number; orders: number }>>();
  for (const r of rows) {
    const m = byCamp.get(r.campaignId) ?? new Map();
    m.set(ymd(r.date), { clicks: r.clicks, orders: r.orders });
    byCamp.set(r.campaignId, m);
  }
  const H = 21;
  const events: { campaignId: string; stop: string; avgClicks: number; avgOrders: number; tail: (number | null)[] }[] = [];
  for (const [cid, m] of byCamp) {
    const ds = [...m.keys()].sort();
    const get = (d: string) => m.get(d) ?? (perfDays.has(d) ? { clicks: 0, orders: 0 } : null);
    for (let d = ds[0]; d <= lastPerf; d = addDays(d, 1)) {
      const cur = get(d);
      if (!cur || cur.clicks <= 0) continue;
      const before = Array.from({ length: 14 }, (_, i) => get(addDays(d, -1 - i)));
      if (before.some((x) => !x)) continue;
      const avgClicks = before.reduce((t, x) => t + x!.clicks, 0) / 14;
      const avgOrders = before.reduce((t, x) => t + x!.orders, 0) / 14;
      if (avgClicks < 30 || avgOrders < 3) continue; // на 1–2 заказах в день хвост — шум
      const quiet = Math.max(2, avgClicks * 0.03);
      const after = Array.from({ length: 5 }, (_, i) => get(addDays(d, 1 + i)));
      if (after.some((x) => !x || x.clicks > quiet)) continue;
      const tail: (number | null)[] = [];
      for (let j = 1; j <= H; j++) {
        const x = get(addDays(d, j));
        if (!x || x.clicks > quiet || addDays(d, j) > lastPerf) break;
        tail.push(r3(x.orders / avgOrders));
      }
      events.push({ campaignId: cid, stop: d, avgClicks: Math.round(avgClicks), avgOrders: r2(avgOrders), tail });
      d = addDays(d, tail.length); // следующая остановка — после этого хвоста
    }
  }
  // Средняя кривая: взвешенно по заказам до остановки
  const curve: { day: number; share: number | null; events: number }[] = [];
  for (let j = 1; j <= H; j++) {
    const ev = events.filter((e) => e.tail.length >= j);
    const wsum = ev.reduce((t, e) => t + e.avgOrders, 0);
    curve.push({ day: j, share: wsum ? r3(ev.reduce((t, e) => t + e.tail[j - 1]! * e.avgOrders, 0) / wsum) : null, events: ev.length });
  }
  return { events: events.sort((a, b) => b.stop.localeCompare(a.stop)), curve };
}

// ───────────── По часам ─────────────

async function hourlyLag(sku: string) {
  const camps = await skuCampaigns(sku);
  const snaps = camps.length ? await prisma.adIntraday.findMany({ where: { campaignId: { in: camps } }, orderBy: { at: 'asc' } }) : [];
  const byCamp = new Map<string, typeof snaps>();
  for (const s of snaps) { const a = byCamp.get(s.campaignId) ?? []; a.push(s); byCamp.set(s.campaignId, a); }
  const hourKey = (t: Date) => Math.floor((t.getTime() - 120_000) / HOUR); // прирост снимка — за время до него
  const cartH = new Map<number, number>(); const ordH = new Map<number, number>(); const seen = new Set<number>();
  for (const list of byCamp.values()) {
    for (const s of increments(list)) {
      const h = hourKey(s.at);
      seen.add(h);
      cartH.set(h, (cartH.get(h) ?? 0) + s.toCart);
      ordH.set(h, (ordH.get(h) ?? 0) + s.orders);
    }
  }
  const hs = [...seen].sort((a, b) => a - b);
  let ad: (LagFit & { mean: number; median: number }) | null = null;
  let collectedDays = 0;
  if (hs.length) {
    const h0 = hs[0]; const h1 = hs[hs.length - 1];
    const x: (number | null)[] = []; const y: (number | null)[] = [];
    for (let h = h0; h <= h1; h++) { const has = seen.has(h); x.push(has ? cartH.get(h) ?? 0 : null); y.push(has ? ordH.get(h) ?? 0 : null); }
    collectedDays = Math.round((hs.length / 24) * 10) / 10;
    const f = fitLag(y, x, 48, 'const');
    if (f) ad = { ...f, ...lagStats(f.w) };
  }

  // Профиль суток (МСК) за последние 28 дней: доля корзин и заказов по часам
  const since = new Date(Date.now() - 28 * DAY);
  const mskHour = (t: Date) => new Date(t.getTime() + 3 * HOUR).getUTCHours();
  const prof = Array.from({ length: 24 }, (_, h) => ({ hour: h, adCart: 0, adOrders: 0, orders: 0, carts: 0 }));
  for (const h of hs) {
    const t = new Date(h * HOUR);
    if (t < since) continue;
    prof[mskHour(t)].adCart += cartH.get(h) ?? 0;
    prof[mskHour(t)].adOrders += ordH.get(h) ?? 0;
  }
  const posts = await prisma.ozonPosting.findMany({ where: { sku, orderAt: { gte: since } }, select: { orderAt: true, qty: true } });
  for (const p of posts) prof[mskHour(p.orderAt!)].orders += p.qty;

  // Все корзины по часам — из снимков аналитики продавца (только прирост за тот же день, пока он идёт)
  const skuSnaps = await prisma.adIntradaySku.findMany({ where: { sku, at: { gte: since } }, orderBy: { at: 'asc' } });
  const sameDay = skuSnaps.filter((s) => ymd(new Date(s.at.getTime() + 3 * HOUR)) === ymd(s.day));
  for (let i = 1; i < sameDay.length; i++) {
    const a = sameDay[i - 1]; const b = sameDay[i];
    if (a.day.getTime() !== b.day.getTime() || b.at.getTime() - a.at.getTime() > 45 * 60_000) continue;
    prof[mskHour(new Date(b.at.getTime() - 120_000))].carts += Math.max(0, b.toCart - a.toCart);
  }
  const share = (k: 'adCart' | 'adOrders' | 'orders' | 'carts') => { const s = prof.reduce((t, p) => t + p[k], 0); return prof.map((p) => (s ? r3(p[k] / s) : null)); };

  // Дозревание аналитики Ozon: какая доля итоговых корзин дня видна через N часов после его начала
  const matur = await maturation(sku);

  return {
    collectedDays, collectingSince: snaps[0]?.at ?? null, campaigns: camps,
    ad,
    profile: { adCart: share('adCart'), adOrders: share('adOrders'), orders: share('orders'), carts: share('carts'), ordersN: prof.reduce((t, p) => t + p.orders, 0), adCartN: prof.reduce((t, p) => t + p.adCart, 0), cartsN: prof.reduce((t, p) => t + p.carts, 0) },
    postingsWithTime: posts.length,
    maturation: matur,
  };
}

async function maturation(sku: string) {
  const rows = await prisma.adIntradaySku.findMany({ where: { sku }, orderBy: { at: 'asc' }, select: { at: true, day: true, toCart: true, orders: true } });
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) { const k = ymd(r.day); const a = byDay.get(k) ?? []; a.push(r); byDay.set(k, a); }
  // берём дни, по которым есть снимки до +3 суток (итог считаем последним снимком)
  const steps = [6, 12, 18, 24, 30, 36, 48, 60, 72, 90]; // снимки дня идут 4 суток (сегодня + 3 дня после)
  const acc = steps.map(() => ({ cart: 0, ord: 0, n: 0 }));
  let daysUsed = 0;
  for (const [d, list] of byDay) {
    const start = dt(d).getTime() - 3 * HOUR;
    const last = list[list.length - 1];
    if (last.at.getTime() - start < 90 * HOUR || !last.toCart) continue;
    daysUsed++;
    steps.forEach((s, i) => {
      const snap = [...list].reverse().find((x) => x.at.getTime() <= start + s * HOUR);
      if (!snap) return;
      acc[i].cart += snap.toCart / last.toCart; acc[i].ord += last.orders ? snap.orders / last.orders : 0; acc[i].n++;
    });
  }
  return { days: daysUsed, points: steps.map((s, i) => ({ hours: s, carts: acc[i].n ? r3(acc[i].cart / acc[i].n) : null, orders: acc[i].n ? r3(acc[i].ord / acc[i].n) : null })) };
}
