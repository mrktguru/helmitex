import prisma from '../prisma/client';
import { kick, swr, track } from './syncStatus';
import { StockError } from './stock';
import { getSetting, ozon, ozonCall, ozonConfigured, ozonGet, setSetting, sleep } from './ozon';
import { fromMicro, perf, perfConfigured, perfReport, toMicro } from './perf';

// Аналитика рекламы: дневная статистика в БД (Seller analytics + Performance + начисления),
// отчёт по SKU с воронкой по источникам, действия с кампаниями и ценами с автозаписью в журнал.

const DAY = 86_400_000;
export const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dt = (s: string) => new Date(s + 'T00:00:00Z');
const num = (x: unknown) => Number(String(x ?? 0).replace(',', '.').replace(/\s/g, '')) || 0;
const round = (v: number, k = 2) => Math.round(v * 10 ** k) / 10 ** k;

// Вчера по Москве — последний полный день
export function lastFullDay(): string {
  return ymd(new Date(Date.now() + 3 * 3600_000 - DAY));
}

// Сегодня по Москве — день неполный, данные Ozon за него догружаются в течение дня
export function todayMsk(): string {
  return ymd(new Date(Date.now() + 3 * 3600_000));
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = dt(from).getTime(); t <= dt(to).getTime(); t += DAY) out.push(ymd(new Date(t)));
  return out;
}

// Непрерывные отрезки из списка дат, не длиннее maxDays (статистика рекламы Ozon — не больше 62 дней за запрос)
function spans(dates: string[], maxDays = 60): [string, string][] {
  const out: [string, string][] = [];
  for (const d of [...dates].sort()) {
    const last = out[out.length - 1];
    if (last && dt(d).getTime() - dt(last[1]).getTime() === DAY && (dt(d).getTime() - dt(last[0]).getTime()) / DAY < maxDays) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

// ───────────── Загрузка дней ─────────────

type Kind = 'seller' | 'perf' | 'finance';

// День нужно (пере)загрузить: не загружался; или загружен, пока данные ещё «дозревали» (< 3 дней после даты), и прошло > 2 ч
async function staleDays(kind: Kind, dates: string[], force: boolean): Promise<string[]> {
  const today = todayMsk();
  const want = dates.filter((d) => d <= today);
  if (force) return want;
  const rows = await prisma.adSyncDay.findMany({ where: { kind, date: { in: want.map(dt) } } });
  const got = new Map(rows.map((r) => [ymd(r.date), r.fetchedAt.getTime()]));
  return want.filter((d) => {
    const at = got.get(d);
    if (at == null) return true;
    if (d === today) return Date.now() - at > 15 * 60_000;
    const settled = at - dt(d).getTime() > 3 * DAY;
    return !settled && Date.now() - at > 2 * 3600_000;
  });
}

async function markDays(kind: Kind, dates: string[]) {
  for (const d of dates) {
    await prisma.adSyncDay.upsert({ where: { kind_date: { kind, date: dt(d) } }, create: { kind, date: dt(d) }, update: { fetchedAt: new Date() } });
  }
}

async function seller<T = any>(path: string, body: unknown): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await ozonCall<T>('POST', path, body, undefined, false); } catch (e) {
      if (i < 3 && /лимит/.test((e as Error).message)) { await sleep(20_000 * (i + 1)); continue; }
      throw e;
    }
  }
}

const SELLER_METRICS = ['hits_view', 'hits_view_search', 'hits_view_pdp', 'hits_tocart', 'ordered_units', 'revenue', 'position_category'];

async function syncSeller(dates: string[]) {
  for (const [from, to] of spans(dates)) {
    const rows = new Map<string, number[]>();
    for (let offset = 0; ; offset += 1000) {
      const r = await seller('/v1/analytics/data', { date_from: from, date_to: to, metrics: SELLER_METRICS, dimension: ['sku', 'day'], limit: 1000, offset });
      const data = r.result?.data ?? [];
      for (const x of data) rows.set(`${x.dimensions[1].id}|${x.dimensions[0].id}`, x.metrics);
      if (data.length < 1000) break;
    }
    const range = dateRange(from, to);
    await prisma.$transaction(async (tx) => {
      await tx.adDaySku.updateMany({ where: { date: { in: range.map(dt) } }, data: { views: 0, searchViews: 0, pdpViews: 0, toCart: 0, orders: 0, revenue: 0, position: null } });
      for (const [k, m] of rows) {
        const [date, sku] = k.split('|');
        const v = { views: Math.round(m[0]), searchViews: Math.round(m[1]), pdpViews: Math.round(m[2]), toCart: Math.round(m[3]), orders: Math.round(m[4]), revenue: m[5], position: m[6] || null };
        await tx.adDaySku.upsert({ where: { date_sku: { date: dt(date), sku } }, create: { date: dt(date), sku, ...v }, update: v });
      }
    }, { timeout: 60_000 });
    await markDays('seller', range);
  }
}

// Начисления за день: выручка/выплата по SKU и списания рекламы по кампаниям
const TYPE_PROMOTION = 54; // «Продвижение товара» — оплата за заказ
const TYPE_PAY_PER_CLICK = 41;

async function syncFinance(dates: string[]) {
  for (const date of dates) {
    const sku = new Map<string, { qty: number; sale: number; buyer: number; payout: number }>();
    const charges = new Map<string, number>();
    const get = (s: string) => { let a = sku.get(s); if (!a) { a = { qty: 0, sale: 0, buyer: 0, payout: 0 }; sku.set(s, a); } return a; };
    let last = '';
    do {
      const j = await seller('/v1/finance/accrual/by-day', last ? { date, last_id: last } : { date });
      for (const a of j.accruals ?? []) {
        if (a.accrued_category === 'POSTING') {
          for (const p of a.posting?.products ?? []) {
            const c = p.commission ?? {};
            const s = get(String(p.sku));
            const sale = num(c.sale_amount?.amount);
            s.qty += sale < 0 ? -(p.quantity ?? 1) : (p.quantity ?? 1);
            s.sale += sale;
            s.buyer += Math.sign(sale || 1) * Math.abs(num(c.sale_price?.amount));
            s.payout += sale + num(c.commission?.amount) + num(p.delivery?.total_accrued?.amount);
          }
        } else if (a.accrued_category === 'ITEM') {
          for (const f of a.item_fees?.fees ?? []) for (const x of f.fees ?? []) get(String(f.sku)).payout += num(x.accrued?.amount);
        } else {
          const f = a.non_item_fee;
          if (f && (f.type_id === TYPE_PROMOTION || f.type_id === TYPE_PAY_PER_CLICK)) {
            const key = `${a.unit_number}|${f.type_id === TYPE_PROMOTION ? 'ORDER' : 'CLICK'}`;
            charges.set(key, (charges.get(key) ?? 0) - num(f.accrued?.amount));
          }
        }
      }
      last = j.last_id ?? '';
    } while (last);

    await prisma.$transaction(async (tx) => {
      await tx.adDaySku.updateMany({ where: { date: dt(date) }, data: { accrQty: 0, accrSale: 0, accrBuyer: 0, accrPayout: 0 } });
      for (const [s, a] of sku) {
        const v = { accrQty: a.qty, accrSale: round(a.sale), accrBuyer: round(a.buyer), accrPayout: round(a.payout) };
        await tx.adDaySku.upsert({ where: { date_sku: { date: dt(date), sku: s } }, create: { date: dt(date), sku: s, ...v }, update: v });
      }
      await tx.adDayCharge.deleteMany({ where: { date: dt(date) } });
      if (charges.size) {
        await tx.adDayCharge.createMany({ data: [...charges].map(([k, amount]) => { const [campaignId, kind] = k.split('|'); return { date: dt(date), campaignId, kind, amount: round(amount) }; }) });
      }
    }, { timeout: 60_000 });
    await markDays('finance', [date]);
  }
}

