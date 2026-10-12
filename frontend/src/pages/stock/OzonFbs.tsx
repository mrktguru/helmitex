import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, downloadFile } from '../../api/client';
import { btnPrimary, btnSecondary, fmtMoney, fmtQty } from './common';
import { PageHeader } from './StockLayout';

// Отправки Ozon FBS: мастер отгрузки дня — Новые → Сборка → Этикетки 58×40 → Акт → Передано

const ST: Record<string, [string, string]> = {
  awaiting_packaging: ['Ждёт сборки', 'bg-amber-100 text-amber-800'],
  awaiting_deliver: ['Собрано', 'bg-blue-100 text-blue-800'],
  delivering: ['Передано в Ozon', 'bg-emerald-100 text-emerald-800'],
  driver_pickup: ['У водителя', 'bg-emerald-100 text-emerald-800'],
  delivered: ['Доставлено', 'bg-emerald-200 text-emerald-900'],
  cancelled: ['Отменено', 'bg-slate-100 text-slate-500'],
  not_accepted: ['Не принято', 'bg-rose-100 text-rose-700'],
};
const stPill = (s: string) => <span className={clsx('text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap', ST[s]?.[1] ?? 'bg-slate-100 text-slate-600')}>{ST[s]?.[0] ?? s}</span>;
const PASSED = ['delivering', 'driver_pickup', 'delivered', 'not_accepted'];
const dayLabel = (d: string) => d.split('-').reverse().slice(0, 2).join('.');
const hm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
const dt = (iso: string | null) => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—';
const short = (name: string) => name.replace(/^Шпатлёвка |^Краска Helmitex /, '');

