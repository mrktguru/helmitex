import prisma from '../prisma/client';
import { campaignMeta, increments, setBudget, setCpcBid, ymd } from './ads';
import { ozon, ozonConfigured } from './ozon';

// Биддер кампании «оплата за клик».
// Цель (одна): цена корзины с поправкой на конверсию корзины в заказ (по умолчанию), цена заказа или ДРР.
// Модификаторы (сочетаются с любой целью): часы, темп бюджета, остатки, отклик показов, органика, рост бюджета.
// Ограничители действуют всегда. Решения — каждые 30 минут после снимка статистики.

const DAY = 86_400_000, MSK = 3 * 3600_000;
const ACTOR = { email: 'Биддер' };

export const DEFAULT_MODS = { hours: true, pace: true, stock: true, elastic: true, organic: false, budgetUp: true };
export const DEFAULT_LIMITS = { minBid: 5, maxBid: 60, maxStepPct: 15, cooldownMin: 120, minClicks: 50, maxChangesPerDay: 6, stopLossRub: 3000, hourFrom: 0, hourTo: 24 };
type Mods = typeof DEFAULT_MODS;
type Limits = typeof DEFAULT_LIMITS;

// Профиль спроса по часам МСК (реальные заказы Lowtex за обычный день) — пока не накопились свои данные по часам
const DEMAND = [4, 1, 1, 3, 4, 0, 5, 4, 7, 8, 11, 11, 10, 9, 8, 17, 7, 10, 6, 12, 9, 8, 7, 4].map((v) => v + 2);
const DEMAND_SUM = DEMAND.reduce((t, v) => t + v, 0);
// Доля дневного спроса, пришедшаяся на интервал [h1, h2) (часы могут быть дробными)
function demandShare(h1: number, h2: number): number {
  let s = 0;
  for (let h = Math.floor(h1); h < Math.ceil(h2); h++) {
    const a = Math.max(h1, h), b = Math.min(h2, h + 1);
    if (b > a) s += DEMAND[((h % 24) + 24) % 24] * (b - a);
  }
  return s / DEMAND_SUM;
}

const round = (v: number, k = 2) => Math.round(v * 10 ** k) / 10 ** k;
const roundBid = (v: number) => Math.round(v * 2) / 2; // шаг 0,5 ₽
const fmt = (v: number) => v.toLocaleString('ru-RU', { maximumFractionDigits: 1 });

interface State {
  baseBid?: number; lastChangeAt?: string; lastBudgetAt?: string;
  day?: string; changes?: number;
  pending?: { at: string; prevBid: number; prevBase: number; viewsBefore: number; shareBefore: number };
  lastLogAt?: string; lastReason?: string;
}

export interface Decision {
  campaignId: string; action: string; from?: number; to?: number; reasons: string[]; metrics: Record<string, unknown>; applied: boolean;
}

// Остатки на складах Ozon (FBO) по SKU — кэш на час
let stockCache: { at: number; by: Map<string, number> } | null = null;
async function fboStock(skus: string[]): Promise<Map<string, number>> {
  if (stockCache && Date.now() - stockCache.at < 3600_000 && skus.every((s) => stockCache!.by.has(s))) return stockCache.by;
  const by = new Map<string, number>(stockCache?.by ?? []);
  if (ozonConfigured()) {
    const r = await ozon<{ items?: any[] }>('/v1/analytics/stocks', { skus });
    for (const s of skus) by.set(s, 0);
    for (const it of r.items ?? []) by.set(String(it.sku), (by.get(String(it.sku)) ?? 0) + (it.available_stock_count ?? 0));
  }
  stockCache = { at: Date.now(), by };
  return by;
}

async function dailyAgg(campaignId: string, fromDay: string, toDayExcl: string) {
  const rows = await prisma.adDayCampaign.findMany({ where: { campaignId, date: { gte: new Date(fromDay + 'T00:00:00Z'), lt: new Date(toDayExcl + 'T00:00:00Z') } } });
  const s = (k: 'views' | 'clicks' | 'toCart' | 'orders' | 'ordersMoney' | 'spend') => rows.reduce((t, r) => t + r[k], 0);
  return { clicks: s('clicks'), carts: s('toCart'), orders: s('orders'), ordersMoney: s('ordersMoney'), spend: s('spend') };
}