async function syncPerf(dates: string[]) {
  const meta = await campaignMeta();
  const first = dates.length ? [...dates].sort()[0] : '';
  // Кампании за клики, которые могли крутиться в этом периоде
  const ids = meta.cpcAll.filter((c) => c.state !== 'CAMPAIGN_STATE_ARCHIVED' || (c.updatedAt && c.updatedAt.slice(0, 10) >= first)).map((c) => c.id);
  for (const [from, to] of spans(dates)) {
    const range = dateRange(from, to);
    const acc = new Map<string, { views: number; clicks: number; toCart: number; orders: number; ordersMoney: number; spend: number }>();
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const rep = await perfReport<Record<string, any>>('/api/client/statistics/json', { campaigns: chunk, dateFrom: from, dateTo: to, groupBy: 'DATE' });
      for (const [cid, v] of Object.entries(rep)) {
        for (const r of v?.report?.rows ?? []) {
          if (!r.sku || !r.date) continue;
          const date = String(r.date).split('.').reverse().join('-');
          const key = `${date}|${cid}|${r.sku}`;
          const a = acc.get(key) ?? { views: 0, clicks: 0, toCart: 0, orders: 0, ordersMoney: 0, spend: 0 };
          a.views += num(r.views); a.clicks += num(r.clicks); a.toCart += num(r.toCart);
          a.orders += num(r.orders); a.ordersMoney += num(r.ordersMoney); a.spend += num(r.moneySpent);
          acc.set(key, a);
        }
      }
    }
    await prisma.$transaction(async (tx) => {
      await tx.adDayCampaign.deleteMany({ where: { date: { in: range.map(dt) }, campaignId: { in: ids } } });
      if (acc.size) {
        await tx.adDayCampaign.createMany({
          data: [...acc].map(([k, a]) => { const [date, campaignId, sku] = k.split('|'); return { date: dt(date), campaignId, sku, ...a, ordersMoney: round(a.ordersMoney), spend: round(a.spend) }; }),
        });
      }
    }, { timeout: 60_000 });
    await markDays('perf', range);
  }
}

// Одна загрузка за раз; параллельные запросы ждут её
let running: Promise<void> | null = null;
export async function ensureData(from: string, to: string, force = false): Promise<void> {
  while (running) await running.catch(() => {});
  const dates = dateRange(from, to);
  running = (async () => {
    if (ozonConfigured()) {
      const s = await staleDays('seller', dates, force);
      if (s.length) await syncSeller(s);
      const f = await staleDays('finance', dates, force);
      if (f.length) await syncFinance(f);
    }
    if (perfConfigured()) {
      const p = await staleDays('perf', dates, force);
      if (p.length) await syncPerf(p);
    }
  })();
  try { await running; } finally { running = null; }
}

/** Для страницы: если за дни периода в базе уже что-то есть — отдаём сразу, дозагрузка устаревших идёт в фоне.
 *  Ждём только дни, которых в базе нет совсем (показать нечего). force — «Обновить»: перезапросить всё в фоне. */
export async function ensureDataBg(from: string, to: string, force = false): Promise<void> {
  if (force) { kick('ads-data', () => ensureData(from, to, true)); return; }
  const kinds: Kind[] = [...(ozonConfigured() ? (['seller', 'finance'] as Kind[]) : []), ...(perfConfigured() ? (['perf'] as Kind[]) : [])];
  const dates = dateRange(from, to).filter((d) => d <= todayMsk());
  const have = await prisma.adSyncDay.findMany({ where: { kind: { in: kinds }, date: { in: dates.map(dt) } }, select: { kind: true, date: true } });
  // ждём, только если за период в базе нет ничего — иначе показываем что есть, остальное дозагрузится
  if (have.length === 0) await track('ads-data', () => ensureData(from, to));
  else kick('ads-data', () => ensureData(from, to));
}

// ───────────── Кампании, цены, акции (сохраняются в базе, обновляются в фоне) ─────────────

/** «Обновить» на странице: кампании и цены — перезапросить в фоне (не ждём) */
export function refreshAdsMeta() {
  campaignMeta(true).catch((e) => console.warn('[ads meta]', (e as Error).message));
  prices([], false, true).catch((e) => console.warn('[ads prices]', (e as Error).message));
}

export interface CpcCampaign {
  id: string; title: string; state: string; placement: string[]; dailyBudget: number; weeklyBudget: number; updatedAt: string | null;
  products: { sku: string; bid: number; title: string }[];
}
interface Meta {
  at: number;
  cpcAll: CpcCampaign[];
  cpc: CpcCampaign[];
  searchPromo: { campaignId: string | null; state: string | null; products: { sku: string; bid: number; enabled: boolean; title: string; price: number; prevBid: number | null; prevAt: string | null }[] };
  allSku: { id: string; title: string; state: string } | null;
}
// Кампании: отдаём сохранённое сразу (в т. ч. после перезапуска), обновляем в фоне раз в 10 минут
let metaSilent = false; // следующее обновление — после наших же действий: без записи «изменено в кабинете»
const metaStore = swr<Meta>('ads-meta', 10 * 60_000, async () => { const silent = metaSilent; metaSilent = false; return fetchMeta(silent); });

export function invalidateMeta() { metaStore.reset(); refsStore.reset(); }

// silent — после наших же действий: снимок обновляется без записи «изменено в кабинете»
export async function campaignMeta(refresh = false, silent = false): Promise<Meta> {
  if (!perfConfigured()) return { at: Date.now(), cpcAll: [], cpc: [], searchPromo: { campaignId: null, state: null, products: [] }, allSku: null };
  if (refresh) metaSilent = silent;
  return metaStore.get(refresh);
}

