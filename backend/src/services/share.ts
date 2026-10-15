import { Response } from 'express';

// Текст для «Поделиться» на телефоне (Telegram, MAX…): что за товар и сколько. Фронт берёт его из заголовка.
export function setShareText(res: Response, lines: (string | null | undefined | false)[]) {
  const text = lines.filter(Boolean).join('\n');
  if (text) res.setHeader('X-Share-Text', encodeURIComponent(text));
}

/** «Шпатлёвка Lowtex, туба 350 г — 42 шт» по каждому товару */
export function qtyLines(items: { name: string; qty: number }[]): string[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.name, (m.get(i.name) ?? 0) + i.qty);
  return [...m].map(([name, qty]) => `${name} — ${Math.round(qty)} шт`);
}

export const ddmm = (day: string) => day.split('-').reverse().slice(0, 2).join('.');

// ───── Имена файлов: латиница, без пробелов — OZON_FBS_123715487_LOWTEX_42QT_KVANT3 ─────

const TR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
export const translit = (s: string) => s.toLowerCase().split('').map((c) => TR[c] ?? c).join('').toUpperCase().replace(/[^A-Z0-9-]+/g, '');

/** Код товара из названия SKU: латинские слова без бренда («Шпатлёвка Lowtex, туба» → LOWTEX, «Unitex PRO» → UNITEX-PRO) */
export function productCode(name: string): string {
  const latin = (name.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []).filter((w) => !/^helmitex$/i.test(w));
  return latin.length ? latin.slice(0, 2).join('-').toUpperCase() : translit(name.split(/[\s,]+/)[0] ?? 'ITEM');
}

/** Код товара(ов) и штуки: LOWTEX_42QT; несколько товаров → MIX_42QT */
export function itemsToken(items: { name: string; qty: number }[]): string {
  const codes = [...new Set(items.map((i) => productCode(i.name)))];
  const qty = Math.round(items.reduce((t, i) => t + i.qty, 0));
  return `${codes.length === 1 ? codes[0] : codes.length ? 'MIX' : 'EMPTY'}_${qty}QT`;
}

export const fileName = (parts: (string | number | null | undefined | false)[], ext = 'pdf') =>
  `${parts.filter((p) => p !== null && p !== undefined && p !== false && p !== '').join('_')}.${ext}`;
