// crypto.randomUUID() доступен только в secure context (HTTPS/localhost).
// На голом HTTP-IP он бросает TypeError, из-за чего обработчики падают молча.
// Этот хелпер: использует нативный, если есть, иначе — UUID v4 на crypto.getRandomValues.
export function genId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') {
      const b = new Uint8Array(16);
      c.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40; // version 4
      b[8] = (b[8] & 0x3f) | 0x80; // variant 10
      const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
      return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
    }
  } catch { /* fall through */ }
  // Last-resort fallback (не криптостойкий, но достаточный для id элементов)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
