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