export default function OzonFbs() {
  const [params, setParams] = useSearchParams();
  const [days, setDays] = useState<any[] | null>(null);
  const [data, setData] = useState<any>(null);
  const [step, setStep] = useState<number | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  // день по умолчанию — ближайший с работой, иначе последний
  const day = params.get('day') ?? (days ? (
    [...days].reverse().find((d) => d.counts.awaiting_packaging || d.counts.awaiting_deliver)?.day ?? days[0]?.day
  ) : null);

  async function loadDays(sync = false) {
    setError('');
    try { setDays(sync ? await api.ozonFbsSync() : await api.ozonFbsDays()); } catch (e: any) { setError(e.message); setDays((d) => d ?? []); }
  }
  useEffect(() => { loadDays(true); }, []);
  useEffect(() => { if (day) api.ozonFbsDay(day).then(apply).catch((e) => setError(e.message)); }, [day, days]);

  function apply(d: any) {
    setData(d);
    setSel(new Set(d.postings.filter((p: any) => p.status === 'awaiting_packaging').map((p: any) => p.postingNumber)));
  }

  async function run(key: string, fn: () => Promise<any>, ok?: (r: any) => string) {
    setBusy(key); setError(''); setMsg('');
    try { const r = await fn(); if (ok) setMsg(ok(r)); } catch (e: any) { setError(e.message); }
    setBusy('');
  }

  const P: any[] = data?.postings ?? [];
  const by = (s: string) => P.filter((p) => p.status === s);
  const waiting = by('awaiting_packaging'), packed = by('awaiting_deliver'), passed = P.filter((p) => PASSED.includes(p.status)), cancelled = by('cancelled');
  const notWritten = P.filter((p) => !p.stockDocId && (p.status === 'awaiting_deliver' || PASSED.includes(p.status)));
  const info = data?.info;
  const auto = waiting.length ? 2 : packed.length && !info?.labelS3Key ? 3 : packed.length ? 4 : 5;
  const cur = step ?? auto;
  const shipAt = P[0]?.shipmentDate;

  const units = (list: any[]) => list.reduce((t, p) => t + p.products.reduce((s: number, x: any) => s + x.qty, 0), 0);
  const sum = (list: any[]) => list.reduce((t, p) => t + p.products.reduce((s: number, x: any) => s + x.qty * x.price, 0), 0);

  // Лист подбора по выбранным
  const pick = useMemo(() => {
    const m = new Map<string, { name: string; itemId: string | null; qty: number; posts: number }>();
    for (const p of waiting.filter((x) => sel.has(x.postingNumber))) for (const x of p.products) {
      const k = x.item?.id ?? x.offerId;
      const g = m.get(k) ?? { name: x.item?.name ?? `${x.offerId} (не привязан)`, itemId: x.item?.id ?? null, qty: 0, posts: 0 };
      g.qty += x.qty; g.posts++;
      m.set(k, g);
    }
    return [...m.values()];
  }, [data, sel]);
  const mixes = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of waiting.filter((x) => sel.has(x.postingNumber))) {
      const k = p.products.map((x: any) => `${x.item ? short(x.item.name) : x.offerId} × ${x.qty}`).join(' + ');
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data, sel]);

  const steps = [
    ['Новые', waiting.length ? `${waiting.length} отпр.` : 'нет новых'],
    ['Сборка', waiting.length ? `ждут ${waiting.length}` : 'всё собрано'],
    ['Этикетки 58×40', info?.labelS3Key ? `${info.labelCount} шт. готовы` : packed.length ? `${packed.length} к печати` : '—'],
    ['Акт и отгрузка', info?.actS3Key ? 'акт готов' : shipAt ? `до ${hm(shipAt)}` : '—'],
    ['Передано', `${passed.length} отпр.`],
  ];
  const done = [P.length > 0, !waiting.length && P.length > 0, !!info?.labelS3Key, !!info?.actS3Key, !waiting.length && !packed.length && passed.length > 0];

  const table = (list: any[], checks = false, n = 300) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
          {checks && <th className="pl-4 w-8"><input type="checkbox" checked={list.length > 0 && list.every((p) => sel.has(p.postingNumber))}
            onChange={(e) => setSel(e.target.checked ? new Set(list.map((p) => p.postingNumber)) : new Set())} /></th>}
          <th className="px-3 py-2 font-medium">Отправление</th><th className="px-3 py-2 font-medium">Состав</th>
          <th className="px-3 py-2 font-medium">Принят</th><th className="px-3 py-2 font-medium text-right">Сумма, ₽</th><th className="px-3 py-2 font-medium">Статус</th>
        </tr></thead>
        <tbody>
          {list.slice(0, n).map((p) => (
            <tr key={p.postingNumber} className="border-b border-slate-100 last:border-0">
              {checks && <td className="pl-4"><input type="checkbox" checked={sel.has(p.postingNumber)}
                onChange={() => setSel((s) => { const x = new Set(s); x.has(p.postingNumber) ? x.delete(p.postingNumber) : x.add(p.postingNumber); return x; })} /></td>}
              <td className="px-3 py-2 font-mono text-xs">{p.postingNumber}</td>
              <td className="px-3 py-2">{p.products.map((x: any) => (
                <span key={x.offerId} className={clsx('inline-block mr-1 text-[11px] font-medium px-2 py-0.5 rounded-full', x.item ? 'bg-amber-50 text-amber-800' : 'bg-rose-100 text-rose-700')} title={x.name}>
                  {x.item ? short(x.item.name) : x.offerId} × {x.qty}</span>))}
                {p.shipError && <div className="text-xs text-red-600 mt-0.5">{p.shipError}</div>}</td>
              <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{dt(p.inProcessAt)}</td>
              <td className="px-3 py-2 text-right">{fmtMoney(p.products.reduce((s: number, x: any) => s + x.qty * x.price, 0))}</td>
              <td className="px-3 py-2">{stPill(p.status)}{p.stockDocId && <span className="ml-1 text-[11px] text-slate-400" title="списано со склада">✓ склад</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length > n && <div className="px-4 py-2 text-xs text-slate-500 border-t">… ещё {list.length - n}</div>}
      {list.length === 0 && <div className="px-4 py-6 text-sm text-slate-500">Нет отправлений.</div>}
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Отправки Ozon FBS"
        hint={day ? `Отгрузка ${dayLabel(day)}${shipAt ? ` до ${hm(shipAt)}` : ''} · склад FBS «Рощино» · статусы обновляются из Ozon каждые 15 минут` : 'Отправления FBS из кабинета Ozon'}>
        {days && days.length > 0 && (
          <select value={day ?? ''} onChange={(e) => { setStep(null); setParams({ day: e.target.value }); }} className="border border-slate-300 rounded-lg px-2 py-2 text-sm bg-white">
            {days.map((d) => {
              const c = d.counts; const total = Object.values(c as Record<string, number>).reduce((a, b) => a + b, 0);
              return <option key={d.day} value={d.day}>Отгрузка {dayLabel(d.day)} · {total} отпр.{c.awaiting_packaging ? ` · ждут ${c.awaiting_packaging}` : ''}</option>;
            })}
          </select>
        )}
        <button disabled={!!busy} onClick={() => run('sync', () => loadDays(true))} className={btnSecondary}>{busy === 'sync' ? 'Обновляю…' : '↻ Обновить из Ozon'}</button>
      </PageHeader>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2.5 text-sm">{error}</div>}
      {msg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-4 py-2.5 text-sm">{msg}</div>}
      {!days || (day && !data) ? <p className="text-slate-500">Загрузка…</p> : !day ? <p className="text-slate-500">Отправлений FBS за последние 14 дней нет.</p> : (<>

      <ol className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {steps.map(([t, s], i) => (
          <li key={t}>
            <button onClick={() => setStep(i + 1)} className={clsx('w-full text-left rounded-xl border px-3 py-2.5',
              cur === i + 1 ? 'bg-brand-600 border-brand-600 text-white' : done[i] ? 'bg-white border-brand-200' : 'bg-white border-slate-200 text-slate-500')}>
              <div className={clsx('text-xs', cur === i + 1 ? 'text-brand-100' : 'text-slate-500')}>Шаг {i + 1} {done[i] && '✓'}</div>
              <div className="font-semibold">{t}</div>
              <div className={clsx('text-xs', cur === i + 1 ? 'text-brand-100' : 'text-slate-500')}>{s}</div>
            </button>
          </li>
        ))}
      </ol>

      {info?.lastError && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2.5 text-sm">{info.lastError}</div>}
      {data.unmapped.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-2.5 text-sm">
          Артикулы Ozon без SKU портала: <b>{data.unmapped.join(', ')}</b> — такие отправления нельзя собрать со списанием. Укажите артикул Ozon в <Link to="/stock/catalog?type=PRODUCT" className="underline">карточке SKU</Link>.
        </div>
      )}

      {cur === 1 && (
        <div className="bg-white rounded-xl border border-slate-200">
          <div className="px-4 py-3 border-b flex flex-wrap gap-3 items-center">
            <h2 className="font-semibold">Новые — ждут сборки</h2>
            <span className="text-sm text-slate-500">{waiting.length} отпр. · {fmtQty(units(waiting), 0)} шт. · {fmtMoney(sum(waiting))} ₽
              {packed.length ? ` · собрано ${packed.length}` : ''}{passed.length ? ` · передано ${passed.length}` : ''}{cancelled.length ? ` · отменено ${cancelled.length}` : ''}</span>
          </div>
          {table(waiting)}
        </div>
      )}

      {cur === 2 && (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] gap-4 items-start">
          <div className="bg-white rounded-xl border border-slate-200">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <h2 className="font-semibold">Шаг 2. Соберите {waiting.length} отправлений</h2>
              <span className="text-xs text-slate-500">выбрано {sel.size}</span>
            </div>
            {table(waiting, true)}
          </div>
          <div className="space-y-4 lg:sticky lg:top-4">
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <h3 className="font-semibold mb-3">Лист подбора</h3>
              <div className="space-y-1.5 text-sm">
                {mixes.map(([k, n]) => <div key={k} className="flex justify-between gap-3"><span>{k}</span><span className="text-slate-500 tabular-nums whitespace-nowrap">{n} отпр.</span></div>)}
              </div>
              <div className="border-t mt-3 pt-3 space-y-3">
                {pick.map((g) => {
                  const st = data.stock.find((s: any) => s.id === g.itemId);
                  const have = st ? st.labeled + st.unlabeled : 0;
                  return (
                    <div key={g.name} className="text-sm">
                      <div className="flex justify-between font-semibold"><span>{g.name}</span><span className="tabular-nums">{g.qty} шт.</span></div>
                      {st && <div className="text-xs text-slate-500 mt-0.5">
                        {st.lots.map((l: any) => `${l.number} ${l.state === 'LABELED' ? '«с ЧЗ»' : '«без ЧЗ»'} ${fmtQty(l.qty, 0)}`).join(' · ')}
                        <div className={clsx(have < g.qty ? 'text-red-600 font-medium' : have - g.qty < g.qty ? 'text-amber-700' : '')}>
                          на складе {fmtQty(have, 0)} → останется {fmtQty(have - g.qty, 0)}{have < g.qty ? ' — не хватает!' : have - g.qty < g.qty ? ' — пора фасовать' : ''}</div></div>}
                    </div>
                  );
                })}
                {pick.length === 0 && <p className="text-sm text-slate-500">Ничего не выбрано.</p>}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
              <p className="text-sm text-slate-600">Отправим в Ozon «Собрано» (одна коробка на отправление) и спишем {units(waiting.filter((p) => sel.has(p.postingNumber)))} шт. со склада документом «Отгрузка Ozon FBS» — сначала «с ЧЗ», по сроку годности.</p>
              <button disabled={!!busy || sel.size === 0} className={btnPrimary + ' w-full'}
                onClick={() => run('ship', () => api.ozonFbsShip(day, [...sel]), (r) => {
                  apply(r.state); loadDays();
                  return `Собрано ${r.shipped}${r.failed.length ? `, ошибок ${r.failed.length}` : ''}${r.doc ? ` · списано документом ${r.doc.number}` : ''}${r.writeOffError ? ` · НЕ списано: ${r.writeOffError}` : ''}`;
                })}>
                {busy === 'ship' ? `Собираю ${sel.size}… (около ${Math.ceil(sel.size / 4 / 3 / 60) || 1} мин)` : `Собрать ${sel.size} отправлений →`}
              </button>
            </div>
          </div>
        </div>
      )}

      {cur === 3 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4 max-w-3xl">
          <h2 className="font-semibold">Шаг 3. Этикетки отправлений 58×40</h2>
          <p className="text-sm text-slate-600">Этикетки нового образца формирует Ozon для собранных отправлений ({packed.length} шт.). Один PDF на все, по одной этикетке на страницу — печатайте на термоэтикетках 58×40.</p>
          <div className="flex flex-wrap gap-2">
            <button disabled={!!busy || packed.length === 0} className={btnPrimary}
              onClick={() => run('labels', () => api.ozonFbsLabels(day, 'small'), (r) => { apply(r); return `Готово: ${r.info?.labelCount} этикеток 58×40`; })}>
              {busy === 'labels' ? 'Ozon формирует…' : info?.labelS3Key ? 'Сформировать заново' : `Сформировать ${packed.length} этикеток 58×40`}</button>
            {info?.labelS3Key && <button className={btnSecondary} onClick={() => downloadFile(`/stock/ozon-fbs/days/${day}/labels.pdf`, `Этикетки Ozon FBS ${day}.pdf`).catch((e) => setError(e.message))}>
              ⇩ PDF ({info.labelCount} шт., {info.labelType === 'small_label' ? '58×40' : '75×120'})</button>}
          </div>
          {info?.labelAt && <p className="text-xs text-slate-500">Сформированы {dt(info.labelAt)}. Если собрали ещё отправления — сформируйте заново.</p>}
          {error.includes('58 × 40') && (
            <button disabled={!!busy} className="text-sm text-brand-700 hover:underline"
              onClick={() => run('labels', () => api.ozonFbsLabels(day, 'big'), (r) => { apply(r); return 'Готово: этикетки 75×120'; })}>Пока напечатать старые 75×120</button>
          )}
        </div>
      )}

      {cur === 4 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4 max-w-3xl">
          <h2 className="font-semibold">Шаг 4. Акт приёма-передачи и отгрузка</h2>
          <p className="text-sm text-slate-600">Акт на отгрузку {dayLabel(day)}: {packed.length} собранных отправлений{shipAt ? `, сдать до ${hm(shipAt)}` : ''}. Ozon формирует цифровой акт; PDF — для подписи при передаче.</p>
          <div className="flex flex-wrap gap-2">
            <button disabled={!!busy} className={btnPrimary} onClick={() => run('act', () => api.ozonFbsAct(day), (r) => { apply(r); return `Акт ${r.info?.actId} готов`; })}>
              {busy === 'act' ? 'Ozon формирует акт…' : info?.actS3Key ? 'Обновить акт' : 'Сформировать акт'}</button>
            {info?.actS3Key && <button className={btnSecondary} onClick={() => downloadFile(`/stock/ozon-fbs/days/${day}/act.pdf`, `Акт Ozon FBS ${day}.pdf`).catch((e) => setError(e.message))}>⇩ Акт № {info.actId}</button>}
          </div>
          <p className="text-xs text-slate-500">После передачи курьеру Ozon сам переведёт отправления в «Передано» — нажмите «Обновить из Ozon».</p>
        </div>
      )}

      {cur === 5 && (
        <div className="space-y-4">
          {notWritten.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
              <span className="text-amber-800">{notWritten.length} отправлений ({units(notWritten)} шт.) не списаны со склада — например, собраны в кабинете Ozon. Переданные в Ozon списываются автоматически при обновлении.</span>
              <button disabled={!!busy} className={btnSecondary + ' ml-auto'} onClick={() => run('wo', () => api.ozonFbsWriteOff(day), (r) => { apply(r.state); return r.doc ? `Списано документом ${r.doc.number}` : 'Нечего списывать'; })}>
                {busy === 'wo' ? 'Списываю…' : `Списать ${units(notWritten)} шт.`}</button>
            </div>
          )}
          <div className="bg-white rounded-xl border border-slate-200">
            <div className="px-4 py-3 border-b flex flex-wrap gap-3 items-center">
              <h2 className="font-semibold">Переданы в Ozon</h2>
              <span className="text-sm text-slate-500">{passed.length} отпр. · {fmtQty(units(passed), 0)} шт. · {fmtMoney(sum(passed))} ₽</span>
              {data.docs.length > 0 && <span className="text-sm ml-auto">Списание: {data.docs.map((d: any) => <Link key={d.id} to={`/stock/docs/${d.id}`} className="font-mono text-xs text-brand-700 hover:underline mr-2">{d.number}</Link>)}</span>}
            </div>
            {table(passed)}
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}
