// Цвета источников: проверены на различимость при дальтонизме (ΔE 11,7) — реклама и органика
export const AD = '#0A9A8E';
export const ORG = '#EB6834';
// Последовательная шкала для тепловой карты — бирюзовая шкала дизайн-системы
export const RAMP = ['#EEF7F6', '#D6ECEA', '#AED8D4', '#7FBFB9', '#46A29A', '#178A82', '#0D6B66', '#0A5652', '#084441'];

export const fmt = (v: number | null | undefined, digits = 0) =>
  v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
export const rub = (v: number | null | undefined) => (v == null ? '—' : `${fmt(v)} ₽`);
export const pct = (v: number | null | undefined, digits = 1) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toLocaleString('ru-RU', { maximumFractionDigits: digits })}%`);

// Изменение к прошлому периоду: текст и «хорошо ли это»
export function delta(cur: number | null | undefined, prev: number | null | undefined, higherIsBetter = true) {
  if (cur == null || prev == null || !prev) return null;
  const d = (cur - prev) / Math.abs(prev);
  return { text: `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d * 100))}%`, good: d === 0 ? null : (d > 0) === higherIsBetter };
}
// Для долей (ДРР) — разница в процентных пунктах
export function deltaPp(cur: number | null | undefined, prev: number | null | undefined, higherIsBetter = true) {
  if (cur == null || prev == null) return null;
  const d = (cur - prev) * 100;
  return { text: `${d >= 0 ? '+' : '−'}${Math.abs(d).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} п.п.`, good: Math.abs(d) < 0.05 ? null : (d > 0) === higherIsBetter };
}

export const DAY = 86_400_000;
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => iso(new Date(new Date(s + 'T00:00:00Z').getTime() + n * DAY));
export const short = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
export const longDate = (s: string) => new Date(s + 'T00:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
export const weekday = (s: string) => new Date(s + 'T00:00:00Z').toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' });

export const KIND: Record<string, { label: string; cls: string }> = {
  PRICE: { label: 'Цена', cls: 'bg-violet-100 text-violet-800' },
  ACTION_PRICE: { label: 'Цена в акции', cls: 'bg-violet-100 text-violet-800' },
  BID: { label: 'Ставка', cls: 'bg-brand-100 text-brand-800' },
  BUDGET: { label: 'Бюджет', cls: 'bg-brand-100 text-brand-800' },
  CAMPAIGN_ON: { label: 'РК включена', cls: 'bg-green-100 text-green-800' },
  CAMPAIGN_OFF: { label: 'РК выключена', cls: 'bg-slate-200 text-slate-700' },
  CAMPAIGN_NEW: { label: 'Новая РК', cls: 'bg-green-100 text-green-800' },
  CPO_ON: { label: 'Оплата за заказ', cls: 'bg-amber-100 text-amber-800' },
  CPO_OFF: { label: 'Оплата за заказ', cls: 'bg-amber-100 text-amber-800' },
  CPO_BID: { label: 'Ставка за заказ', cls: 'bg-amber-100 text-amber-800' },
  PROMO: { label: 'Акция', cls: 'bg-pink-100 text-pink-800' },
  NOTE: { label: 'Заметка', cls: 'bg-slate-100 text-slate-700' },
};
export const MANUAL_KINDS = ['NOTE', 'PROMO', 'PRICE', 'BID', 'BUDGET', 'CAMPAIGN_ON', 'CAMPAIGN_OFF', 'CPO_BID'];

export const CAMPAIGN_STATE: Record<string, { label: string; on: boolean }> = {
  CAMPAIGN_STATE_RUNNING: { label: 'Активна', on: true },
  CAMPAIGN_STATE_INACTIVE: { label: 'Выключена', on: false },
  CAMPAIGN_STATE_STOPPED: { label: 'Остановлена', on: false },
  CAMPAIGN_STATE_PLANNED: { label: 'Запланирована', on: false },
  CAMPAIGN_STATE_MODERATION_DRAFT: { label: 'Черновик', on: false },
  CAMPAIGN_STATE_MODERATION_IN_PROGRESS: { label: 'На модерации', on: false },
  CAMPAIGN_STATE_MODERATION_FAILED: { label: 'Не прошла модерацию', on: false },
  CAMPAIGN_STATE_FINISHED: { label: 'Завершена', on: false },
  CAMPAIGN_STATE_ARCHIVED: { label: 'В архиве', on: false },
};

export function placementLabel(p: string[]) {
  if (!p?.length) return 'клик';
  return p.map((x) => (x === 'PLACEMENT_TOP_PROMOTION' ? 'поиск' : x === 'PLACEMENT_SEARCH_AND_CATEGORY' ? 'поиск и рекомендации' : x.replace('PLACEMENT_', '').toLowerCase())).join(', ');
}

// Средние в день за N дней до и после даты (день события не учитывается)
export function beforeAfter(series: any[], date: string, n = 3) {
  const i = series.findIndex((x) => x.date === date);
  if (i < 0) return null;
  const before = series.slice(Math.max(0, i - n), i);
  const after = series.slice(i + 1, i + 1 + n);
  if (!before.length || !after.length) return { pending: true as const, need: n - after.length };
  const avg = (rows: any[], f: (r: any) => number) => rows.reduce((t, r) => t + f(r), 0) / rows.length;
  const spend = (r: any) => r.spendClick + r.spendSelected + r.spendAll;
  const m = [
    { label: 'Показы', f: (r: any) => r.views, good: true },
    { label: 'В поиске', f: (r: any) => r.searchViews, good: true },
    { label: 'Корзины', f: (r: any) => r.toCart, good: true },
    { label: 'Заказы', f: (r: any) => r.orders, good: true },
    { label: 'Расход', f: spend, good: false },
  ];
  return {
    pending: false as const,
    window: `${short(before[0].date)}–${short(before[before.length - 1].date)} → ${short(after[0].date)}–${short(after[after.length - 1].date)}`,
    rows: m.map((x) => { const b = avg(before, x.f), a = avg(after, x.f); return { label: x.label, b, a, d: delta(a, b, x.good) }; }),
  };
}

export const parseNum = (s: string): number | null => {
  const v = s.replace(/\s/g, '').replace(',', '.');
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
