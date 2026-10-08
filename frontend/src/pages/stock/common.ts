export const ITEM_TYPES = [
  { value: 'RAW', label: 'Сырьё', unit: 'кг' },
  { value: 'CONTAINER', label: 'Тара', unit: 'шт' },
  { value: 'PACKAGING', label: 'Упаковка', unit: 'шт' },
  { value: 'LABEL', label: 'Этикетки', unit: 'шт' },
  { value: 'SEMI', label: 'Полуфабрикаты', unit: 'кг' },
  { value: 'PRODUCT', label: 'Готовая продукция', unit: 'шт' },
] as const;

export const typeLabel = (t: string) => ITEM_TYPES.find((x) => x.value === t)?.label ?? t;

export const DOC_TYPES = [
  { value: 'RECEIPT', label: 'Приход', short: 'Приход' },
  { value: 'OPENING', label: 'Ввод начальных остатков', short: 'Нач. остатки' },
  { value: 'ADJUSTMENT', label: 'Корректировка / инвентаризация', short: 'Корректировка' },
  { value: 'MIX', label: 'Замес', short: 'Замес' },
  { value: 'FILL', label: 'Фасовка', short: 'Фасовка' },
  { value: 'QUANT', label: 'Сборка квантов', short: 'Кванты' },
] as const;

const DOC_ROUTE: Record<string, string> = { MIX: 'mix', FILL: 'fill', QUANT: 'quant' };
export const docPath = (d: { id: string; type: string }) => `/stock/${DOC_ROUTE[d.type] ?? 'docs'}/${d.id}`;
export const newDocPath = (type: string) => (DOC_ROUTE[type] ? `/stock/${DOC_ROUTE[type]}/new` : `/stock/docs/new?type=${type}`);

// Отклонение факта от нормы: > 1 % — внимание, > 3 % — критично
export function deviation(plan: number | null | undefined, fact: number | null): { pct: number; cls: string } | null {
  if (!plan || fact == null) return null;
  const pct = ((fact - plan) / plan) * 100;
  const a = Math.abs(pct);
  return { pct, cls: a > 3 ? 'text-red-600 font-bold' : a > 1 ? 'text-amber-700 font-semibold' : 'text-green-700' };
}

export const docTypeLabel = (t: string) => DOC_TYPES.find((x) => x.value === t)?.label ?? t;

export const STATE_LABEL: Record<string, string> = {
  NONE: '',
  UNLABELED: 'без ЧЗ',
  LABELED: 'с ЧЗ',
  IN_QUANT: 'в квантах',
};

export const FBO_STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Кванты подобраны', cls: 'bg-slate-100 text-slate-700' },
  OZON_DRAFT: { label: 'Черновик в Ozon', cls: 'bg-amber-100 text-amber-800' },
  BOOKED: { label: 'Слот забронирован', cls: 'bg-brand-100 text-brand-800' },
  CARGOES_SET: { label: 'Грузоместа переданы', cls: 'bg-brand-100 text-brand-800' },
  LABELS_READY: { label: 'Ожидает отгрузки', cls: 'bg-indigo-100 text-indigo-800' },
  SHIPPED: { label: 'Отгружена', cls: 'bg-green-100 text-green-800' },
  COMPLETED: { label: 'Принята Ozon', cls: 'bg-green-200 text-green-900' },
  CANCELLED: { label: 'Отменена', cls: 'bg-slate-100 text-slate-400' },
};

export const QUANT_STATUS: Record<string, { label: string; cls: string }> = {
  ASSEMBLED: { label: 'На складе', cls: 'bg-green-100 text-green-800' },
  RESERVED: { label: 'В поставке', cls: 'bg-brand-100 text-brand-800' },
  SHIPPED: { label: 'Отгружен', cls: 'bg-slate-100 text-slate-600' },
  DISASSEMBLED: { label: 'Разобран', cls: 'bg-slate-100 text-slate-400' },
};

export const DOC_STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Черновик', cls: 'bg-amber-100 text-amber-800' },
  POSTED: { label: 'Проведён', cls: 'bg-green-100 text-green-800' },
  CANCELLED: { label: 'Отменён', cls: 'bg-slate-100 text-slate-500' },
};

export function fmtQty(n: number | null | undefined, digits = 3): string {
  if (n == null) return '—';
  return n.toLocaleString('ru-RU', { maximumFractionDigits: digits });
}

export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(s: string | null | undefined): string {
  return s ? new Date(s).toLocaleDateString('ru-RU') : '—';
}

// «186,40» → 186.4; пустая строка → null
export function parseNum(s: string): number | null {
  const v = s.replace(/\s/g, '').replace(',', '.');
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const inputCls = 'border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white min-w-0';
export const btnPrimary = 'bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium';
export const btnSecondary = 'border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium';
