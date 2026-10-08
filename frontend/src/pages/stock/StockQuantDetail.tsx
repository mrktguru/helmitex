import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, downloadFile } from '../../api/client';
import { QUANT_STATUS, btnSecondary, fmtDate, fmtMoney, fmtQty } from './common';

// Код ЧЗ для показа: GTIN + серийный номер, без криптохвоста
const shortCode = (c: string) => c.replace(/^\x1d/, '').split('\x1d')[0];

export default function StockQuantDetail() {
  const { id } = useParams<{ id: string }>();
  const [q, setQ] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);   // outputBatchId замены, ждём PDF
  const [showOld, setShowOld] = useState(false);

  async function load() {
    try { setQ(await api.getQuant(id!)); } catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); }, [id]);

  async function dl(path: string) {
    setError('');
    try { await downloadFile(path, 'file'); } catch (e: any) { setError(e.message); }
  }

  async function replace(codeId: string) {
    if (!confirm('Этикетка испорчена? Код будет выведен из кванта (в брак), вместо него выдастся новый.')) return;
    setBusy(true); setError('');
    try {
      const r = await api.replaceQuantCode(id!, codeId);
      setPending(r.outputBatchId);
      await load();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  // Ждём генерацию этикетки замены и скачиваем её
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      try {
        await downloadFile(`/stock/batches/${pending}/pdf`, 'cz.pdf');
        setPending(null);
        load();
      } catch (e: any) {
        if (!/генерируется/.test(e.message)) { setError(e.message); setPending(null); }
      }
    }, 2500);
    return () => clearInterval(t);
  }, [pending]);

  if (error && !q) return <p className="text-red-600">{error}</p>;
  if (!q) return <p className="text-slate-500">Загрузка…</p>;

  const active = q.codes.filter((c: any) => c.active);
  const old = q.codes.filter((c: any) => !c.active);
  const canReplace = q.status === 'ASSEMBLED' && q.quantType.trackCz && q.quantType.project && !q.doc.imported;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/stock/quants" className="text-slate-500 hover:text-slate-900 text-sm">← Кванты</Link>
        <h2 className="text-xl font-semibold font-mono">{q.number}</h2>
        <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', QUANT_STATUS[q.status].cls)}>{QUANT_STATUS[q.status].label}</span>
        <div className="flex-1" />
        <button onClick={() => dl(`/stock/quant-labels.pdf?ids=${q.id}`)} className={btnSecondary}>Этикетка кванта</button>
        {q.outputBatch?.jobStatus === 'done' && <button onClick={() => dl(`/stock/batches/${q.outputBatch.id}/pdf`)} className={btnSecondary}>Этикетки ЧЗ ({q.units})</button>}
        {active.length > 0 && <button onClick={() => dl(`/stock/quant-codes.csv?quantId=${q.id}`)} className={btnSecondary}>Список ЧЗ (CSV)</button>}
      </div>

      <div className="bg-white rounded-xl border p-4 grid grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
        <div><div className="text-xs text-slate-500">SKU</div>{q.quantType.productItem.name}</div>
        <div><div className="text-xs text-slate-500">Единиц</div>{q.units}</div>
        <div><div className="text-xs text-slate-500">Собран</div>{fmtDate(q.createdAt)} · <Link to={`/stock/quant/${q.doc.id}`} className="font-mono text-xs text-brand-700 hover:underline">{q.doc.number}</Link></div>
        <div><div className="text-xs text-slate-500">Годен до</div>{fmtDate(q.lot.expiresAt)}</div>
        <div><div className="text-xs text-slate-500">Себестоимость</div>{fmtMoney(q.unitCost)}{q.unitCost != null && ' ₽'}</div>
      </div>

      <div className="bg-white rounded-xl border p-4 text-sm">
        <h3 className="font-semibold text-sm mb-2">Прослеживаемость</h3>
        <div className="flex flex-wrap items-stretch gap-2">
          <div className="border rounded-lg px-3 py-2 bg-slate-50">
            <div className="text-xs text-slate-500">Сырьё</div>
            {q.trace.raw.length ? q.trace.raw.map((r: any, i: number) => (
              <div key={i}>{r.item} <span className="font-mono text-xs">{r.lot}</span>{r.supplierLot && <span className="text-slate-500 text-xs"> ({r.supplierLot})</span>} · {fmtQty(r.qty, 2)} кг</div>
            )) : <span className="text-slate-400">—</span>}
          </div>
          <div className="self-center text-slate-400">→</div>
          <div className="border rounded-lg px-3 py-2 bg-slate-50">
            <div className="text-xs text-slate-500">Замес / бочка</div>
            {q.trace.mix ? <Link to={`/stock/mix/${q.trace.mix.id}`} className="font-mono text-xs text-brand-700 hover:underline">{q.trace.mix.number}</Link> : '—'}
            {q.trace.barrel && <div><span className="font-mono text-xs">{q.trace.barrel.number}</span>{q.trace.barrel.barrel && ` · ${q.trace.barrel.barrel}`}</div>}
          </div>
          <div className="self-center text-slate-400">→</div>
          <div className="border rounded-lg px-3 py-2 bg-slate-50"><div className="text-xs text-slate-500">Партия ГП</div><span className="font-mono text-xs">{q.trace.lot}</span></div>
          <div className="self-center text-slate-400">→</div>
          <div className="border rounded-lg px-3 py-2 bg-brand-50"><div className="text-xs text-slate-500">Квант</div><span className="font-mono text-xs">{q.number}</span></div>
        </div>
      </div>

      {q.quantType.trackCz && (
        <div className="bg-white rounded-xl border overflow-x-auto">
          <div className="px-4 pt-3 flex items-center gap-3">
            <h3 className="font-semibold text-sm">Коды ЧЗ в кванте: {active.length}{active.length !== q.units && <span className="text-red-600"> из {q.units}</span>}</h3>
            {old.length > 0 && <button onClick={() => setShowOld((v) => !v)} className="text-xs text-brand-600 hover:underline">{showOld ? 'Скрыть' : 'Показать'} заменённые ({old.length})</button>}
          </div>
          {pending && <p className="px-4 pt-2 text-sm text-amber-700">Генерирую этикетку взамен испорченной — скачается автоматически…</p>}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
                <th className="px-4 py-2 font-medium w-10">№</th>
                <th className="px-4 py-2 font-medium">Код (GTIN + серийный №)</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {(showOld ? q.codes : active).map((c: any, i: number) => (
                <tr key={c.id} className={clsx('border-b last:border-0', !c.active && 'text-slate-400 line-through')}>
                  <td className="px-4 py-1.5 text-slate-500">{i + 1}</td>
                  <td className="px-4 py-1.5 font-mono text-xs break-all">{c.code ? shortCode(c.code) : <span className="text-slate-400 no-underline">распознаётся…</span>}</td>
                  <td className="px-4 py-1.5 text-right whitespace-nowrap">
                    {c.active && canReplace && <button disabled={busy || !!pending} onClick={() => replace(c.id)} className="text-xs text-slate-500 hover:text-red-600 hover:underline">Испорчена — заменить</button>}
                    {!c.active && <span className="text-xs">заменён</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
