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
] as const;

const DOC_ROUTE: Record<string, string> = { MIX: 'mix', FILL: 'fill' };
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
};

export const DOC_STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Черновик', cls: 'bg-amber-100 text-amber-800' },
  POSTED: { label: 'Проведён', cls: 'bg-green-100 text-green-800' },
  CANCELLED: { label: 'Отменён', cls: 'bg-gray-100 text-gray-500' },
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

export const inputCls = 'border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white min-w-0';
export const btnPrimary = 'bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium';
export const btnSecondary = 'border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium';
