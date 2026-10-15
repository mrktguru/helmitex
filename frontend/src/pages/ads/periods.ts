// Периоды (дни / недели / месяцы), показатели и разница с предыдущим периодом для таблиц аналитики
import type { CSSProperties } from 'react';
import { fmt } from './util';

export type Gran = 'day' | 'week' | 'month';
export type Kind = 'n' | 'm' | 'r' | 'x' | 'a'; // количество, деньги, доля (п.п.), позиция (разность), среднее (без нормировки на дни)

export interface Metric { g: string; k: string; l: string; f: (v: number | null | undefined) => string; kind: Kind; up: 1 | -1 | 0; hint?: string }
export interface Bucket { key: string; days: number; dates: string[]; [k: string]: any }

const MON = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const dd = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const rub = (v: number | null | undefined) => (v == null || !isFinite(v) ? '—' : `${fmt(v)} ₽`);
const rub1 = (v: number | null | undefined) => (v == null || !isFinite(v) ? '—' : `${fmt(v, 1)} ₽`);
const pc = (d: number) => (v: number | null | undefined) => (v == null || !isFinite(v) ? '—' : `${(v * 100).toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d })}%`);
const n0 = (v: number | null | undefined) => (v == null || !isFinite(v) ? '—' : fmt(v));
const n1 = (v: number | null | undefined) => (v == null || !isFinite(v) ? '—' : fmt(v, 1));

export const PRODUCT_METRICS: Metric[] = [
  { g: 'Трафик', k: 'views', l: 'Показы', f: n0, kind: 'n', up: 1 },
  { g: 'Трафик', k: 'searchViews', l: 'Показы в поиске', f: n0, kind: 'n', up: 1 },
  { g: 'Трафик', k: 'pdpViews', l: 'Переходы в карточку', f: n0, kind: 'n', up: 1 },
  { g: 'Трафик', k: 'ctrCard', l: 'CTR карточки', f: pc(2), kind: 'r', up: 1, hint: 'переходы / показы' },
  { g: 'Трафик', k: 'position', l: 'Позиция в категории', f: n1, kind: 'x', up: -1 },
  { g: 'Корзина и заказ', k: 'toCart', l: 'Корзины', f: n0, kind: 'n', up: 1 },
  { g: 'Корзина и заказ', k: 'cartConv', l: 'Карточка → корзина', f: pc(1), kind: 'r', up: 1 },
  { g: 'Корзина и заказ', k: 'orders', l: 'Заказы', f: n0, kind: 'n', up: 1 },
  { g: 'Корзина и заказ', k: 'buyConv', l: 'Корзина → заказ', f: pc(1), kind: 'r', up: 1 },
  { g: 'Корзина и заказ', k: 'org', l: 'Органические заказы', f: n0, kind: 'n', up: 1, hint: 'заказы минус заказы с рекламных кликов' },
  { g: 'Корзина и заказ', k: 'orgShare', l: 'Доля органики', f: pc(0), kind: 'r', up: 1 },
  { g: 'Корзина и заказ', k: 'revenue', l: 'Выручка', f: rub, kind: 'm', up: 1 },
  { g: 'Корзина и заказ', k: 'avgPrice', l: 'Средний чек', f: rub, kind: 'a', up: 1 },
  { g: 'Реклама', k: 'adViews', l: 'Рекламные показы', f: n0, kind: 'n', up: 1 },
  { g: 'Реклама', k: 'adClicks', l: 'Клики', f: n0, kind: 'n', up: 1 },
  { g: 'Реклама', k: 'adCtr', l: 'CTR рекламы', f: pc(2), kind: 'r', up: 1 },
  { g: 'Реклама', k: 'cpc', l: 'Цена клика', f: rub1, kind: 'a', up: -1 },
  { g: 'Реклама', k: 'spendClick', l: 'Расход на клики', f: rub, kind: 'm', up: -1 },
  { g: 'Реклама', k: 'spend', l: 'Расход всего', f: rub, kind: 'm', up: -1, hint: 'клики + оплата за заказ (≈ доля по выручке)' },
  { g: 'Реклама', k: 'drr', l: 'ДРР', f: pc(1), kind: 'r', up: -1 },
  { g: 'Реклама', k: 'cpo', l: 'Реклама на заказ', f: rub, kind: 'a', up: -1 },
  { g: 'Деньги', k: 'payoutEst', l: 'Выплата Ozon (по заказам)', f: rub, kind: 'm', up: 1, hint: 'заказано шт × средняя выплата за штуку за 14 дней' },
  { g: 'Деньги', k: 'accrPayout', l: 'Выплата Ozon (начислено)', f: rub, kind: 'm', up: 1, hint: 'по дате доставки — для сверки с деньгами' },
  { g: 'Деньги', k: 'ozonShare', l: 'Скидка за счёт Ozon', f: pc(0), kind: 'r', up: 0 },
  { g: 'Деньги', k: 'profit', l: 'Прибыль после рекламы', f: rub, kind: 'm', up: 1, hint: 'выплата по заказам − реклама − себестоимость заказанных' },
];