async function fetchMeta(silent: boolean): Promise<Meta> {
  const list = (await perf<{ list: any[] }>('GET', '/api/client/campaign')).list ?? [];
  const cpcAll: CpcCampaign[] = list.filter((c) => c.advObjectType === 'SKU').map((c) => ({
    id: String(c.id), title: c.title || `Кампания ${c.id}`, state: c.state, placement: c.placement ?? [],
    dailyBudget: fromMicro(c.dailyBudget), weeklyBudget: fromMicro(c.weeklyBudget), updatedAt: c.updatedAt ?? null, products: [],
  }));
  const cpc = cpcAll.filter((c) => c.state !== 'CAMPAIGN_STATE_ARCHIVED');
  let partial = false; // часть данных не пришла — не сравниваем с прошлым снимком (иначе ложные «изменено в кабинете»)
  for (const c of cpc) {
    try {
      const p = await perf<{ products: any[] }>('GET', `/api/client/campaign/${c.id}/v2/products?page=1&pageSize=100`);
      c.products = (p.products ?? []).map((x) => ({ sku: String(x.sku), bid: fromMicro(x.bid), title: x.title ?? '' }));
    } catch (e) {
      console.warn(`[ads] campaign ${c.id} products:`, (e as Error).message);
      c.products = metaStore.peek()?.cpc.find((x) => x.id === c.id)?.products ?? [];
      partial = true;
    }
  }
  const sp = list.find((c) => c.advObjectType === 'SEARCH_PROMO' && c.state !== 'CAMPAIGN_STATE_ARCHIVED' && c.state !== 'CAMPAIGN_STATE_INACTIVE')
    ?? list.find((c) => c.advObjectType === 'SEARCH_PROMO' && c.state !== 'CAMPAIGN_STATE_ARCHIVED');
  let spProducts: Meta['searchPromo']['products'] = [];
  try {
    for (let page = 1; page < 20; page++) {
      const r = await perf<{ products: any[]; total?: string }>('POST', '/api/client/campaign/search_promo/v2/products', { page, pageSize: 100 });
      for (const x of r.products ?? []) spProducts.push({ sku: String(x.sku), bid: num(x.bid), enabled: !!x.searchPromoStatus, title: x.title ?? '', price: num(x.price), prevBid: x.previousBid ? num(x.previousBid.bid) : null, prevAt: x.previousBid?.updatedAt ?? null });
      if ((r.products ?? []).length < 100) break;
    }
  } catch (e) {
    // сбой у Ozon в поисковом продвижении не должен ронять кампании — берём последнее известное
    console.warn('[ads] search promo:', (e as Error).message);
    spProducts = metaStore.peek()?.searchPromo.products ?? [];
    partial = true;
  }
  const all = list.find((c) => c.advObjectType === 'ALL_SKU_PROMO' && c.state !== 'CAMPAIGN_STATE_ARCHIVED');
  const meta: Meta = {
    at: Date.now(), cpcAll, cpc,
    searchPromo: { campaignId: sp ? String(sp.id) : null, state: sp?.state ?? null, products: spProducts },
    allSku: all ? { id: String(all.id), title: all.title, state: all.state } : null,
  };
  refsStore.reset();
  if (!partial) await detectCampaignChanges(meta, silent).catch((e) => console.warn('[ads] snapshot', e));
  return meta;
}

// ───────────── Изменения, сделанные в кабинете Ozon, — тоже в журнал ─────────────

interface Snapshot {
  at: string;
  cpc: Record<string, { title: string; state: string; w: number; d: number; bids: Record<string, number> }>;
  sp: Record<string, { on: boolean; bid: number }>;
}
const SNAP_KEY = 'ads.snapshot';
const CAB = ' — в кабинете Ozon';

async function detectCampaignChanges(m: Meta, silent: boolean) {
  const prev = await getSetting<Snapshot | null>(SNAP_KEY, null);
  const now: Snapshot = {
    at: new Date().toISOString(),
    cpc: Object.fromEntries(m.cpc.map((c) => [c.id, { title: c.title, state: c.state, w: c.weeklyBudget, d: c.dailyBudget, bids: Object.fromEntries(c.products.map((p) => [p.sku, p.bid])) }])),
    sp: Object.fromEntries(m.searchPromo.products.filter((p) => p.enabled || p.prevAt).map((p) => [p.sku, { on: p.enabled, bid: p.bid }])),
  };
  const entries: { sku: string | null; campaignId?: string; kind: string; text: string; at: Date }[] = [];
  const since = prev ? new Date(prev.at).getTime() : Date.now() - 30 * DAY;
  const when = (iso: string | null | undefined) => { const t = iso ? new Date(iso).getTime() : NaN; return new Date(Number.isFinite(t) && t > since ? t : Date.now()); };

  if (!prev) {
    // Первый снимок: восстанавливаем недавние изменения из истории ставок «оплаты за заказ» и дат правки кампаний
    for (const p of m.searchPromo.products) {
      if (!p.prevAt || new Date(p.prevAt).getTime() < since) continue;
      const at = new Date(p.prevAt);
      if (!p.enabled && (p.prevBid ?? 0) > 0) entries.push({ sku: p.sku, kind: 'CPO_OFF', text: `Оплата за заказ (выбранные): товар отключён, ставка была ${p.prevBid}%${CAB}`, at });
      else if (p.enabled && !(p.prevBid ?? 0)) entries.push({ sku: p.sku, kind: 'CPO_ON', text: `Оплата за заказ (выбранные): товар добавлен, ставка ${p.bid}%${CAB}`, at });
      else if (p.enabled && p.prevBid !== p.bid) entries.push({ sku: p.sku, kind: 'CPO_BID', text: `Оплата за заказ: ставка ${p.prevBid}% → ${p.bid}%${CAB}`, at });
    }
    for (const c of m.cpc) {
      if (!c.updatedAt || new Date(c.updatedAt).getTime() < Date.now() - 14 * DAY) continue;
      const bids = c.products.map((p) => `${round(p.bid)} ₽`).join(', ');
      for (const p of c.products) entries.push({ sku: p.sku, campaignId: c.id, kind: 'NOTE', text: `РК ${c.id} «${c.title}» изменена${CAB}. Сейчас: ставка ${bids}${c.weeklyBudget ? `, бюджет ${round(c.weeklyBudget, 0)} ₽/нед` : ''}${c.dailyBudget ? `, ${round(c.dailyBudget, 0)} ₽/день` : ''}`, at: new Date(c.updatedAt) });
    }
  } else if (!silent) {
    for (const c of m.cpc) {
      const o = prev.cpc[c.id];
      const skus = c.products.map((p) => p.sku);
      const at = when(c.updatedAt);
      if (!o) { for (const s of skus) entries.push({ sku: s, campaignId: c.id, kind: 'CAMPAIGN_NEW', text: `Новая РК ${c.id} «${c.title}»${CAB}`, at }); continue; }
      const on = c.state === 'CAMPAIGN_STATE_RUNNING', wasOn = o.state === 'CAMPAIGN_STATE_RUNNING';
      if (on !== wasOn) for (const s of skus) entries.push({ sku: s, campaignId: c.id, kind: on ? 'CAMPAIGN_ON' : 'CAMPAIGN_OFF', text: `РК ${c.id} «${c.title}» ${on ? 'включена' : 'выключена'}${CAB}`, at });
      if (round(o.w) !== round(c.weeklyBudget) || round(o.d) !== round(c.dailyBudget)) {
        const parts = [round(o.w) !== round(c.weeklyBudget) && `недельный ${round(o.w, 0)} → ${round(c.weeklyBudget, 0)} ₽`, round(o.d) !== round(c.dailyBudget) && `дневной ${round(o.d, 0)} → ${round(c.dailyBudget, 0)} ₽`].filter(Boolean).join(', ');
        for (const s of skus) entries.push({ sku: s, campaignId: c.id, kind: 'BUDGET', text: `РК ${c.id}: бюджет ${parts}${CAB}`, at });
      }
      for (const p of c.products) {
        const ob = o.bids[p.sku];
        if (ob == null) entries.push({ sku: p.sku, campaignId: c.id, kind: 'BID', text: `Товар добавлен в РК ${c.id}, ставка ${round(p.bid)} ₽${CAB}`, at });
        else if (round(ob) !== round(p.bid)) entries.push({ sku: p.sku, campaignId: c.id, kind: 'BID', text: `РК ${c.id}: ставка ${round(ob)} → ${round(p.bid)} ₽${CAB}`, at });
      }
      for (const s of Object.keys(o.bids)) if (!skus.includes(s)) entries.push({ sku: s, campaignId: c.id, kind: 'NOTE', text: `Товар убран из РК ${c.id}${CAB}`, at });
    }
    for (const [id, o] of Object.entries(prev.cpc)) {
      if (!now.cpc[id]) for (const s of Object.keys(o.bids)) entries.push({ sku: s, campaignId: id, kind: 'CAMPAIGN_OFF', text: `РК ${id} «${o.title}» остановлена или в архиве${CAB}`, at: new Date() });
    }
    for (const p of m.searchPromo.products) {
      const o = prev.sp[p.sku];
      const at = when(p.prevAt);
      if ((o?.on ?? false) !== p.enabled) entries.push({ sku: p.sku, kind: p.enabled ? 'CPO_ON' : 'CPO_OFF', text: `Оплата за заказ (выбранные): товар ${p.enabled ? `добавлен, ставка ${p.bid}%` : 'отключён'}${CAB}`, at });
      else if (p.enabled && o && o.bid !== p.bid) entries.push({ sku: p.sku, kind: 'CPO_BID', text: `Оплата за заказ: ставка ${o.bid}% → ${p.bid}%${CAB}`, at });
    }
  }
  if (entries.length) await prisma.adJournal.createMany({ data: entries.map((e) => ({ ...e, campaignId: e.campaignId ?? null, source: 'AUTO' })) });
  await setSetting(SNAP_KEY, now);
}

