import prisma from '../prisma/client';
import { StockError } from './stock';
import { campaignMeta, dateRange, setCampaignState, todayMsk, ymd } from './ads';
import { weightedPosition } from './adsQueries';

// Эксперимент «включено / выключено»: проверка, сколько заказов реклама добавляет, а сколько забирает у органики.
// Кампания переключается блоками по расписанию (случайный порядок), биддер на это время замораживает ставку.
// Сравниваются ВСЕ заказы товара (без отмен) в дни «включено» и «выключено»; первые дни блока не учитываются.

const DAY = 86_400_000;
const dt = (s: string) => new Date(s + 'T00:00:00Z');
const addDays = (s: string, n: number) => ymd(new Date(dt(s).getTime() + n * DAY));
const ACTOR = { email: 'Эксперимент' };

export type Mode = 'ON' | 'OFF';
export interface Block { from: string; to: string; mode: Mode }

/** Случайный порядок: поровну ON и OFF, не больше двух одинаковых блоков подряд */
export function makeSchedule(start: string, blockDays: number, pairs: number): Block[] {
  for (let attempt = 0; attempt < 200; attempt++) {
    const modes: Mode[] = [...Array(pairs).fill('ON'), ...Array(pairs).fill('OFF')];
    for (let i = modes.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [modes[i], modes[j]] = [modes[j], modes[i]]; }
    if (modes.some((m, i) => i >= 2 && m === modes[i - 1] && m === modes[i - 2])) continue;
    return modes.map((mode, i) => ({ from: addDays(start, i * blockDays), to: addDays(start, (i + 1) * blockDays - 1), mode }));
  }
  return Array.from({ length: pairs * 2 }, (_, i) => ({ from: addDays(start, i * blockDays), to: addDays(start, (i + 1) * blockDays - 1), mode: i % 2 ? 'OFF' : 'ON' }));
}

const ACTIVE = ['PLANNED', 'RUNNING'];

export async function activeExperiment(campaignId: string) {
  return prisma.adExperiment.findFirst({ where: { campaignId, status: 'RUNNING' } });
}

export async function createExperiment(d: { campaignId: string; sku: string; start: string; blockDays: number; pairs: number; skipDays: number; endState: Mode; note?: string | null; modes?: Mode[] }, email: string | null) {
  if (d.start < todayMsk()) throw new StockError('Дата начала — не раньше сегодняшнего дня');
  if (await prisma.adExperiment.findFirst({ where: { campaignId: d.campaignId, status: { in: ACTIVE } } })) throw new StockError('Для этой кампании уже есть запланированный или идущий эксперимент');
  const meta = await campaignMeta();
  const c = meta.cpcAll.find((x) => x.id === d.campaignId);
  if (!c) throw new StockError('Кампания не найдена в Ozon');
  if (!c.products.some((p) => p.sku === d.sku)) throw new StockError('Товара нет в этой кампании');
  if (d.skipDays >= d.blockDays) throw new StockError('Дней без учёта должно быть меньше длины блока');
  // порядок блоков — как в предпросмотре (если передан), иначе случайный
  const okModes = d.modes && d.modes.length === d.pairs * 2 && d.modes.filter((m) => m === 'ON').length === d.pairs;
  const blocks: Block[] = okModes
    ? d.modes!.map((mode, i) => ({ from: addDays(d.start, i * d.blockDays), to: addDays(d.start, (i + 1) * d.blockDays - 1), mode }))
    : makeSchedule(d.start, d.blockDays, d.pairs);
  return prisma.adExperiment.create({
    data: {
      campaignId: d.campaignId, sku: d.sku, title: `«${c.title}»: включено / выключено по ${d.blockDays} дн.`,
      blockDays: d.blockDays, skipDays: d.skipDays, blocks: blocks as any, endState: d.endState, note: d.note || null, createdBy: email,
    },
  });
}

async function setState(campaignId: string, on: boolean) {
  const meta = await campaignMeta();
  const c = meta.cpcAll.find((x) => x.id === campaignId);
  const isOn = !!c && ['CAMPAIGN_STATE_RUNNING', 'CAMPAIGN_STATE_STOPPED'].includes(c.state);
  if (isOn !== on) await setCampaignState(campaignId, on, ACTOR);
}

export async function stopExperiment(id: string, email: string | null) {
  const e = await prisma.adExperiment.findUnique({ where: { id } });
  if (!e || !ACTIVE.includes(e.status)) throw new StockError('Эксперимент не идёт');
  await prisma.adExperiment.update({ where: { id }, data: { status: 'STOPPED', finishedAt: new Date(), note: [e.note, `остановлен: ${email ?? '—'}`].filter(Boolean).join(' · ') } });
  if (e.status === 'RUNNING') await setState(e.campaignId, e.endState === 'ON');
}

/** Каждые 30 минут: старт запланированных, переключение кампании по блокам, завершение */
export async function tickExperiments() {
  const today = todayMsk();
  for (const e of await prisma.adExperiment.findMany({ where: { status: { in: ACTIVE } } })) {
    const blocks = e.blocks as unknown as Block[];
    if (today > blocks[blocks.length - 1].to) {
      await prisma.adExperiment.update({ where: { id: e.id }, data: { status: 'DONE', finishedAt: new Date() } });
      if (e.status === 'RUNNING') await setState(e.campaignId, e.endState === 'ON');
      continue;
    }
    const b = blocks.find((x) => x.from <= today && today <= x.to);
    if (!b) continue; // ещё не началось
    if (e.status === 'PLANNED') {
      const c = (await campaignMeta()).cpcAll.find((x) => x.id === e.campaignId);
      const p = c?.products.find((x) => x.sku === e.sku);
      await prisma.adExperiment.update({ where: { id: e.id }, data: { status: 'RUNNING', startedAt: new Date(), bid: p?.bid ?? null } });
    }
    await setState(e.campaignId, b.mode === 'ON');
  }
}