async function writeLog(d: Decision) {
  await prisma.adBidderLog.create({ data: { campaignId: d.campaignId, action: d.action, fromValue: d.from ?? null, toValue: d.to ?? null, reason: d.reasons.join(' · '), metrics: d.metrics as any } });
}

export async function getBidder(campaignId: string) {
  const cfg = await prisma.adBidder.findUnique({ where: { campaignId } });
  const logs = await prisma.adBidderLog.findMany({ where: { campaignId }, orderBy: { at: 'desc' }, take: 60 });
  return {
    campaignId, enabled: cfg?.enabled ?? false, goal: cfg?.goal ?? 'CART', targetCpo: cfg?.targetCpo ?? 220, targetDrr: cfg?.targetDrr ?? 0.25,
    mods: { ...DEFAULT_MODS, ...(cfg?.mods as object ?? {}) }, limits: { ...DEFAULT_LIMITS, ...(cfg?.limits as object ?? {}) },
    state: cfg?.state ?? null, updatedAt: cfg?.updatedAt ?? null, updatedBy: cfg?.updatedBy ?? null, logs,
  };
}

export async function saveBidder(campaignId: string, data: { enabled: boolean; goal: string; targetCpo: number; targetDrr: number; mods: Partial<Mods>; limits: Partial<Limits> }, email: string | null) {
  const prev = await prisma.adBidder.findUnique({ where: { campaignId } });
  const mods = { ...DEFAULT_MODS, ...data.mods }, limits = { ...DEFAULT_LIMITS, ...data.limits };
  // при включении базовая ставка = текущая; состояние обнуляется
  const resetState = !prev?.enabled && data.enabled;
  await prisma.adBidder.upsert({
    where: { campaignId },
    create: { campaignId, enabled: data.enabled, goal: data.goal, targetCpo: data.targetCpo, targetDrr: data.targetDrr, mods, limits, state: {}, updatedBy: email },
    update: { enabled: data.enabled, goal: data.goal, targetCpo: data.targetCpo, targetDrr: data.targetDrr, mods, limits, updatedBy: email, ...(resetState ? { state: {} } : {}) },
  });
  if (prev?.enabled !== data.enabled) {
    await prisma.adBidderLog.create({ data: { campaignId, action: data.enabled ? 'ON' : 'OFF', reason: `Биддер ${data.enabled ? 'включён' : 'выключен'}${email ? ` · ${email}` : ''}` } });
    const meta = await campaignMeta();
    const c = meta.cpcAll.find((x) => x.id === campaignId);
    for (const p of c?.products ?? []) {
      await prisma.adJournal.create({ data: { sku: p.sku, campaignId, kind: 'NOTE', source: 'AUTO', at: new Date(), userEmail: email, text: `РК ${campaignId}: биддер ${data.enabled ? `включён — цель ${data.goal === 'CART' ? 'цена корзины' : data.goal === 'ORDER' ? 'цена заказа' : 'ДРР'}, заказ ≤ ${fmt(data.targetCpo)} ₽` : 'выключен'}` } });
    }
  }
  return getBidder(campaignId);
}