// Цены, изменённые в кабинете Ozon
const PRICE_SNAP_KEY = 'ads.priceSnapshot';
async function detectPriceChanges(by: Map<string, PriceInfo>, silent: boolean) {
  const prev = await getSetting<Record<string, { price: number; sale: number; sku?: string }>>(PRICE_SNAP_KEY, {});
  const next = { ...prev };
  const refs = silent ? [] : await productRefs().catch(() => [] as ProductRef[]);
  const entries: { sku: string; kind: string; text: string; at: Date }[] = [];
  for (const [offer, p] of by) {
    const o = prev[offer];
    const sku = refs.find((r) => r.offerId === offer)?.sku;
    if (o && !silent && sku) {
      if (o.price !== p.price) entries.push({ sku, kind: 'PRICE', text: `Цена ${o.price} → ${p.price} ₽${CAB}`, at: new Date() });
      if (o.sale !== p.sellerPrice) entries.push({ sku, kind: 'ACTION_PRICE', text: `Цена продажи (с акциями) ${o.sale} → ${p.sellerPrice} ₽${CAB}`, at: new Date() });
    }
    next[offer] = { price: p.price, sale: p.sellerPrice };
  }
  if (entries.length) await prisma.adJournal.createMany({ data: entries.map((e) => ({ ...e, source: 'AUTO' })) });
  await setSetting(PRICE_SNAP_KEY, next);
}

interface PriceInfo {
  productId: number; offerId: string; price: number; oldPrice: number; minPrice: number; sellerPrice: number; netPrice: number;
  marketing: { title: string; value: number; to: string }[];
}
type ActionInfo = { id: number; title: string; type: string; dateEnd: string; products: Map<number, { actionPrice: number; maxActionPrice: number; price: number }> };

// Цены всех наших товаров разом — отдаём сохранённое, обновляем в фоне раз в 5 минут
let priceSilent = false;
const extraOffers = new Set<string>();
const priceStore = swr<Map<string, PriceInfo>>('ads-prices', 5 * 60_000, async () => {
  const silent = priceSilent; priceSilent = false;
  const offerIds = [...new Set([...(await productRefs()).map((r) => r.offerId).filter((x): x is string => !!x), ...extraOffers])];
  const by = new Map<string, PriceInfo>();
  if (offerIds.length && ozonConfigured()) {
    const r = await seller('/v5/product/info/prices', { filter: { offer_id: offerIds, visibility: 'ALL' }, limit: 1000 });
    for (const it of r.items ?? []) {
      const p = it.price ?? {};
      by.set(it.offer_id, {
        productId: it.product_id, offerId: it.offer_id, price: num(p.price), oldPrice: num(p.old_price), minPrice: num(p.min_price),
        sellerPrice: num(p.marketing_seller_price), netPrice: num(p.net_price),
        marketing: (it.marketing_actions?.actions ?? []).map((a: any) => ({ title: a.title, value: num(a.value), to: a.date_to })),
      });
    }
  }
  await detectPriceChanges(by, silent).catch((e) => console.warn('[ads] price snapshot', e));
  return by;
}, { save: (m) => [...m], load: (a) => new Map(a) });

// Акции — раз в 10 минут
const actionStore = swr<ActionInfo[]>('ads-actions', 10 * 60_000, async () => {
  const r = await ozonGet<{ result: any[] }>('/v1/actions');
  const list: ActionInfo[] = [];
  for (const a of r.result ?? []) {
    const products: ActionInfo['products'] = new Map();
    if (a.is_participating) {
      let lastId: number | undefined;
      for (let i = 0; i < 20; i++) {
        const p = await seller('/v1/actions/products', { action_id: a.id, limit: 100, ...(lastId ? { last_id: lastId } : { offset: 0 }) });
        const items = p.result?.products ?? [];
        for (const x of items) products.set(Number(x.id), { actionPrice: num(x.action_price), maxActionPrice: num(x.max_action_price), price: num(x.price) });
        if (items.length < 100 || !p.result?.last_id) break;
        lastId = p.result.last_id;
      }
    }
    list.push({ id: Number(a.id), title: a.title, type: a.action_type, dateEnd: a.date_end, products });
  }
  return list;
}, { save: (l) => l.map((a) => ({ ...a, products: [...a.products] })), load: (l: any[]) => l.map((a) => ({ ...a, products: new Map(a.products) })) });

export function invalidatePrices() { actionStore.reset(); }

/** Цены товаров. fresh — дождаться свежих (после изменения цены); silent — без записи «изменено в кабинете» */
async function prices(offerIds: string[], silent = false, fresh = false): Promise<Map<string, PriceInfo>> {
  const unknown = offerIds.filter((o) => !extraOffers.has(o));
  unknown.forEach((o) => extraOffers.add(o));
  if (fresh) priceSilent = silent;
  try {
    let by = await priceStore.get(fresh);
    // товара ещё нет в сохранённых ценах — подтянуть сразу
    if (!fresh && unknown.length && offerIds.some((o) => !by.has(o))) by = await priceStore.get(true);
    return by;
  } catch (e) {
    // Ozon не отдал цены (лимит, сбой) — страница работает с последними известными, ошибка видна в статусе
    if (fresh) throw e;
    console.warn('[ads prices]', (e as Error).message);
    return priceStore.peek() ?? new Map();
  }
}

const actions = () => actionStore.get();

// ───────────── Товары и отчёт ─────────────

interface ProductRef { sku: string; offerId: string | null; name: string; inCatalog: boolean }

// Товары раздела (каталог + SKU из кампаний) — отдаём сохранённое, обновляем в фоне
const refsStore = swr<ProductRef[]>('ads-refs', 10 * 60_000, fetchRefs);
function productRefs() { return refsStore.get(); }
async function fetchRefs(): Promise<ProductRef[]> {
  const specs = await prisma.productSpec.findMany({ where: { ozonSku: { not: null }, item: { archived: false } }, include: { item: true } });
  const out = new Map<string, ProductRef>(specs.map((s) => [s.ozonSku!, { sku: s.ozonSku!, offerId: s.ozonOfferId, name: s.item.name, inCatalog: true }]));
  const meta = await campaignMeta();
  for (const c of meta.cpc) for (const p of c.products) if (!out.has(p.sku)) out.set(p.sku, { sku: p.sku, offerId: null, name: p.title || `SKU ${p.sku}`, inCatalog: false });
  for (const p of meta.searchPromo.products) {
    if (!p.enabled) continue;
    const r = out.get(p.sku);
    if (!r) out.set(p.sku, { sku: p.sku, offerId: null, name: p.title || `SKU ${p.sku}`, inCatalog: false });
  }
  // Артикулы для SKU не из каталога
  const missing = [...out.values()].filter((r) => !r.offerId).map((r) => Number(r.sku));
  if (missing.length && ozonConfigured()) {
    const r = await seller('/v3/product/info/list', { sku: missing });
    for (const it of r.items ?? []) {
      const skus = [String(it.sku ?? ''), ...(it.sources ?? []).map((s: any) => String(s.sku))];
      for (const s of skus) { const ref = out.get(s); if (ref) { ref.offerId = it.offer_id; if (!ref.inCatalog && it.name) ref.name = it.name; } }
    }
  }
  return [...out.values()];
}