export const CAMPAIGN_METRICS: Metric[] = [
  { g: 'Охват', k: 'views', l: 'Показы', f: n0, kind: 'n', up: 1 },
  { g: 'Охват', k: 'clicks', l: 'Клики', f: n0, kind: 'n', up: 1 },
  { g: 'Охват', k: 'ctr', l: 'CTR', f: pc(2), kind: 'r', up: 1 },
  { g: 'Охват', k: 'cpc', l: 'Цена клика', f: rub1, kind: 'a', up: -1 },
  { g: 'Результат', k: 'toCart', l: 'Корзины', f: n0, kind: 'n', up: 1 },
  { g: 'Результат', k: 'clickCart', l: 'Клик → корзина', f: pc(1), kind: 'r', up: 1 },
  { g: 'Результат', k: 'costCart', l: 'Цена корзины', f: rub1, kind: 'a', up: -1 },
  { g: 'Результат', k: 'orders', l: 'Заказы', f: n0, kind: 'n', up: 1 },
  { g: 'Результат', k: 'cartOrder', l: 'Корзина → заказ', f: pc(1), kind: 'r', up: 1 },
  { g: 'Результат', k: 'ordersMoney', l: 'Выручка', f: rub, kind: 'm', up: 1 },
  { g: 'Деньги', k: 'spend', l: 'Расход', f: rub, kind: 'm', up: -1 },
  { g: 'Деньги', k: 'cpo', l: 'Расход на заказ', f: rub, kind: 'a', up: -1 },
  { g: 'Деньги', k: 'drr', l: 'ДРР', f: pc(1), kind: 'r', up: -1 },
  { g: 'Деньги', k: 'budgetUse', l: 'Использовано бюджета', f: pc(0), kind: 'r', up: 0 },
];

export function bucketKey(date: string, g: Gran): string {
  if (g === 'day') return date;
  if (g === 'month') return date.slice(0, 7);
  const d = new Date(date + 'T00:00:00Z');
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

export function bucketLabel(key: string, g: Gran, days: number): { a: string; b: string; weekend?: boolean } {
  if (g === 'day') {
    const w = new Date(key + 'T00:00:00Z').toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' });
    const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    return { a: dd(key), b: key === today ? `${w} · сегодня` : w, weekend: ['сб', 'вс'].includes(w) };
  }
  if (g === 'week') { const e = new Date(new Date(key + 'T00:00:00Z').getTime() + 6 * 86_400_000).toISOString().slice(0, 10); return { a: `${dd(key)}–${dd(e)}`, b: days < 7 ? `${days} из 7 дн.` : 'неделя' }; }
  const [y, m] = key.split('-'); const full = new Date(Date.UTC(+y, +m, 0)).getUTCDate();
  return { a: MON[+m - 1], b: days < full ? `${days} из ${full} дн.` : y };
}

const div = (x: number, y: number) => (y ? x / y : null);

// Данные товара по дням (серия отчёта) → периоды
export function productBuckets(series: any[], g: Gran, netPrice: number): Bucket[] {
  // средняя выплата за штуку — скользящие 14 дней по начислениям
  const unit = series.map((_, i) => { const w = series.slice(Math.max(0, i - 13), i + 1); const q = w.reduce((t, x) => t + x.accrQty, 0); return q > 0 ? w.reduce((t, x) => t + x.accrPayout, 0) / q : null; });
  const out = new Map<string, Bucket>();
  series.forEach((r, i) => {
    const k = bucketKey(r.date, g);
    const b = out.get(k) ?? { key: k, days: 0, dates: [], pos: [] as number[] };
    b.days++; b.dates.push(r.date); if (r.position) b.pos.push(r.position);
    const add = (f: string, v: number) => { b[f] = (b[f] || 0) + (v || 0); };
    for (const f of ['views', 'searchViews', 'pdpViews', 'toCart', 'orders', 'revenue', 'adViews', 'adClicks', 'adCart', 'spendClick', 'accrQty', 'accrSale', 'accrBuyer', 'accrPayout']) add(f, r[f]);
    add('adOrd', Math.min(r.adOrders || 0, r.orders || 0));
    add('spendCpo', (r.spendSelected || 0) + (r.spendAll || 0));
    add('payoutEst', unit[i] != null ? unit[i]! * r.orders : 0);
    add('cogs', netPrice * r.orders);
    out.set(k, b);
  });
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key)).map((a) => {
    a.org = Math.max(0, a.orders - a.adOrd); a.spend = a.spendClick + a.spendCpo;
    a.ctrCard = div(a.pdpViews, a.views); a.cartConv = div(a.toCart, a.pdpViews); a.buyConv = div(a.orders, a.toCart);
    a.orgShare = div(a.org, a.orders); a.avgPrice = div(a.revenue, a.orders); a.adCtr = div(a.adClicks, a.adViews);
    a.cpc = div(a.spendClick, a.adClicks); a.drr = div(a.spend, a.revenue); a.cpo = div(a.spend, a.orders);
    a.ozonShare = a.accrSale > 0 ? 1 - a.accrBuyer / a.accrSale : null;
    a.profit = a.payoutEst - a.spend - a.cogs;
    a.position = a.pos.length ? a.pos.reduce((t: number, v: number) => t + v, 0) / a.pos.length : null;
    return a;
  });
}

