import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, downloadFile } from '../../api/client';
import { PageHeader } from './StockLayout';
import { QUANT_STATUS, btnSecondary, fmtDate, fmtMoney, fmtQty, inputCls } from './common';

interface Group {
  key: string; offer: string | null; name: string; productId: string;
  quants: any[]; units: number; byStatus: Record<string, number>; byVariant: Map<string, { name: string; units: number; count: number }>;
  nearest: number | null; value: number;
}

export default function StockQuants() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'ACTIVE';
  const typeId = params.get('typeId') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [types, setTypes] = useState<any[]>([]);
  const [quants, setQuants] = useState<any[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  useEffect(() => { api.getQuantTypes().then(setTypes); }, []);
  useEffect(() => {
    setQuants(null); setSel(new Set());
    const st = status === 'ALL' || status === 'ACTIVE' ? undefined : status;
    const t = setTimeout(() => api.getQuants({ status: st, typeId, q }).then((qs) =>
      setQuants(status === 'ACTIVE' ? qs.filter((x: any) => x.status === 'ASSEMBLED' || x.status === 'RESERVED') : qs)), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [status, typeId, q]);

  // Поиск по коду ЧЗ — раскрываем найденные группы сразу
  useEffect(() => { if (q && quants) setOpen(new Set(groups.map((g) => g.key))); }, [quants]);

  const setParam = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };
  const ids = [...sel].join(',');

  async function dl(path: string) {
    setError('');
    try { await downloadFile(path, 'file'); } catch (e: any) { setError(e.message); }
  }

  // Группы по артикулу (SKU): всего квантов, единиц, по статусам и вариантам
  const groups = useMemo(() => {
    const m = new Map<string, Group>();
    for (const x of quants ?? []) {
      const p = x.quantType.productItem;
      const key = p.id;
      const g: Group = m.get(key) ?? { key, offer: p.spec?.ozonOfferId ?? null, name: p.name, productId: p.id, quants: [], units: 0, byStatus: {}, byVariant: new Map(), nearest: null, value: 0 };
      g.quants.push(x);
      g.units += x.units;
      g.byStatus[x.status] = (g.byStatus[x.status] ?? 0) + 1;
      const v = g.byVariant.get(x.quantTypeId) ?? { name: x.quantType.name, units: x.quantType.unitsPerQuant, count: 0 };
      v.count++;
      g.byVariant.set(x.quantTypeId, v);
      g.value += x.unitCost ?? 0;
      const exp = x.lot.expiresAt ? Date.parse(x.lot.expiresAt) : null;
      if (exp && x.status === 'ASSEMBLED' && (g.nearest == null || exp < g.nearest)) g.nearest = exp;
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [quants]);

  const totals = groups.reduce((t, g) => ({ quants: t.quants + g.quants.length, units: t.units + g.units }), { quants: 0, units: 0 });
  const toggleOpen = (k: string) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleSel = (idsToToggle: string[], on: boolean) => setSel((s) => { const n = new Set(s); idsToToggle.forEach((id) => (on ? n.add(id) : n.delete(id))); return n; });

  return (
    <div className="space-y-4">
      <PageHeader title="Кванты" hint="Квант — короб с единицами одного SKU и списком кодов ЧЗ. Сгруппированы по артикулу; разверните группу, чтобы увидеть кванты.">
        <Link to="/stock/quant/new?import=1" className={btnSecondary}>Ввод существующих</Link>
        <Link to="/stock/quant/new" className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium">+ Сборка квантов</Link>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setParam('status', e.target.value === 'ACTIVE' ? '' : e.target.value)} className={inputCls}>
          <option value="ACTIVE">На складе и в поставке</option>
          {Object.entries(QUANT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          <option value="ALL">Все статусы</option>
        </select>
        <select value={typeId} onChange={(e) => setParam('typeId', e.target.value)} className={inputCls}>
          <option value="">Все варианты</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Номер кванта или код ЧЗ" className={inputCls + ' w-64'} />
        {quants && <span className="text-sm text-slate-500 ml-auto">Итого: <b className="text-slate-800">{totals.quants}</b> кв. · {fmtQty(totals.units, 0)} шт</span>}
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

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        {!quants ? <p className="p-6 text-slate-500">Загрузка…</p> : groups.length === 0 ? <p className="p-6 text-slate-500 text-sm">Квантов нет.</p> : (
          <table className="w-full text-sm tabular-nums">
            <thead className="bg-slate-50/80">
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                <th className="pl-4 pr-1 py-2.5 w-8" />
                <th className="px-2 py-2.5 w-6" />
                <th className="px-2 py-2.5 font-medium">Артикул / SKU</th>
                <th className="px-3 py-2.5 font-medium text-right">Квантов</th>
                <th className="px-3 py-2.5 font-medium text-right">Единиц</th>
                <th className="px-3 py-2.5 font-medium">Варианты</th>
                <th className="px-3 py-2.5 font-medium">Статус</th>
                <th className="px-3 py-2.5 font-medium">Ближ. срок</th>
                <th className="px-4 py-2.5 font-medium text-right">Сумма, ₽</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const isOpen = open.has(g.key);
                const gIds = g.quants.map((x) => x.id);
                const allSel = gIds.every((id) => sel.has(id));
                return (
                  <Fragment key={g.key}>
                    <tr onClick={() => toggleOpen(g.key)} className={clsx('border-b border-slate-100 cursor-pointer hover:bg-slate-50', isOpen && 'bg-slate-50')}>
                      <td className="pl-4 pr-1 py-3" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={allSel} onChange={(e) => toggleSel(gIds, e.target.checked)} />
                      </td>
                      <td className="px-2 py-3 text-slate-400">{isOpen ? '▾' : '▸'}</td>
                      <td className="px-2 py-3">
                        <div className="font-mono text-xs text-slate-500">{g.offer ?? 'без артикула'}</div>
                        <Link to={`/stock/catalog/${g.productId}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:text-brand-700">{g.name}</Link>
                      </td>
                      <td className="px-3 py-3 text-right text-lg font-semibold">{g.quants.length}</td>
                      <td className="px-3 py-3 text-right">{fmtQty(g.units, 0)} шт</td>
                      <td className="px-3 py-3 text-xs text-slate-600">{[...g.byVariant.values()].map((v) => `${v.units} шт × ${v.count}`).join(' · ')}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(g.byStatus).map(([st, n]) => (
                            <span key={st} className={clsx('text-[11px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap', QUANT_STATUS[st].cls)}>{QUANT_STATUS[st].label} {n}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap text-slate-600">{g.nearest ? new Date(g.nearest).toLocaleDateString('ru-RU') : '—'}</td>
                      <td className="px-4 py-3 text-right text-slate-600">{g.value ? fmtMoney(g.value) : '—'}</td>
                    </tr>
                    {isOpen && g.quants.map((x) => (
                      <tr key={x.id} className={clsx('border-b border-slate-100 text-[13px]', sel.has(x.id) ? 'bg-brand-50/60' : 'bg-slate-50/50')}>
                        <td className="pl-4 pr-1 py-1.5"><input type="checkbox" checked={sel.has(x.id)} onChange={(e) => toggleSel([x.id], e.target.checked)} /></td>
                        <td />
                        <td className="px-2 py-1.5 pl-4">
                          <Link to={`/stock/quants/${x.id}`} className="font-mono text-xs text-brand-700 hover:underline">{x.number}</Link>
                          <span className="text-xs text-slate-500 ml-2">{x.quantType.name} · партия {x.lot.number}</span>
                        </td>
                        <td className="px-3 py-1.5 text-right text-slate-400">1</td>
                        <td className="px-3 py-1.5 text-right">{x.units} шт</td>
                        <td className={clsx('px-3 py-1.5 text-xs', x._count.codes > 0 && x._count.codes !== x.units ? 'text-red-600 font-semibold' : 'text-slate-500')}>
                          {x._count.codes ? `ЧЗ ${x._count.codes}/${x.units}` : 'без ЧЗ'}
                        </td>
                        <td className="px-3 py-1.5"><span className={clsx('text-[11px] font-medium px-1.5 py-0.5 rounded-full', QUANT_STATUS[x.status].cls)}>{QUANT_STATUS[x.status].label}</span></td>
                        <td className="px-3 py-1.5 text-slate-500">{fmtDate(x.lot.expiresAt)}</td>
                        <td className="px-4 py-1.5 text-right">
                          <Link to={`/stock/quant/${x.doc.id}`} className="font-mono text-[11px] text-slate-400 hover:underline">{x.doc.number}</Link>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