// Списания «оплаты за заказ» из начислений, распределённые по SKU пропорционально выручке в день
async function allocatedCharges(from: string, to: string): Promise<Map<string, Map<string, number>>> {
  const meta = await campaignMeta();
  const charges = await prisma.adDayCharge.findMany({ where: { kind: 'ORDER', date: { gte: dt(from), lte: dt(to) } } });
  const sales = await prisma.adDaySku.findMany({ where: { date: { gte: dt(from), lte: dt(to) } }, select: { date: true, sku: true, revenue: true } });
  const toggles = await prisma.adJournal.findMany({ where: { kind: { in: ['CPO_ON', 'CPO_OFF'] }, sku: { not: null } }, orderBy: { at: 'asc' } });
  // Был ли товар в «выбранных» в этот день: последнее переключение из журнала, иначе — по previousBid из Ozon
  const memberOn = (sku: string, d: string): boolean => {
    const end = dt(d).getTime() + DAY - 3 * 3600_000; // конец дня по Москве
    const last = toggles.filter((t) => t.sku === sku && t.at.getTime() < end).pop();
    if (last) return last.kind === 'CPO_ON';
    const p = meta.searchPromo.products.find((x) => x.sku === sku);
    if (!p) return false;
    const changedAt = p.prevAt ? new Date(p.prevAt).getTime() : null;
    if (changedAt != null && end <= changedAt) return (p.prevBid ?? 0) > 0; // день до последнего изменения
    return p.enabled;
  };
  const byDay = new Map<string, { sku: string; revenue: number }[]>();
  for (const s of sales) { const d = ymd(s.date); const a = byDay.get(d) ?? []; a.push(s); byDay.set(d, a); }
  const out = new Map<string, Map<string, number>>(); // sku → date → ₽
  for (const c of charges) {
    const d = ymd(c.date);
    const isSelected = c.campaignId === meta.searchPromo.campaignId;
    const pool = (byDay.get(d) ?? []).filter((s) => s.revenue > 0 && (isSelected ? memberOn(s.sku, d) : true));
    const total = pool.reduce((t, s) => t + s.revenue, 0);
    if (!total) continue;
    for (const s of pool) {
      const m = out.get(s.sku) ?? new Map<string, number>();
      m.set(`${d}|${isSelected ? 'sel' : 'all'}`, (m.get(`${d}|${isSelected ? 'sel' : 'all'}`) ?? 0) + c.amount * s.revenue / total);
      out.set(s.sku, m);
    }
  }
  return out;
}

function prevRange(from: string, to: string): [string, string] {
  const len = dateRange(from, to).length;
  return [ymd(new Date(dt(from).getTime() - len * DAY)), ymd(new Date(dt(from).getTime() - DAY))];
}

async function totals(skus: string[], from: string, to: string, alloc: Map<string, Map<string, number>>) {
  const days = await prisma.adDaySku.groupBy({ by: ['sku'], where: { sku: { in: skus }, date: { gte: dt(from), lte: dt(to) } }, _sum: { orders: true, revenue: true, views: true, accrSale: true, accrPayout: true, accrQty: true, accrBuyer: true } });
  const ads = await prisma.adDayCampaign.groupBy({ by: ['sku'], where: { sku: { in: skus }, date: { gte: dt(from), lte: dt(to) } }, _sum: { spend: true } });
  const out = new Map<string, { orders: number; revenue: number; views: number; spend: number; accrSale: number; accrPayout: number; accrQty: number; accrBuyer: number }>();
  for (const s of skus) {
    const d = days.find((x) => x.sku === s)?._sum;
    const click = ads.find((x) => x.sku === s)?._sum.spend ?? 0;
    let cpo = 0;
    for (const [k, v] of alloc.get(s) ?? []) { const day = k.slice(0, 10); if (day >= from && day <= to) cpo += v; }
    out.set(s, {
      orders: d?.orders ?? 0, revenue: d?.revenue ?? 0, views: d?.views ?? 0, spend: click + cpo,
      accrSale: d?.accrSale ?? 0, accrPayout: d?.accrPayout ?? 0, accrQty: d?.accrQty ?? 0, accrBuyer: d?.accrBuyer ?? 0,
    });
  }
  return out;
}

// Предельный ДРР: доля выручки, что остаётся после комиссии, логистики и себестоимости
function breakEven(t: { accrSale: number; accrPayout: number; accrQty: number }, netPrice: number): number | null {
  if (t.accrSale <= 0) return null;
  return Math.max(0, (t.accrPayout - netPrice * t.accrQty) / t.accrSale);
}

export async function getProducts(from: string, to: string, force = false) {
  const [pf, pt] = prevRange(from, to);
  await ensureDataBg(pf, to, force);
  const refs = await productRefs();
  const skus = refs.map((r) => r.sku);
  const alloc = await allocatedCharges(pf, to);
  const cur = await totals(skus, from, to, alloc);
  const prev = await totals(skus, pf, pt, alloc);
  const pr = await prices(refs.map((r) => r.offerId).filter(Boolean) as string[]);
  const meta = await campaignMeta();
  return refs.map((r) => {
    const c = cur.get(r.sku)!, p = prev.get(r.sku)!;
    const price = r.offerId ? pr.get(r.offerId) : undefined;
    const be = breakEven(c, price?.netPrice ?? 0);
    const campaigns = meta.cpc.filter((x) => x.products.some((q) => q.sku === r.sku) && x.state === 'CAMPAIGN_STATE_RUNNING').length
      + (meta.searchPromo.products.some((q) => q.sku === r.sku && q.enabled) ? 1 : 0);
    return {
      ...r, price: price?.sellerPrice || price?.price || null,
      orders: c.orders, ordersPrev: p.orders, revenue: round(c.revenue), revenuePrev: round(p.revenue),
      adSpend: round(c.spend), drr: c.revenue ? c.spend / c.revenue : null, breakEvenDrr: be, campaigns,
    };
  }).sort((a, b) => b.revenue - a.revenue);
}

