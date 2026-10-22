import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

// Строка «Данные на 14:32 · обновляю…»: страница показывает сохранённое сразу, обновление из Ozon идёт в фоне.

export interface SyncState { source: string; label: string; running: boolean; startedAt: string | null; at: string | null; ok: boolean | null; error: string | null }

const hm = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString('ru-RU', today ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'только что' : m < 60 ? `${m} мин назад` : m < 48 * 60 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} дн назад`;
};

/** Опрос статуса, пока идёт обновление; когда закончилось — onDone (перезагрузить данные без спиннера) */
export function useSyncPoll(initial: SyncState[] | null | undefined, fetchStatus: () => Promise<SyncState[]>, onDone: () => void) {
  const [sync, setSync] = useState<SyncState[] | null>(initial ?? null);
  const wasRunning = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => { if (initial) setSync(initial); }, [initial]);
  const running = !!sync?.some((s) => s.running);
  useEffect(() => {
    if (running) { wasRunning.current = true; const t = window.setTimeout(() => fetchStatus().then(setSync).catch(() => {}), 3000); return () => window.clearTimeout(t); }
    if (wasRunning.current) { wasRunning.current = false; doneRef.current(); }
  }, [sync]);
  return { sync, setSync, running };
}

export default function SyncBar({ sync, onRefresh, busy }: { sync: SyncState[] | null; onRefresh: () => void; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!sync) return null;
  const running = sync.some((s) => s.running);
  const failed = sync.filter((s) => s.ok === false);
  // «данные на» — по самому давнему успешному обновлению среди источников
  const ats = sync.map((s) => s.at).filter((x): x is string => !!x).sort();
  const oldest = ats[0];
  return (
    <div className="text-xs sm:text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button onClick={() => setOpen((v) => !v)} className={clsx('flex items-center gap-1.5 rounded-lg px-2 py-1 -mx-2', failed.length ? 'text-amber-800 hover:bg-amber-50' : 'text-slate-500 hover:bg-slate-100')}>
          <span className={clsx('w-2 h-2 rounded-full', running ? 'bg-brand-500 animate-pulse' : failed.length ? 'bg-amber-500' : 'bg-emerald-500')} />
          {oldest ? <>Данные на {hm(oldest)} <span className="hidden sm:inline">({ago(oldest)})</span></> : 'Данных ещё нет'}
          {running && <span className="text-brand-700 font-medium">· обновляю из Ozon…</span>}
          {!running && failed.length > 0 && <span className="font-medium">· Ozon не ответил</span>}
          <span className="text-slate-400">{open ? '▴' : '▾'}</span>
        </button>
        <button disabled={busy || running} onClick={onRefresh} className="text-brand-700 hover:underline disabled:opacity-50 disabled:no-underline">↻ Обновить</button>
      </div>
      {open && (
        <div className="mt-1.5 rounded-lg border border-slate-200 bg-white divide-y max-w-xl">
          {sync.map((s) => (
            <div key={s.source} className="px-3 py-1.5 flex flex-wrap items-baseline gap-x-2">
              <span className={clsx('w-2 h-2 rounded-full shrink-0 self-center', s.running ? 'bg-brand-500 animate-pulse' : s.ok === false ? 'bg-amber-500' : s.at ? 'bg-emerald-500' : 'bg-slate-300')} />
              <span className="font-medium text-slate-700">{s.label}</span>
              <span className="text-slate-500">{s.running ? 'обновляется…' : s.at ? `обновлено ${hm(s.at)}` : 'ещё не обновлялось'}</span>
              {s.ok === false && s.error && <span className="basis-full text-amber-800 break-words">Ошибка: {s.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