// Одно решение по кампании. dry — посчитать, ничего не меняя
export async function runBidder(campaignId: string, { dry = false } = {}): Promise<Decision | null> {
  const saved = await prisma.adBidder.findUnique({ where: { campaignId } });
  // предпросмотр работает и без сохранённых настроек — с настройками по умолчанию
  const cfg = saved ?? (dry ? { campaignId, enabled: false, goal: 'CART', targetCpo: 220, targetDrr: 0.25, mods: {}, limits: {}, state: {} } : null);
  if (!cfg || (!cfg.enabled && !dry)) return null;
  const mods: Mods = { ...DEFAULT_MODS, ...(cfg.mods as object) };
  const L: Limits = { ...DEFAULT_LIMITS, ...(cfg.limits as object) };
  const st: State = { ...(cfg.state as State ?? {}) };
  const now = new Date();
  const msk = new Date(now.getTime() + MSK);
  const today = ymd(msk);
  const hour = msk.getUTCHours() + msk.getUTCMinutes() / 60;
  const reasons: string[] = [];
  const metrics: Record<string, unknown> = { hour: round(hour, 1) };
  const done = async (action: string, extra: Partial<Decision> = {}): Promise<Decision> => {
    const d: Decision = { campaignId, action, reasons, metrics, applied: false, ...extra };
    if (!dry) {
      // «без изменений» пишем не чаще раза в 3 часа или при смене причины
      const reason = reasons.join(' · ');
      const quiet = action === 'HOLD' && st.lastReason === reason && st.lastLogAt && now.getTime() - new Date(st.lastLogAt).getTime() < 3 * 3600_000;
      if (!quiet) { await writeLog(d); st.lastLogAt = now.toISOString(); st.lastReason = reason; }
      await prisma.adBidder.update({ where: { campaignId }, data: { state: st as any } });
    }
    return d;
  };

  const meta = await campaignMeta();
  const c = meta.cpcAll.find((x) => x.id === campaignId);
  if (!c) { reasons.push('кампания не найдена в Ozon'); return done('ERROR'); }
  if (!['CAMPAIGN_STATE_RUNNING', 'CAMPAIGN_STATE_STOPPED'].includes(c.state)) { reasons.push('кампания выключена — биддер ждёт'); return done('HOLD'); }
  if (!c.products.length) { reasons.push('в кампании нет товаров'); return done('HOLD'); }
  if (hour < L.hourFrom || hour >= L.hourTo) { reasons.push(`вне рабочих часов ${L.hourFrom}:00–${L.hourTo}:00`); return done('HOLD'); }

  const curBid = c.products.reduce((t, p) => t + p.bid, 0) / c.products.length;
  const base = st.baseBid ?? curBid;
  metrics.bid = round(curBid);

  // 1. Калибровка по дням: конверсия корзины в заказ за 28 и за 3 последних полных дня
  const d28 = await dailyAgg(campaignId, ymd(new Date(msk.getTime() - 28 * DAY)), today);
  const d3 = await dailyAgg(campaignId, ymd(new Date(msk.getTime() - 3 * DAY)), today);
  const d2 = await dailyAgg(campaignId, ymd(new Date(msk.getTime() - 2 * DAY)), today);
  const conv28 = d28.carts >= 60 ? d28.orders / d28.carts : null;
  const conv3 = d3.carts >= 30 ? d3.orders / d3.carts : null;
  const drift = conv28 && conv3 != null ? conv3 / conv28 : null;
  const freeze = drift != null && drift < 0.67;
  Object.assign(metrics, { conv28: conv28 && round(conv28, 3), conv3: conv3 != null ? round(conv3, 3) : null, drift: drift && round(drift, 2), freeze });

  // 2. Окно внутри дня: 6 ч, при малом числе корзин — 12 или 24 ч
  const rows = await prisma.adIntraday.findMany({ where: { campaignId, at: { gte: new Date(now.getTime() - 50 * 3600_000) } }, orderBy: { at: 'asc' } });
  const inc = increments(rows);
  const win = (h: number, toMs = now.getTime()) => inc.filter((x) => x.at.getTime() > toMs - h * 3600_000 && x.at.getTime() <= toMs)
    .reduce((t, x) => ({ views: t.views + x.views, clicks: t.clicks + x.clicks, carts: t.carts + x.toCart, orders: t.orders + x.orders, spend: t.spend + x.spend }), { views: 0, clicks: 0, carts: 0, orders: 0, spend: 0 });
  let W = 6, w = win(6);
  if (w.carts < 25) { W = 12; w = win(12); }
  if (w.carts < 25) { W = 24; w = win(24); }
  Object.assign(metrics, { window: W, views: w.views, clicks: w.clicks, carts: w.carts, spend: round(w.spend) });

  // 3. Отклонение от цели (r > 1 — дорого, r < 1 — дёшево)
  let r: number | null = null;
  const tCart = cfg.targetCpo * (conv28 ?? 0.4);
  if (cfg.goal === 'CART' && !freeze) {
    if (w.carts >= 10) { r = (w.spend / w.carts) / tCart; reasons.push(`корзина ${fmt(w.spend / w.carts)} ₽ за ${W} ч при цели ${fmt(tCart)} ₽ (заказ ${fmt(cfg.targetCpo)} ₽ × конверсия ${fmt((conv28 ?? 0.4) * 100)}%)`); }
  } else if (cfg.goal === 'DRR') {
    if (d2.ordersMoney > 0) { r = (d2.spend / d2.ordersMoney) / cfg.targetDrr; reasons.push(`ДРР ${fmt(d2.spend / d2.ordersMoney * 100)}% за 2 дня при цели ${fmt(cfg.targetDrr * 100)}%`); }
  } else {
    if (d2.orders >= 5) { r = (d2.spend / d2.orders) / cfg.targetCpo; reasons.push(`${freeze ? 'перестраховка: ' : ''}заказ ${fmt(d2.spend / d2.orders)} ₽ за 2 дня при цели ${fmt(cfg.targetCpo)} ₽`); }
  }
  if (freeze) reasons.unshift(`конверсия корзины в заказ упала: ${fmt(conv3! * 100)}% против ${fmt(conv28! * 100)}% нормы — ставку не повышаю, сужу по заказам`);
  if (r == null) reasons.push('мало данных для решения');
  metrics.r = r != null ? round(r, 2) : null;

  let adj = 0;
  if (r != null) {
    if (r > 1.15) adj = -Math.min(L.maxStepPct / 100, (r - 1) * 0.5);
    else if (r < 0.85 && !freeze) adj = Math.min(L.maxStepPct / 100, (1 - r) * 0.5);
  }
  // стоп-лосс: 3 часа тратим без корзин
  const w3 = win(3);
  const stopLoss = w3.spend >= L.stopLossRub && w3.carts === 0;
  if (stopLoss) { adj = -L.maxStepPct / 100; reasons.push(`стоп: ${fmt(w3.spend)} ₽ за 3 ч без корзин`); }

  // обучение кампании: после изменения ждём паузу и минимум кликов
  const sinceChange = st.lastChangeAt ? inc.filter((x) => x.at > new Date(st.lastChangeAt!)).reduce((t, x) => t + x.clicks, 0) : Infinity;
  const coolLeft = st.lastChangeAt ? L.cooldownMin - (now.getTime() - new Date(st.lastChangeAt).getTime()) / 60_000 : 0;
  if (adj !== 0 && !stopLoss && (coolLeft > 0 || sinceChange < L.minClicks)) {
    reasons.push(coolLeft > 0 ? `пауза после изменения: ещё ${Math.ceil(coolLeft)} мин` : `обучение: ${sinceChange} из ${L.minClicks} кликов после изменения`);
    adj = 0;
  }
  let newBase = base * (1 + adj);

  // 4. Проверка отклика показов на прошлое повышение
  if (mods.elastic && st.pending && now.getTime() - new Date(st.pending.at).getTime() >= 2 * 3600_000) {
    const p = st.pending; const pAt = new Date(p.at).getTime();
    const after = win((now.getTime() - pAt) / 3600_000);
    const hAt = new Date(pAt + MSK).getUTCHours() + new Date(pAt + MSK).getUTCMinutes() / 60;
    const shareAfter = demandShare(hAt, hAt + (now.getTime() - pAt) / 3600_000);
    const rateBefore = p.viewsBefore / Math.max(p.shareBefore, 1e-6), rateAfter = after.views / Math.max(shareAfter, 1e-6);
    const gain = rateBefore > 0 ? rateAfter / rateBefore - 1 : null;
    metrics.elasticGain = gain != null ? round(gain, 3) : null;
    if (gain != null && gain < 0.03) { newBase = p.prevBase; reasons.push(`после повышения ${fmt(p.prevBid)} → показы ${gain >= 0 ? '+' : ''}${fmt(gain * 100)}% (с поправкой на время суток) — возвращаю ставку`); }
    else if (gain != null) reasons.push(`повышение дало показы +${fmt(gain * 100)}% — оставляю`);
    st.pending = undefined;
  }

  // 5. Модификаторы
  let m = 1;
  if (mods.hours) {
    const hm = hour < 7 ? 0.75 : hour >= 17 && hour < 23 ? 1.1 : 1;
    if (hm !== 1) { m *= hm; reasons.push(`часы: ×${hm.toLocaleString('ru-RU')}`); }
  }
  let paceRatio: number | null = null;
  const dayBudget = c.dailyBudget || (c.weeklyBudget ? c.weeklyBudget / 7 : 0);
  if (dayBudget > 0) {
    const spentToday = rows.filter((x) => ymd(x.day) === today).pop()?.spend ?? 0; // снимок хранит накопленное за день
    const expected = dayBudget * demandShare(0, hour);
    paceRatio = hour >= 2 && expected > 0 ? spentToday / expected : null;
    Object.assign(metrics, { dayBudget: round(dayBudget), spentToday: round(spentToday), pace: paceRatio && round(paceRatio, 2) });
    if (mods.pace && paceRatio != null) {
      if (paceRatio > 1.15) { m *= 0.9; reasons.push(`темп: потрачено ${fmt(spentToday)} ₽ при плане ${fmt(expected)} ₽ — притормаживаю`); }
      else if (paceRatio < 0.8 && (r == null || r < 1)) { m *= 1.05; reasons.push(`темп: бюджет недотрачен (${fmt(paceRatio * 100)}% плана)`); }
    }
  }
  if (mods.stock) {
    try {
      const stocks = await fboStock(c.products.map((p) => p.sku));
      const days = await Promise.all(c.products.map(async (p) => {
        const sales = await prisma.adDaySku.findMany({ where: { sku: p.sku, date: { gte: new Date(ymd(new Date(msk.getTime() - 3 * DAY)) + 'T00:00:00Z'), lt: new Date(today + 'T00:00:00Z') } } });
        const perDay = sales.reduce((t, x) => t + x.orders, 0) / 3;
        return perDay > 0 ? (stocks.get(p.sku) ?? 0) / perDay : null;
      }));
      const minDays = Math.min(...days.filter((x): x is number => x != null));
      if (isFinite(minDays)) {
        metrics.stockDays = round(minDays, 1);
        if (minDays < 2) { m *= 0.7; reasons.push(`склад Ozon: запаса на ${fmt(minDays)} дн. — ставка ×0,7 (заказы уходят на FBS)`); }
        else if (minDays < 5) { m *= 0.85; reasons.push(`склад Ozon: запаса на ${fmt(minDays)} дн. — ставка ×0,85`); }
      }
    } catch (e) { metrics.stockError = (e as Error).message.slice(0, 120); }
  }
  if (mods.organic) {
    const skus = c.products.map((p) => p.sku);
    const days = await prisma.adDaySku.findMany({ where: { sku: { in: skus }, date: { gte: new Date(ymd(new Date(msk.getTime() - 9 * DAY)) + 'T00:00:00Z'), lt: new Date(today + 'T00:00:00Z') } } });
    const ad = await prisma.adDayCampaign.findMany({ where: { sku: { in: skus }, date: { gte: new Date(ymd(new Date(msk.getTime() - 9 * DAY)) + 'T00:00:00Z'), lt: new Date(today + 'T00:00:00Z') } } });
    const org = (from: number, to: number) => {
      const a = ymd(new Date(msk.getTime() - from * DAY)), b = ymd(new Date(msk.getTime() - to * DAY));
      const o = days.filter((x) => ymd(x.date) >= a && ymd(x.date) < b).reduce((t, x) => t + x.orders, 0);
      const adO = ad.filter((x) => ymd(x.date) >= a && ymd(x.date) < b).reduce((t, x) => t + x.orders, 0);
      return Math.max(0, o - adO) / Math.max(1, from - to);
    };
    const recent = org(2, 0), before = org(9, 2);
    if (before > 0 && recent / before > 1.5) { m *= 0.8; reasons.push(`органика: ${fmt(recent)} заказов в день против ${fmt(before)} — ставка ×0,8`); }
  }

  // 6. Итоговая ставка с ограничителями
  let target = newBase * m;
  target = Math.min(L.maxBid, Math.max(L.minBid, target));
  const maxStep = curBid * L.maxStepPct / 100;
  target = Math.min(curBid + maxStep, Math.max(curBid - maxStep, target));
  target = roundBid(target);
  metrics.target = target;

  if (st.day !== today) { st.day = today; st.changes = 0; }
  st.baseBid = newBase;

  // 7. Рост бюджета: показатели отличные, а бюджет упирается
  let budgetAction: Decision | null = null;
  if (mods.budgetUp && !freeze && r != null && r < 0.75 && w.carts >= 40 && c.weeklyBudget > 0) {
    const limited = c.state === 'CAMPAIGN_STATE_STOPPED' || (paceRatio != null && paceRatio > 1 && hour < 20);
    const cool = !st.lastBudgetAt || now.getTime() - new Date(st.lastBudgetAt).getTime() > DAY;
    if (limited && cool) {
      const nb = Math.ceil(c.weeklyBudget * 1.25 / 1000) * 1000;
      reasons.push(`корзина дешевле цели на ${fmt((1 - r) * 100)}%, а бюджет ${c.state === 'CAMPAIGN_STATE_STOPPED' ? 'кончился' : 'кончится раньше вечера'} — бюджет ${fmt(c.weeklyBudget)} → ${fmt(nb)} ₽/нед`);
      if (!dry) { await setBudget(campaignId, { weeklyBudget: nb }, ACTOR); st.lastBudgetAt = now.toISOString(); }
      budgetAction = { campaignId, action: 'BUDGET_UP', from: c.weeklyBudget, to: nb, reasons: [...reasons], metrics, applied: !dry };
    }
  }

  const minDelta = Math.max(0.5, curBid * 0.02);
  if (Math.abs(target - curBid) >= minDelta && (st.changes ?? 0) < L.maxChangesPerDay) {
    const up = target > curBid;
    if (up && freeze) { reasons.push('повышение заблокировано перестраховкой'); return done(budgetAction ? 'BUDGET_UP' : 'HOLD', budgetAction ? { from: budgetAction.from, to: budgetAction.to, applied: budgetAction.applied } : {}); }
    if (!dry) {
      for (const p of c.products) await setCpcBid(campaignId, p.sku, roundBid(p.bid * target / curBid), ACTOR);
      st.lastChangeAt = now.toISOString(); st.changes = (st.changes ?? 0) + 1;
      if (up && mods.elastic) {
        const hb = win(2);
        st.pending = { at: now.toISOString(), prevBid: curBid, prevBase: base, viewsBefore: hb.views, shareBefore: demandShare(hour - 2, hour) };
      }
    }
    return done(up ? 'BID_UP' : 'BID_DOWN', { from: curBid, to: target, applied: !dry });
  }
  if ((st.changes ?? 0) >= L.maxChangesPerDay) reasons.push(`лимит ${L.maxChangesPerDay} изменений в сутки`);
  if (budgetAction) return done('BUDGET_UP', { from: budgetAction.from, to: budgetAction.to, applied: budgetAction.applied });
  return done('HOLD', { from: curBid, to: curBid });
}

export async function runAllBidders() {
  const list = await prisma.adBidder.findMany({ where: { enabled: true } });
  for (const b of list) {
    // Ozon не принял ставку — не повторять ту же попытку каждые 30 минут: пауза 6 часов (одна запись в журнал вместо сотни)
    const last = await prisma.adBidderLog.findFirst({ where: { campaignId: b.campaignId }, orderBy: { at: 'desc' } });
    if (last?.action === 'ERROR' && /диапазон/.test(last.reason) && Date.now() - last.at.getTime() < 6 * 3600_000) continue;
    try { await runBidder(b.campaignId); } catch (e) {
      const msg = (e as Error).message;
      const reason = /диапазон/.test(msg) ? `${msg.slice(0, 400)} — Ozon не принимает такую ставку; следующая попытка через 6 часов` : msg.slice(0, 500);
      await prisma.adBidderLog.create({ data: { campaignId: b.campaignId, action: 'ERROR', reason } }).catch(() => {});
    }
  }
}