export async function getReport(sku: string, from: string, to: string, force = false) {
  const [pf, pt] = prevRange(from, to);
  await ensureDataBg(pf, to, force);
  const refs = await productRefs();
  const ref = refs.find((r) => r.sku === sku) ?? { sku, offerId: null, name: `SKU ${sku}`, inCatalog: false };
  const meta = await campaignMeta();
  const alloc = await allocatedCharges(pf, to);
  const days = dateRange(from, to);

  const skuDays = await prisma.adDaySku.findMany({ where: { sku, date: { gte: dt(from), lte: dt(to) } } });
  const camDays = await prisma.adDayCampaign.findMany({ where: { sku, date: { gte: dt(from), lte: dt(to) } } });
  const byDay = new Map(skuDays.map((r) => [ymd(r.date), r]));
  const a = alloc.get(sku) ?? new Map<string, number>();

  const series = days.map((d) => {
    const s = byDay.get(d);
    const c = camDays.filter((x) => ymd(x.date) === d);
    const sum = (k: 'views' | 'clicks' | 'toCart' | 'orders' | 'spend') => c.reduce((t, x) => t + x[k], 0);
    return {
      date: d,
      views: s?.views ?? 0, searchViews: s?.searchViews ?? 0, pdpViews: s?.pdpViews ?? 0, toCart: s?.toCart ?? 0,
      orders: s?.orders ?? 0, revenue: round(s?.revenue ?? 0), position: s?.position ?? null,
      adViews: sum('views'), adClicks: sum('clicks'), adCart: sum('toCart'), adOrders: sum('orders'),
      spendClick: round(sum('spend')), spendSelected: round(a.get(`${d}|sel`) ?? 0), spendAll: round(a.get(`${d}|all`) ?? 0),
      accrQty: s?.accrQty ?? 0, accrSale: s?.accrSale ?? 0, accrBuyer: s?.accrBuyer ?? 0, accrPayout: s?.accrPayout ?? 0,
    };
  });
  const tot = (k: keyof (typeof series)[number]) => series.reduce((t, x) => t + (Number(x[k]) || 0), 0);

  // Воронка по источникам
  const cpcIds = [...new Set([...camDays.map((x) => x.campaignId), ...meta.cpc.filter((c) => c.products.some((p) => p.sku === sku)).map((c) => c.id)])];
  const cpcRows = cpcIds.map((id) => {
    const c = meta.cpcAll.find((x) => x.id === id);
    const rows = camDays.filter((x) => x.campaignId === id);
    const s = (k: 'views' | 'clicks' | 'toCart' | 'orders' | 'ordersMoney' | 'spend') => round(rows.reduce((t, x) => t + x[k], 0));
    return {
      id, title: c?.title ?? `Кампания ${id}`, state: c?.state ?? 'UNKNOWN', placement: c?.placement ?? [],
      dailyBudget: c?.dailyBudget ?? 0, weeklyBudget: c?.weeklyBudget ?? 0,
      bid: c?.products.find((p) => p.sku === sku)?.bid ?? null, productsCount: c?.products.length ?? 0,
      otherProducts: (c?.products ?? []).filter((p) => p.sku !== sku).map((p) => p.title || p.sku),
      views: s('views'), clicks: s('clicks'), toCart: s('toCart'), orders: s('orders'), ordersMoney: s('ordersMoney'), spend: s('spend'),
    };
  }).sort((x, y) => y.spend - x.spend);
  const sp = meta.searchPromo.products.find((p) => p.sku === sku);
  const total = { views: tot('views'), pdpViews: tot('pdpViews'), toCart: tot('toCart'), orders: tot('orders'), revenue: round(tot('revenue')) };
  const adSum = (k: 'views' | 'clicks' | 'toCart' | 'orders') => cpcRows.reduce((t, x) => t + x[k], 0);

  // Цена и акции
  const pr = ref.offerId ? (await prices([ref.offerId])).get(ref.offerId) ?? null : null;
  let promo: { id: number; title: string; type: string; dateEnd: string; actionPrice: number; maxActionPrice: number }[] = [];
  if (pr) {
    try {
      promo = (await actions()).filter((x) => x.products.has(pr.productId)).map((x) => ({ id: x.id, title: x.title, type: x.type, dateEnd: x.dateEnd, ...x.products.get(pr.productId)! }));
    } catch (e) { console.warn('[ads] actions', e); }
  }

  // KPI: текущий и прошлый период
  const curT = (await totals([sku], from, to, alloc)).get(sku)!;
  const prevT = (await totals([sku], pf, pt, alloc)).get(sku)!;
  const net = pr?.netPrice ?? 0;
  const kpi = (t: typeof curT) => ({
    orders: t.orders, revenue: round(t.revenue), views: t.views, adSpend: round(t.spend),
    drr: t.revenue ? t.spend / t.revenue : null,
    payout: round(t.accrPayout), accrQty: t.accrQty,
    profit: t.accrSale ? round(t.accrPayout - t.spend - net * t.accrQty) : null,
    ozonShare: t.accrSale > 0 ? 1 - t.accrBuyer / t.accrSale : null,
    breakEvenDrr: breakEven(t, net),
  });

  // Журнал + аномалии (всплеск органических корзин без записи)
  const journal = await prisma.adJournal.findMany({ where: { OR: [{ sku }, { sku: null }], at: { gte: dt(pf), lte: new Date(dt(to).getTime() + 2 * DAY) } }, orderBy: { at: 'desc' } });
  const org = series.map((x) => Math.max(0, x.toCart - x.adCart));
  const med = [...org].sort((p, q) => p - q)[Math.floor(org.length / 2)] ?? 0;
  // Дни подряд — одна аномалия; день с записью в журнале — уже объяснён
  const mskDay = (d: Date) => ymd(new Date(d.getTime() + 3 * 3600_000));
  const hot = series.map((x, i) => ({ date: x.date, v: org[i] })).filter((x) => x.v > Math.max(50, med * 3));
  const anomalies: { date: string; text: string }[] = [];
  for (let i = 0; i < hot.length;) {
    let j = i;
    while (j + 1 < hot.length && dt(hot[j + 1].date).getTime() - dt(hot[j].date).getTime() === DAY) j++;
    const run = hot.slice(i, j + 1);
    if (!run.some((x) => journal.some((e) => mskDay(e.at) === x.date))) {
      const peak = run.reduce((a, b) => (b.v > a.v ? b : a));
      const when = run.length > 1 ? `${run[0].date.slice(8)}.${run[0].date.slice(5, 7)}–${run[run.length - 1].date.slice(8)}.${run[run.length - 1].date.slice(5, 7)}` : '';
      anomalies.push({ date: run[0].date, text: `${when ? `${when}: ` : ''}органические корзины до ${peak.v} в день — в ${round(peak.v / (med || 1), 1)} раза выше обычного. Что произошло?` });
    }
    i = j + 1;
  }

  return {
    product: { ...ref, price: pr, promo },
    period: { from, to, prevFrom: pf, prevTo: pt },
    kpi: { cur: kpi(curT), prev: kpi(prevT) },
    sources: {
      cpc: cpcRows,
      selected: {
        campaignId: meta.searchPromo.campaignId, state: meta.searchPromo.state, enabled: !!sp?.enabled, bid: sp?.bid ?? null,
        spend: round(tot('spendSelected')),
      },
      allSku: meta.allSku ? { ...meta.allSku, spend: round(tot('spendAll')) } : null,
      organic: { views: Math.max(0, total.views - adSum('views')), clicks: Math.max(0, total.pdpViews - adSum('clicks')), toCart: Math.max(0, total.toCart - adSum('toCart')), orders: Math.max(0, total.orders - adSum('orders')) },
      total,
    },
    series,
    campaignDays: Object.fromEntries(cpcIds.map((id) => [id, days.map((d) => {
      const rows = camDays.filter((x) => x.campaignId === id && ymd(x.date) === d);
      const s = (k: 'views' | 'clicks' | 'toCart' | 'orders' | 'ordersMoney' | 'spend') => round(rows.reduce((t, x) => t + x[k], 0));
      return { date: d, views: s('views'), clicks: s('clicks'), toCart: s('toCart'), orders: s('orders'), ordersMoney: s('ordersMoney'), spend: s('spend') };
    })])),
    journal,
    anomalies,
    syncedAt: (await prisma.adSyncDay.findFirst({ where: { kind: 'seller' }, orderBy: { fetchedAt: 'desc' } }))?.fetchedAt ?? null,
  };
}