// ───────────── Отчёт ─────────────

const mean = (a: number[]) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : null);
const sd = (a: number[]) => { const m = mean(a); return a.length > 1 && m != null ? Math.sqrt(a.reduce((t, x) => t + (x - m) ** 2, 0) / (a.length - 1)) : null; };
const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

export async function experimentReport(e: Awaited<ReturnType<typeof prisma.adExperiment.findUnique>> & {}) {
  const blocks = e.blocks as unknown as Block[];
  const today = todayMsk();
  const from = blocks[0].from; const to = blocks[blocks.length - 1].to < today ? blocks[blocks.length - 1].to : today;
  const days = to >= from ? dateRange(from, to) : [];
  const [sku, cam, other, posts, qrows] = await Promise.all([
    prisma.adDaySku.findMany({ where: { sku: e.sku, date: { gte: dt(from), lte: dt(to) } } }),
    prisma.adDayCampaign.findMany({ where: { sku: e.sku, campaignId: e.campaignId, date: { gte: dt(from), lte: dt(to) } } }),
    prisma.adDayCampaign.groupBy({ by: ['date'], where: { sku: e.sku, campaignId: { not: e.campaignId }, date: { gte: dt(from), lte: dt(to) } }, _sum: { spend: true } }),
    prisma.ozonPosting.groupBy({ by: ['orderDay'], where: { sku: e.sku, orderDay: { gte: from, lte: to }, NOT: { status: 'cancelled' } }, _sum: { qty: true } }),
    prisma.adQueryDay.findMany({ where: { sku: e.sku, date: { gte: dt(from), lte: dt(to) } }, select: { date: true, position: true, searches: true } }),
  ]);
  const by = <T extends { date: Date }>(a: T[]) => new Map(a.map((x) => [ymd(x.date), x]));
  const S = by(sku); const Cm = by(cam);
  const O = new Map(other.map((x) => [ymd(x.date), x._sum.spend ?? 0]));
  const P = new Map(posts.map((x) => [x.orderDay, x._sum.qty ?? 0]));

  const rows = days.map((d) => {
    const b = blocks.find((x) => x.from <= d && d <= x.to)!;
    const idx = Math.round((dt(d).getTime() - dt(b.from).getTime()) / DAY);
    const s = S.get(d); const c = Cm.get(d);
    return {
      date: d, mode: b.mode, counted: idx >= e.skipDays && d < today, // сегодняшний день неполный — не учитываем
      orders: P.get(d) ?? 0, ordersOzon: s?.orders ?? 0, revenue: Math.round(s?.revenue ?? 0), views: s?.views ?? 0, carts: s?.toCart ?? 0,
      spend: Math.round(c?.spend ?? 0), clicks: c?.clicks ?? 0, adOrders: c?.orders ?? 0, adViews: c?.views ?? 0, otherSpend: Math.round(O.get(d) ?? 0),
      position: weightedPosition(qrows.filter((q) => ymd(q.date) === d)),
    };
  });

  type K = 'orders' | 'revenue' | 'views' | 'carts' | 'spend' | 'adOrders' | 'position' | 'otherSpend';
  const pick = (mode: Mode, k: K) => rows.filter((r) => r.counted && r.mode === mode).map((r) => r[k]).filter((v): v is number => v != null);
  const stat = (k: K) => {
    const on = pick('ON', k), off = pick('OFF', k);
    const mOn = mean(on), mOff = mean(off);
    const se = sd(on) != null && sd(off) != null ? Math.sqrt(sd(on)! ** 2 / on.length + sd(off)! ** 2 / off.length) : null;
    return { on: r1(mOn), off: r1(mOff), diff: mOn != null && mOff != null ? r1(mOn - mOff) : null, ci90: se != null ? r1(1.645 * se) : null, nOn: on.length, nOff: off.length };
  };
  const st = { orders: stat('orders'), revenue: stat('revenue'), views: stat('views'), carts: stat('carts'), spend: stat('spend'), adOrders: stat('adOrders'), position: stat('position'), otherSpend: stat('otherSpend') };
  const dOrders = st.orders.diff; const spendOn = st.spend.on;
  const summary = {
    incrementalOrders: dOrders,
    incrementalOrdersCi: st.orders.ci90,
    attributedOrders: st.adOrders.on, // сколько заказов Ozon приписывает кампании
    incrementalShare: dOrders != null && st.adOrders.on ? r1(Math.max(0, dOrders) / st.adOrders.on * 100) : null,
    incrementalCpo: dOrders != null && dOrders > 0 && spendOn != null ? Math.round(spendOn / dOrders) : null,
    attributedCpo: st.adOrders.on && spendOn != null ? Math.round(spendOn / st.adOrders.on) : null,
    incrementalDrr: st.revenue.diff != null && st.revenue.diff > 0 && spendOn != null ? r1(spendOn / st.revenue.diff * 100) : null,
    // хватает ли данных: разница больше погрешности
    significant: dOrders != null && st.orders.ci90 != null ? Math.abs(dOrders) > st.orders.ci90 : null,
    countedDays: { on: st.orders.nOn, off: st.orders.nOff },
  };
  return { ...e, blocks, rows, stats: st, summary };
}

export async function listExperiments(sku: string) {
  const list = await prisma.adExperiment.findMany({ where: { sku }, orderBy: { createdAt: 'desc' }, take: 10 });
  return Promise.all(list.map((e) => experimentReport(e)));
}
