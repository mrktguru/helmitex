import { getSetting, setSetting } from './ozon';

// Фоновые обновления из Ozon: одно на источник одновременно, статус (когда, ок/ошибка) хранится в базе —
// страницы показывают сохранённые данные сразу, а обновление идёт отдельно и не держит их.

export const SOURCES: Record<string, string> = {
  fbs: 'Отправления FBS',
  'ads-data': 'Статистика по дням',
  'ads-meta': 'Кампании и ставки',
  'ads-prices': 'Цены',
  'ads-actions': 'Акции',
  'ads-refs': 'Товары',
  'ads-intraday': 'Снимок рекламы',
};

export interface SyncState { source: string; label: string; running: boolean; startedAt: string | null; at: string | null; ok: boolean | null; error: string | null }

const running = new Map<string, Promise<unknown>>();
const startedAt = new Map<string, string>();
const key = (s: string) => `sync.${s}`;

/** Запускает fn, если по источнику ничего не идёт; иначе ждёт уже идущее. Итог пишет в статус. */
export function track<T>(source: string, fn: () => Promise<T>): Promise<T> {
  const cur = running.get(source);
  if (cur) return cur as Promise<T>;
  startedAt.set(source, new Date().toISOString());
  const p = (async () => {
    try {
      const r = await fn();
      await setSetting(key(source), { at: new Date().toISOString(), ok: true, error: null });
      return r;
    } catch (e) {
      const prev = await getSetting<{ at: string | null }>(key(source), { at: null });
      // время последнего успешного обновления не затираем — данные на тот момент всё ещё верны
      await setSetting(key(source), { at: prev.at, ok: false, error: (e as Error).message, failedAt: new Date().toISOString() });
      throw e;
    } finally {
      running.delete(source);
      startedAt.delete(source);
    }
  })();
  running.set(source, p);
  return p;
}

/** Запустить в фоне, не дожидаясь (ошибка попадёт в статус и в лог) */
export function kick(source: string, fn: () => Promise<unknown>) {
  track(source, fn).catch((e) => console.warn(`[sync ${source}]`, (e as Error).message));
}

export const isRunning = (source: string) => running.has(source);

export async function syncStatus(sources: string[]): Promise<SyncState[]> {
  return Promise.all(sources.map(async (s) => {
    const v = await getSetting<{ at: string | null; ok: boolean | null; error: string | null }>(key(s), { at: null, ok: null, error: null });
    return { source: s, label: SOURCES[s] ?? s, running: running.has(s), startedAt: startedAt.get(s) ?? null, at: v.at, ok: v.ok, error: v.error };
  }));
}

/** Кэш «отдать сохранённое, обновить в фоне»: в памяти + в базе (переживает перезапуск сервера). */
export function swr<T>(source: string, ttlMs: number, fetcher: () => Promise<T>, codec?: { save: (v: T) => unknown; load: (raw: any) => T }) {
  let mem: { at: number; v: T } | null = null;
  const dbKey = `cache.${source}`;
  async function refresh(): Promise<T> {
    return track(source, async () => {
      const v = await fetcher();
      mem = { at: Date.now(), v };
      await setSetting(dbKey, { at: mem.at, v: codec ? codec.save(v) : v });
      return v;
    });
  }
  return {
    /** force — дождаться свежих данных (после наших действий) */
    async get(force = false): Promise<T> {
      if (force) {
        // идущее фоновое обновление могло начаться до наших изменений — дождаться и запросить заново
        if (isRunning(source)) await running.get(source)!.catch(() => {});
        return refresh();
      }
      if (!mem) {
        const raw = await getSetting<{ at: number; v: any } | null>(dbKey, null);
        if (raw) mem = { at: raw.at, v: codec ? codec.load(raw.v) : raw.v };
      }
      if (!mem) return refresh(); // в первый раз ждать приходится — показать нечего
      if (Date.now() - mem.at > ttlMs) kick(source, refresh);
      return mem.v;
    },
    set(v: T) { mem = { at: Date.now(), v }; },
    reset() { mem = null; },
  };
}