export function finishCampaign(b: Bucket, weeklyBudget: number): Bucket {
  return {
    ...b, ctr: div(b.clicks, b.views), cpc: div(b.spend, b.clicks), clickCart: div(b.toCart, b.clicks), costCart: div(b.spend, b.toCart),
    cartOrder: div(b.orders, b.toCart), cpo: div(b.spend, b.orders), drr: div(b.spend, b.ordersMoney),
    budgetUse: weeklyBudget ? b.spend / (weeklyBudget / 7 * (b.frac ?? b.days)) : null,
  };
}

export function campaignBuckets(days: any[], g: Gran, weeklyBudget: number): Bucket[] {
  const out = new Map<string, Bucket>();
  for (const x of days) {
    const k = bucketKey(x.date, g);
    const b = out.get(k) ?? { key: k, days: 0, dates: [], views: 0, clicks: 0, toCart: 0, orders: 0, ordersMoney: 0, spend: 0 };
    b.days++; b.dates.push(x.date);
    for (const f of ['views', 'clicks', 'toCart', 'orders', 'ordersMoney', 'spend']) b[f] += x[f] || 0;
    out.set(k, b);
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key)).map((b) => finishCampaign(b, weeklyBudget));
}

export interface Delta { d: number; t: string; good: boolean | null; m: Metric }
// Разница с предыдущим периодом; неполные периоды сравниваются по среднему в день
export function delta(m: Metric, b: Bucket | undefined, p: Bucket | undefined): Delta | null {
  const c = b?.[m.k], pv = p?.[m.k];
  if (c == null || pv == null || !isFinite(c) || !isFinite(pv) || !b || !p) return null;
  const norm = (m.kind === 'n' || m.kind === 'm') && b.days !== p.days;
  const cv = norm ? c / b.days : c, ppv = norm ? pv / p.days : pv;
  let d: number, t: string;
  if (m.kind === 'r') { d = (cv - ppv) * 100; if (Math.abs(d) < 0.05) return { d: 0, t: '0', good: null, m }; t = `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} п.п.`; }
  else if (m.kind === 'x') { d = cv - ppv; if (Math.abs(d) < 0.05) return { d: 0, t: '0', good: null, m }; t = `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}`; }
  else { if (!ppv) return null; d = (cv - ppv) / Math.abs(ppv); if (Math.abs(d) < 0.005) return { d: 0, t: '0%', good: null, m }; t = d >= 4 ? `×${(1 + d).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}` : `${d > 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100)}%`; }
  return { d, t, good: m.up === 0 ? null : (d > 0) === (m.up > 0), m };
}

// Фон ячейки: зелёный — лучше, оранжевый — хуже; насыщенность — сила изменения
export function heatStyle(x: Delta | null): CSSProperties | undefined {
  if (!x || x.good == null || !x.d) return undefined;
  const a = x.m.kind === 'r' || x.m.kind === 'x' ? Math.min(1, Math.abs(x.d) / 8) : Math.min(1, Math.abs(x.d) / 0.6);
  return { background: x.good ? `rgba(21,128,61,${(0.04 + a * 0.18).toFixed(3)})` : `rgba(234,88,12,${(0.04 + a * 0.18).toFixed(3)})` };
}
export const deltaCls = (x: Delta | null) => (!x || x.good == null ? 'text-slate-400' : x.good ? 'text-green-700' : 'text-orange-700');