// ───────────── Действия (каждое пишет запись в журнал) ─────────────

interface Actor { email: string | null }

async function log(sku: string | null, kind: string, text: string, actor: Actor, meta?: unknown, campaignId?: string) {
  await prisma.adJournal.create({ data: { sku, kind, text, source: 'AUTO', meta: (meta ?? undefined) as any, campaignId: campaignId ?? null, userEmail: actor.email, at: new Date() } });
}

export async function setCampaignState(campaignId: string, on: boolean, actor: Actor) {
  const meta = await campaignMeta();
  const c = meta.cpcAll.find((x) => x.id === campaignId);
  await perf('POST', `/api/client/campaign/${campaignId}/${on ? 'activate' : 'deactivate'}`, {});
  const skus = c?.products.map((p) => p.sku) ?? [];
  for (const s of skus.length ? skus : [null]) await log(s, on ? 'CAMPAIGN_ON' : 'CAMPAIGN_OFF', `РК ${campaignId}${c ? ` «${c.title}»` : ''} ${on ? 'включена' : 'выключена'}`, actor, null, campaignId);
  await campaignMeta(true, true);
}

export async function setCpcBid(campaignId: string, sku: string, bid: number, actor: Actor) {
  if (!(bid > 0)) throw new StockError('Ставка должна быть больше нуля');
  const meta = await campaignMeta();
  const old = meta.cpcAll.find((x) => x.id === campaignId)?.products.find((p) => p.sku === sku)?.bid;
  await perf('PUT', `/api/client/campaign/${campaignId}/products`, { bids: [{ sku, bid: toMicro(bid) }] });
  await log(sku, 'BID', `РК ${campaignId}: ставка ${old != null ? `${round(old)} → ` : ''}${round(bid)} ₽`, actor, { old, bid }, campaignId);
  await campaignMeta(true, true);
}

export async function setBudget(campaignId: string, b: { weeklyBudget?: number | null; dailyBudget?: number | null }, actor: Actor) {
  const meta = await campaignMeta();
  const c = meta.cpcAll.find((x) => x.id === campaignId);
  const body: Record<string, string> = {};
  if (b.weeklyBudget != null) body.weeklyBudget = toMicro(b.weeklyBudget);
  if (b.dailyBudget != null) body.dailyBudget = toMicro(b.dailyBudget);
  if (!Object.keys(body).length) throw new StockError('Укажите бюджет');
  await perf('PATCH', `/api/client/campaign/${campaignId}`, body);
  const parts = [
    b.weeklyBudget != null && `недельный ${c?.weeklyBudget ? `${round(c.weeklyBudget, 0)} → ` : ''}${round(b.weeklyBudget, 0)} ₽`,
    b.dailyBudget != null && `дневной ${c?.dailyBudget ? `${round(c.dailyBudget, 0)} → ` : ''}${round(b.dailyBudget, 0)} ₽`,
  ].filter(Boolean).join(', ');
  for (const s of c?.products.map((p) => p.sku) ?? [null]) await log(s, 'BUDGET', `РК ${campaignId}: бюджет ${parts}`, actor, { old: { w: c?.weeklyBudget, d: c?.dailyBudget }, ...b }, campaignId);
  await campaignMeta(true, true);
}

export async function setSelected(sku: string, on: boolean, actor: Actor) {
  await perf('POST', `/api/client/search_promo/product/${on ? 'enable' : 'disable'}`, { skus: [sku] });
  await log(sku, on ? 'CPO_ON' : 'CPO_OFF', `Оплата за заказ (выбранные): товар ${on ? 'добавлен' : 'отключён'}`, actor);
  await campaignMeta(true, true);
}

export async function setSelectedBid(sku: string, bid: number, actor: Actor) {
  if (!(bid > 0 && bid < 100)) throw new StockError('Ставка — процент от цены, от 0 до 100');
  const meta = await campaignMeta();
  const old = meta.searchPromo.products.find((p) => p.sku === sku)?.bid;
  await perf('POST', '/api/client/campaign/search_promo/v2/bids/set', { bids: [{ sku, bid }] });
  await log(sku, 'CPO_BID', `Оплата за заказ: ставка ${old != null ? `${old}% → ` : ''}${bid}%`, actor, { old, bid });
  await campaignMeta(true, true);
}

export async function createCampaign(d: { title: string; placement: string; strategy?: 'NO_AUTO_STRATEGY' | 'TARGET_BIDS' | 'MAX_CLICKS'; fromDate?: string | null; toDate?: string | null; weeklyBudget?: number | null; dailyBudget?: number | null; skus: { sku: string; bid: number }[]; activate: boolean }, actor: Actor) {
  if (!d.skus.length) throw new StockError('Добавьте хотя бы один товар');
  // «Максимум кликов» в поиске у Ozon — отдельное значение TOP_MAX_CLICKS
  const strategy = d.strategy === 'MAX_CLICKS' && d.placement === 'PLACEMENT_TOP_PROMOTION' ? 'TOP_MAX_CLICKS' : d.strategy ?? 'NO_AUTO_STRATEGY';
  const body: Record<string, unknown> = { title: d.title, placement: d.placement, productAutopilotStrategy: strategy };
  if (d.fromDate) body.fromDate = d.fromDate;
  if (d.toDate) body.toDate = d.toDate;
  if (d.weeklyBudget) body.weeklyBudget = toMicro(d.weeklyBudget);
  if (d.dailyBudget) body.dailyBudget = toMicro(d.dailyBudget);
  const r = await perf<{ campaignId: string }>('POST', '/api/client/campaign/cpc/v2/product', body);
  const id = String(r.campaignId);
  await perf('POST', `/api/client/campaign/${id}/products`, { bids: d.skus.map((s) => ({ sku: s.sku, bid: toMicro(s.bid) })) });
  let activated = false, activateError: string | null = null;
  if (d.activate) {
    try { await perf('POST', `/api/client/campaign/${id}/activate`, {}); activated = true; } catch (e) { activateError = (e as Error).message; }
  }
  const place = d.placement === 'PLACEMENT_TOP_PROMOTION' ? 'поиск' : 'поиск и рекомендации';
  const budget = d.weeklyBudget ? `, ${round(d.weeklyBudget, 0)} ₽/нед` : d.dailyBudget ? `, ${round(d.dailyBudget, 0)} ₽/день` : '';
  for (const s of d.skus) await log(s.sku, 'CAMPAIGN_NEW', `Создана РК ${id} «${d.title}»: ${place}, ставка ${s.bid} ₽${budget}${activated ? ', запущена' : ''}`, actor, { placement: d.placement }, id);
  await campaignMeta(true, true);
  return { id, activated, activateError };
}

export async function setPrice(sku: string, p: { price?: number | null; oldPrice?: number | null; minPrice?: number | null }, actor: Actor) {
  const ref = (await productRefs()).find((r) => r.sku === sku);
  if (!ref?.offerId) throw new StockError('У товара нет артикула Ozon');
  const before = (await prices([ref.offerId])).get(ref.offerId);
  const item: Record<string, string> = { offer_id: ref.offerId, currency_code: 'RUB' };
  if (p.price != null) item.price = String(p.price);
  if (p.oldPrice != null) item.old_price = String(p.oldPrice);
  if (p.minPrice != null) item.min_price = String(p.minPrice);
  const r = await ozon('/v1/product/import/prices', { prices: [item] });
  const res = r.result?.[0];
  if (!res?.updated) throw new StockError(`Ozon не принял цену: ${(res?.errors ?? []).map((e: any) => e.message).join('; ') || 'без причины'}`);
  const parts = [
    p.price != null && `цена ${before?.price ?? '?'} → ${p.price} ₽`,
    p.oldPrice != null && `зачёркнутая ${before?.oldPrice ?? '?'} → ${p.oldPrice} ₽`,
    p.minPrice != null && `минимальная ${before?.minPrice ?? '?'} → ${p.minPrice} ₽`,
  ].filter(Boolean).join(', ');
  await log(sku, 'PRICE', `Цена: ${parts}`, actor, { before, after: p });
  invalidatePrices();
  await prices([ref.offerId], true, true).catch(() => {});
}

