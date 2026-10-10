import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../api/client';
import { KIND, MANUAL_KINDS, beforeAfter, fmt, short } from './util';

const pad = (n: number) => String(n).padStart(2, '0');
const localNow = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtAt = (s: string) => new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
// Дата записи для сопоставления с днями отчёта — по Москве
export const entryDay = (s: string) => new Date(new Date(s).getTime() + 3 * 3600_000).toISOString().slice(0, 10);

export default function Journal({ entries, anomalies, series, sku, onChanged, focus }: {
  entries: any[]; anomalies: { date: string; text: string }[]; series: any[]; sku: string; onChanged: () => Promise<void>; focus: { date: string; key: number } | null;
}) {
  const [at, setAt] = useState(localNow);
  const [kind, setKind] = useState('NOTE');
  const [text, setText] = useState('');
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'MANUAL' | 'AUTO'>('all');
  const textRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // Номера — по порядку во времени, как на графике
  const numbered = [...entries].sort((a, b) => a.at.localeCompare(b.at)).map((e, i) => ({ ...e, n: i + 1 }));
  const shown = numbered.filter((e) => filter === 'all' || e.source === filter).reverse();

  useEffect(() => {
    if (!focus) return;
    const e = numbered.find((x) => entryDay(x.at) === focus.date);
    if (e) {
      setOpen(e.id);
      listRef.current?.querySelector(`[data-id="${e.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      explain(focus.date);
    }
  }, [focus?.key]);

  function explain(date: string) {
    setAt(`${date}T12:00`); setKind('NOTE'); setText(''); setAll(false);
    setTimeout(() => { textRef.current?.focus(); textRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 0);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) { setError('Опишите, что сделали'); return; }
    setBusy(true); setError('');
    try {
      await api.adsJournalAdd({ sku: all ? null : sku, at: new Date(at).toISOString(), kind, text: text.trim() });
      setText(''); setAt(localNow());
      await onChanged();
    } catch (err: any) { setError(err.message); }
    setBusy(false);
  }
  async function remove(id: string) {
    if (!confirm('Удалить запись?')) return;
    try { await api.adsJournalDelete(id); await onChanged(); } catch (err: any) { setError(err.message); }
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-3 border-b border-slate-100">
        <div>
          <h2 className="font-semibold">Журнал изменений</h2>
          <p className="text-xs text-slate-500 mt-0.5">Ставки, бюджеты, цены и кампании из сервиса записываются сами. Остальное — вручную. Нажмите на запись — покажу, что изменилось за 3 дня до и после.</p>
        </div>
        <div className="inline-flex border border-slate-200 rounded-lg overflow-hidden text-sm">
          {([['all', 'Все'], ['MANUAL', 'Вручную'], ['AUTO', 'Авто']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={clsx('px-3 py-1.5', filter === k ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>{l}</button>
          ))}
        </div>
      </div>

      <form onSubmit={add} className="px-5 py-4 bg-slate-50/70 border-b border-slate-100 grid gap-3 sm:grid-cols-[190px_190px_minmax(0,1fr)] items-end">
        <label className="text-xs text-slate-500 flex flex-col gap-1">Когда
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="border rounded-lg px-2.5 py-1.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">Тип
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="border rounded-lg px-2.5 py-1.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500">
            {MANUAL_KINDS.map((k) => <option key={k} value={k}>{KIND[k].label}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1 min-w-0 sm:col-span-2">Что сделали или что произошло
          <input ref={textRef} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Например: вошли в акцию «Осенняя распродажа», блогер выпустил обзор"
            className="border rounded-lg px-2.5 py-1.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </label>
        <button disabled={busy} className="justify-self-start bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium">{busy ? 'Сохраняю…' : 'Записать'}</button>
        <label className="sm:col-span-3 flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="accent-brand-600" />
          Общее событие для всех товаров (например, акция Ozon на весь кабинет)
        </label>
        {error && <p className="sm:col-span-3 text-sm text-red-600">{error}</p>}
      </form>

      {anomalies.length > 0 && (
        <div className="px-5 py-3 border-b border-slate-100 space-y-2">
          {anomalies.map((a) => (
            <div key={a.date} className="flex flex-wrap items-center gap-3 text-sm bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              <span className="w-5 h-5 rounded-full border-2 border-red-500 text-red-600 text-[10px] font-semibold flex items-center justify-center">!</span>
              <span className="tabular-nums text-slate-500">{short(a.date)}</span>
              <span className="flex-1 min-w-[200px]">{a.text}</span>
              <button onClick={() => explain(a.date)} className="text-brand-700 hover:underline text-sm">Указать причину</button>
            </div>
          ))}
        </div>
      )}

      <ol ref={listRef} className="divide-y divide-slate-100 max-h-[560px] overflow-y-auto">
        {shown.length === 0 && <li className="px-5 py-6 text-sm text-slate-500">Записей за период нет.</li>}
        {shown.map((e) => {
          const k = KIND[e.kind] ?? { label: e.kind, cls: 'bg-slate-100 text-slate-700' };
          const isOpen = open === e.id;
          const ba = isOpen ? beforeAfter(series, entryDay(e.at)) : null;
          return (
            <li key={e.id} data-id={e.id} className={clsx(isOpen && 'bg-brand-50/40')}>
              <div className="flex items-start gap-3 px-5 py-3">
                <span className="w-6 h-6 rounded-full bg-slate-800 text-white text-[11px] font-semibold flex items-center justify-center flex-none mt-0.5">{e.n}</span>
                <button onClick={() => setOpen(isOpen ? null : e.id)} className="flex-1 min-w-0 text-left" aria-expanded={isOpen}>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="tabular-nums">{fmtAt(e.at)}</span>
                    <span className={clsx('px-1.5 py-0.5 rounded-full font-medium', k.cls)}>{k.label}</span>
                    <span>{e.source !== 'AUTO' ? 'вручную' : e.text.includes('в кабинете Ozon') ? 'найдено в кабинете Ozon' : 'из сервиса'}{e.userEmail ? ` · ${e.userEmail}` : ''}</span>
                    {!e.sku && <span className="px-1.5 py-0.5 rounded-full bg-slate-100">все товары</span>}
                  </div>
                  <div className="text-sm mt-0.5">{e.text}</div>
                </button>
                {e.source === 'MANUAL' && <button onClick={() => remove(e.id)} className="text-xs text-slate-400 hover:text-red-600 px-2 py-1" aria-label="Удалить запись">Удалить</button>}
              </div>
              {isOpen && ba && (
                <div className="px-5 pb-4 pl-14">
                  {ba.pending ? (
                    <p className="text-sm text-slate-500">Эффект посчитаю, когда наберутся полные дни после события (нужно ещё {ba.need} дн.) или расширьте период.</p>
                  ) : (
                    <div className="space-y-1">
                      <div className="text-xs text-slate-500">Среднее в день: {ba.window}</div>
                      <div className="flex flex-wrap gap-x-6 gap-y-2">
                        {ba.rows.map((r) => (
                          <div key={r.label} className="tabular-nums">
                            <div className="text-xs text-slate-500">{r.label}</div>
                            <div className="text-sm">{fmt(r.b)} → <b>{fmt(r.a)}</b> {r.d && <span className={clsx('text-xs', r.d.good === true && 'text-green-700', r.d.good === false && 'text-red-600')}>{r.d.text}</span>}</div>
                          </div>
                        ))}
                      </div>
                      <p className="text-[11px] text-slate-400">Если в эти дни было несколько событий, эффект смешан.</p>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
