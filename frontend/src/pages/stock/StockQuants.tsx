import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, downloadFile } from '../../api/client';
import { PageHeader } from './StockLayout';
import { QUANT_STATUS, btnSecondary, fmtDate, inputCls } from './common';

export default function StockQuants() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'ASSEMBLED';
  const typeId = params.get('typeId') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [types, setTypes] = useState<any[]>([]);
  const [quants, setQuants] = useState<any[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  useEffect(() => { api.getQuantTypes().then(setTypes); }, []);
  useEffect(() => {
    setQuants(null); setSel(new Set());
    const t = setTimeout(() => api.getQuants({ status: status === 'ALL' ? undefined : status, typeId, q }).then(setQuants), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [status, typeId, q]);

  const setParam = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = [...sel].join(',');

  async function dl(path: string) {
    setError('');
    try { await downloadFile(path, 'file'); } catch (e: any) { setError(e.message); }
  }

  // Сводка по типам — сколько квантов на складе
  const summary = types.filter((t) => !t.archived && t.inStock > 0);

  return (
    <div className="space-y-4">
      <PageHeader title="Кванты" hint="Квант — короб с единицами одного SKU и списком кодов ЧЗ. Из квантов собираются поставки FBO." />
      {summary.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {summary.map((t) => (
            <button key={t.id} onClick={() => setParam('typeId', typeId === t.id ? '' : t.id)}
              className={clsx('bg-white border rounded-xl px-4 py-2 text-left', typeId === t.id && 'border-brand-500 bg-brand-50')}>
              <div className="text-xs text-slate-500">{t.name}</div>
              <div className="text-lg font-semibold tabular-nums">{t.inStock} <span className="text-sm font-normal text-slate-500">кв. · {t.inStock * t.unitsPerQuant} шт</span></div>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap gap-2">
          <select value={status} onChange={(e) => setParam('status', e.target.value)} className={inputCls}>
            {Object.entries(QUANT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            <option value="ALL">Все статусы</option>
          </select>
          <select value={typeId} onChange={(e) => setParam('typeId', e.target.value)} className={inputCls}>
            <option value="">Все типы</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Номер кванта или код ЧЗ" className={inputCls + ' w-60'} />
        </div>
        <div className="flex gap-2">
          <Link to="/stock/quant/new?import=1" className={btnSecondary}>Ввод существующих</Link>
          <Link to="/stock/quant/new" className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium">+ Сборка квантов</Link>
        </div>
      </div>

      {sel.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 bg-brand-50 border border-brand-100 rounded-lg px-3 py-2 text-sm">
          Выбрано: {sel.size}
          <button onClick={() => dl(`/stock/quant-labels.pdf?ids=${ids}`)} className="text-brand-700 hover:underline">Этикетки квантов</button>
          <button onClick={() => dl(`/stock/quant-codes.csv?ids=${ids}`)} className="text-brand-700 hover:underline">Список ЧЗ (CSV)</button>
          <button onClick={() => setSel(new Set())} className="text-slate-500 hover:underline">Снять выбор</button>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="bg-white rounded-xl border overflow-x-auto">
        {!quants ? <p className="p-6 text-slate-500">Загрузка…</p> : quants.length === 0 ? <p className="p-6 text-slate-500">Квантов нет.</p> : (
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" checked={sel.size === quants.length} onChange={(e) => setSel(e.target.checked ? new Set(quants.map((x) => x.id)) : new Set())} />
                </th>
                <th className="px-3 py-2 font-medium">Квант</th>
                <th className="px-3 py-2 font-medium">Тип</th>
                <th className="px-3 py-2 font-medium text-right">Ед.</th>
                <th className="px-3 py-2 font-medium text-right">Кодов ЧЗ</th>
                <th className="px-3 py-2 font-medium">Партия</th>
                <th className="px-3 py-2 font-medium">Годен до</th>
                <th className="px-3 py-2 font-medium">Статус</th>
                <th className="px-3 py-2 font-medium">Документ</th>
              </tr>
            </thead>
            <tbody>
              {quants.map((x) => (
                <tr key={x.id} className={clsx('border-b last:border-0', sel.has(x.id) && 'bg-brand-50/50')}>
                  <td className="px-3 py-2"><input type="checkbox" checked={sel.has(x.id)} onChange={() => toggle(x.id)} /></td>
                  <td className="px-3 py-2"><Link to={`/stock/quants/${x.id}`} className="font-mono text-brand-700 hover:underline">{x.number}</Link></td>
                  <td className="px-3 py-2">{x.quantType.name}</td>
                  <td className="px-3 py-2 text-right">{x.units}</td>
                  <td className={clsx('px-3 py-2 text-right', x._count.codes > 0 && x._count.codes !== x.units && 'text-red-600 font-semibold')}>{x._count.codes || '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{x.lot.number}</td>
                  <td className="px-3 py-2">{fmtDate(x.lot.expiresAt)}</td>
                  <td className="px-3 py-2"><span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', QUANT_STATUS[x.status].cls)}>{QUANT_STATUS[x.status].label}</span></td>
                  <td className="px-3 py-2"><Link to={`/stock/quant/${x.doc.id}`} className="font-mono text-xs text-slate-500 hover:underline">{x.doc.number}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