export async function setActionPrice(sku: string, actionId: number, actionPrice: number, actor: Actor) {
  const ref = (await productRefs()).find((r) => r.sku === sku);
  if (!ref?.offerId) throw new StockError('У товара нет артикула Ozon');
  const pr = (await prices([ref.offerId])).get(ref.offerId);
  if (!pr) throw new StockError('Нет данных о цене товара');
  const act = (await actions()).find((a) => a.id === actionId);
  const old = act?.products.get(pr.productId)?.actionPrice;
  const r = await ozon('/v1/actions/products/activate', { action_id: actionId, products: [{ product_id: pr.productId, action_price: actionPrice }] });
  const rej = r.result?.rejected ?? [];
  if (rej.length) throw new StockError(`Ozon отклонил цену в акции: ${rej.map((x: any) => x.reason).join('; ')}`);
  await log(sku, 'ACTION_PRICE', `Цена в акции «${act?.title ?? actionId}»: ${old != null ? `${old} → ` : ''}${actionPrice} ₽`, actor, { actionId, old, actionPrice });
  invalidatePrices();
  await prices([ref.offerId], true, true).catch(() => {});
}

// Снимок рекламы за текущий день: накопленные показатели каждой кампании + ставки и бюджет
export async function snapshotIntraday(): Promise<number> {
  if (!perfConfigured()) return 0;
  const meta = await campaignMeta(true);
  const day = ymd(new Date(Date.now() + 3 * 3600_000));
  const today = Date.now() - DAY;
  const ids = meta.cpcAll.filter((c) => c.state === 'CAMPAIGN_STATE_RUNNING' || (c.updatedAt && new Date(c.updatedAt).getTime() > today)).map((c) => c.id);
  const at = new Date();
  let saved = 0;
  for (let i = 0; i < ids.length; i += 20) {
    const q = ids.slice(i, i + 20).map((id) => `campaignIds=${id}`).join('&');
    // Ozon берёт из from/to только дату (по UTC) и отдаёт итог за весь день — передаём полдень нужного дня
    const r = await perf<{ rows: any[] }>('GET', `/api/client/statistics/campaign/product/json?${q}&from=${day}T12:00:00Z&to=${day}T12:00:00Z`);
    const rows = (r.rows ?? []).map((x) => {
      const c = meta.cpcAll.find((m) => m.id === String(x.id));
      return {
        at, day: dt(day), campaignId: String(x.id),
        views: Math.round(num(x.views)), clicks: Math.round(num(x.clicks)), toCart: Math.round(num(x.toCart)),
        orders: Math.round(num(x.orders)), ordersMoney: num(x.ordersMoney), spend: num(x.moneySpent),
        state: c?.state ?? String(x.status ?? ''), weeklyBudget: c?.weeklyBudget ?? 0, dailyBudget: c?.dailyBudget ?? 0,
        bids: Object.fromEntries((c?.products ?? []).map((p) => [p.sku, p.bid])),
      };
    });
    if (rows.length) await prisma.adIntraday.createMany({ data: rows, skipDuplicates: true });
    saved += rows.length;
  }
  return saved;
}

// Прирост между соседними снимками: снимки хранят накопленное с полуночи (МСК)
export interface IntradayStep { at: Date; views: number; clicks: number; toCart: number; orders: number; ordersMoney: number; spend: number }
export function increments(rows: { at: Date; day: Date; views: number; clicks: number; toCart: number; orders: number; ordersMoney: number; spend: number }[]): IntradayStep[] {
  const out: IntradayStep[] = [];
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i], p = sorted[i - 1];
    const same = p && p.day.getTime() === r.day.getTime();
    // первый снимок дня позже 00:40 МСК (сбор только начался или был перерыв) — накопленное за неизвестный промежуток, пропускаем
    if (!same && (r.at.getTime() + 3 * 3600_000) % DAY > 40 * 60_000) continue;
    const k = (f: 'views' | 'clicks' | 'toCart' | 'orders' | 'ordersMoney' | 'spend') => Math.max(0, r[f] - (same ? p[f] : 0));
    out.push({ at: r.at, views: k('views'), clicks: k('clicks'), toCart: k('toCart'), orders: k('orders'), ordersMoney: k('ordersMoney'), spend: k('spend') });
  }
  return out;
}

// Статистика кампании за день (МСК) по корзинам 30/60/180 минут + то же время вчера
export async function getIntraday(campaignId: string, day: string, stepMin: 30 | 60 | 180) {
  const prevDay = ymd(new Date(dt(day).getTime() - DAY));
  const rows = await prisma.adIntraday.findMany({ where: { campaignId, day: { in: [dt(prevDay), dt(day)] } }, orderBy: { at: 'asc' } });
  const inc = increments(rows);
  const slots = (d: string) => {
    const start = dt(d).getTime() - 3 * 3600_000; // 00:00 МСК
    const n = (24 * 60) / stepMin;
    return Array.from({ length: n }, (_, i) => {
      const from = start + i * stepMin * 60_000, to = from + stepMin * 60_000;
      // прирост снимка в момент T — за полчаса до T; относим к интервалу, где лежит T − 2 мин (снимки бывают на пару секунд позже :00/:30)
      const part = inc.filter((x) => { const t = x.at.getTime() - 120_000; return t >= from && t < to; });
      const sum = (f: keyof Omit<IntradayStep, 'at'>) => round(part.reduce((t, x) => t + x[f], 0));
      const label = new Date(from + 3 * 3600_000).toISOString().slice(11, 16);
      return { from: label, views: sum('views'), clicks: sum('clicks'), toCart: sum('toCart'), orders: sum('orders'), ordersMoney: sum('ordersMoney'), spend: sum('spend'), hasData: part.length > 0 };
    });
  };
  const last = rows.filter((r) => ymd(r.day) === day).pop();
  return {
    day, stepMin, today: slots(day), yesterday: slots(prevDay),
    lastSnapshot: last?.at ?? null, state: last?.state ?? null, bids: last?.bids ?? null,
    collectingSince: (await prisma.adIntraday.findFirst({ orderBy: { at: 'asc' } }))?.at ?? null,
  };
}

// Фоновая загрузка последних дней — раз в 3 часа; снимок рекламы — каждые 30 минут (:00 и :30)
export function startAdsSync(afterSnapshot?: () => Promise<void>) {
  const run = () => {
    const to = lastFullDay();
    const from = ymd(new Date(dt(to).getTime() - 6 * DAY));
    kick('ads-data', () => ensureData(from, to));
  };
  setTimeout(run, 60_000);
  setInterval(run, 3 * 3600_000);

  const snap = () => track('ads-intraday', async () => { await snapshotIntraday(); await afterSnapshot?.(); }).catch((e) => console.warn('[ads intraday]', e));
  const toNext = 30 * 60_000 - (Date.now() % (30 * 60_000));
  setTimeout(() => { snap(); setInterval(snap, 30 * 60_000); }, toNext);
}
