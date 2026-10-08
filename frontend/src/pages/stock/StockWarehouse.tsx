import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { PageHeader } from './StockLayout';
import StockDocs from './StockDocs';
import StockMoves from './StockMoves';
import { ITEM_TYPES, STATE_LABEL, fmtDate, fmtMoney, fmtQty, inputCls, newDocPath, typeLabel } from './common';

const TYPE_CHIP: Record<string, string> = {
  RAW: 'bg-amber-50 text-amber-800 ring-amber-200',
  CONTAINER: 'bg-sky-50 text-sky-800 ring-sky-200',
  PACKAGING: 'bg-orange-50 text-orange-800 ring-orange-200',
  LABEL: 'bg-violet-50 text-violet-800 ring-violet-200',
  SEMI: 'bg-teal-50 text-teal-800 ring-teal-200',
  PRODUCT: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
};

export function TypeChip({ type }: { type: string }) {
  return <span className={clsx('inline-block text-[11px] font-medium px-1.5 py-0.5 rounded ring-1 ring-inset whitespace-nowrap', TYPE_CHIP[type])}>{typeLabel(type)}</span>;
}

const DOC_MENU = [
  { type: 'RECEIPT', label: 'Приход', hint: 'поступление от поставщика' },
  { type: 'OPENING', label: 'Начальные остатки', hint: 'ввод того, что уже лежит' },
  { type: 'ADJUSTMENT', label: 'Корректировка', hint: 'инвентаризация, списание' },
  { type: 'MIX', label: 'Замес', hint: 'сырьё → бочка' },
  { type: 'FILL', label: 'Фасовка', hint: 'бочка → тубы, банки' },
  { type: 'QUANT', label: 'Сборка квантов', hint: 'единицы → короба с ЧЗ' },
];

// Кнопка «+ Документ» с выбором типа
export function NewDocMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium">+ Документ ▾</button>
      {open && (
        <div className="absolute right-0 mt-1 w-64 bg-white border border-slate-200 rounded-xl shadow-lg z-30 py-1">
          {DOC_MENU.map((m, i) => (
            <Fragment key={m.type}>
              {i === 3 && <div className="border-t border-slate-100 my-1" />}
              <Link to={m.type === 'QUANT' ? '/stock/quant/new' : newDocPath(m.type)} onClick={() => setOpen(false)} className="block px-4 py-2 hover:bg-brand-50">
                <div className="text-sm font-medium">{m.label}</div>
                <div className="text-xs text-slate-500">{m.hint}</div>
              </Link>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

interface Row { lotId: string; state: string; qty: number; lot: any }

export default function StockWarehouse() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'stock';
  const setTab = (t: string) => setParams(t === 'stock' ? {} : { tab: t });

  return (
    <div>
      <PageHeader title="Склад" hint="Всё, что есть, одной таблицей. Любое изменение — через документ: приход, замес, фасовка, сборка, корректировка.">
        <NewDocMenu />
      </PageHeader>
      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {[['stock', 'Остатки'], ['docs', 'Документы'], ['moves', 'Движения']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={clsx('px-3 py-2 text-sm font-medium border-b-2 -mb-px', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'stock' && <StockTable />}
      {tab === 'docs' && <StockDocs embedded />}
      {tab === 'moves' && <StockMoves />}
    </div>
  );
}

function StockTable() {
  const [params, setParams] = useSearchParams();
  const types = (params.get('type') ?? '').split(',').filter(Boolean);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [onlyStock, setOnlyStock] = useState(true);
  const [onlyLow, setOnlyLow] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => { Promise.all([api.getBalances(), api.getItems()]).then(([b, i]) => { setRows(b); setItems(i); }); }, []);

  const toggleType = (t: string) => {
    const next = types.includes(t) ? types.filter((x) => x !== t) : [...types, t];
    const p = new URLSearchParams(params);
    if (next.length) p.set('type', next.join(',')); else p.delete('type');
    setParams(p);
  };

  const groups = useMemo(() => {
    if (!rows) return [];
    const byItem = new Map<string, { item: any; rows: Row[]; total: number; byState: Record<string, number>; value: number; nearest: number | null }>();
    for (const it of items) byItem.set(it.id, { item: it, rows: [], total: 0, byState: {}, value: 0, nearest: null });
    for (const r of rows) {
      const g = byItem.get(r.lot.item.id) ?? { item: r.lot.item, rows: [], total: 0, byState: {}, value: 0, nearest: null };
      g.rows.push(r);
      g.total += r.qty;
      g.byState[r.state] = (g.byState[r.state] ?? 0) + r.qty;
      if (r.lot.unitCost != null) g.value += r.lot.unitCost * r.qty;
      const exp = r.lot.expiresAt ? Date.parse(r.lot.expiresAt) : null;
      if (exp && r.qty > 0 && (g.nearest == null || exp < g.nearest)) g.nearest = exp;
      byItem.set(r.lot.item.id, g);
    }
    const s = q.trim().toLowerCase();
    return [...byItem.values()]
      .filter((g) => !types.length || types.includes(g.item.type))
      .filter((g) => !onlyStock || Math.abs(g.total) > 1e-9)
      .filter((g) => !onlyLow || (g.item.minStock != null && g.total < g.item.minStock))
      .filter((g) => !s || g.item.name.toLowerCase().includes(s) || g.rows.some((r) => r.lot.number.toLowerCase().includes(s) || (r.lot.barrel ?? '').toLowerCase().includes(s)))
      .sort((a, b) => ITEM_TYPES.findIndex((t) => t.value === a.item.type) - ITEM_TYPES.findIndex((t) => t.value === b.item.type) || a.item.name.localeCompare(b.item.name, 'ru'));
  }, [rows, items, types.join(), q, onlyStock, onlyLow]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const it of items) c[it.type] = (c[it.type] ?? 0) + 1;
    return c;
  }, [items]);

  const total = groups.reduce((t, g) => t + g.value, 0);
  const soon = Date.now() + 30 * 86400_000;

  function action(g: (typeof groups)[number]) {
    const t = g.item.type;
    if (t === 'SEMI' && g.total > 0) return { to: '/stock/fill/new', label: 'Фасовать' };
    if (t === 'PRODUCT' && (g.byState.UNLABELED ?? 0) > 0) return { to: '/stock/quant/new', label: 'В кванты' };
    if (t === 'PRODUCT' && (g.byState.IN_QUANT ?? 0) > 0) return { to: '/stock/fbo', label: 'Отгрузить' };
    if (['RAW', 'CONTAINER', 'PACKAGING', 'LABEL'].includes(t) && !g.item.noStock) return { to: '/stock/docs/new?type=RECEIPT', label: 'Приход' };
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => { const p = new URLSearchParams(params); p.delete('type'); setParams(p); }}
          className={clsx('px-3 py-1.5 rounded-full text-sm border', !types.length ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-400')}>
          Все <span className="opacity-60">{items.length}</span>
        </button>
        {ITEM_TYPES.map((t) => (
          <button key={t.value} onClick={() => toggleType(t.value)}
            className={clsx('px-3 py-1.5 rounded-full text-sm border', types.includes(t.value) ? 'bg-brand-600 text-white border-brand-600' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-400')}>
            {t.label} <span className="opacity-60">{counts[t.value] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск: название, лот, бочка" className={inputCls + ' w-72'} />
        <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} /> Только в наличии</label>
        <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> Ниже минимума</label>
        {open.size > 0 && <button onClick={() => setOpen(new Set())} className="text-sm text-slate-500 hover:underline">Свернуть всё</button>}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        {!rows ? <p className="p-6 text-slate-500">Загрузка…</p> : groups.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">
            {items.length === 0 ? <>Номенклатура пуста. <Link to="/stock/catalog" className="text-brand-700 hover:underline">Заведите позиции</Link>, затем внесите остатки документом.</> : 'Ничего не найдено. Снимите фильтры или отключите «Только в наличии».'}
          </div>
        ) : (
          <table className="w-full text-sm tabular-nums">
            <thead className="bg-slate-50/80">
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                <th className="pl-4 pr-2 py-2.5 font-medium w-6" />
                <th className="px-2 py-2.5 font-medium">Позиция</th>
                <th className="px-3 py-2.5 font-medium">Тип</th>
                <th className="px-3 py-2.5 font-medium text-right">Остаток</th>
                <th className="px-3 py-2.5 font-medium text-right">Лотов</th>
                <th className="px-3 py-2.5 font-medium">Ближ. срок</th>
                <th className="px-3 py-2.5 font-medium text-right">Сумма, ₽</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const isOpen = open.has(g.item.id);
                const low = g.item.minStock != null && g.total < g.item.minStock;
                const act = action(g);
                const states = Object.entries(g.byState).filter(([st, v]) => st !== 'NONE' && v > 1e-9);
                return (
                  <Fragment key={g.item.id}>
                    <tr onClick={() => setOpen((s) => { const n = new Set(s); n.has(g.item.id) ? n.delete(g.item.id) : n.add(g.item.id); return n; })}
                      className={clsx('border-b border-slate-100 cursor-pointer hover:bg-slate-50', isOpen && 'bg-slate-50')}>
                      <td className="pl-4 pr-2 py-2.5 text-slate-400">{g.rows.length > 0 ? (isOpen ? '▾' : '▸') : ''}</td>
                      <td className="px-2 py-2.5">
                        <Link to={`/stock/catalog/${g.item.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:text-brand-700">{g.item.name}</Link>
                        {g.item.noStock && <span className="ml-2 text-xs text-slate-400">без учёта</span>}
                      </td>
                      <td className="px-3 py-2.5"><TypeChip type={g.item.type} /></td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <span className={clsx('font-semibold', g.total === 0 && 'text-slate-400', low && 'text-amber-700')}>{fmtQty(g.total)} {g.item.unit}</span>
                        {low && <div className="text-[11px] text-amber-700">мин. {fmtQty(g.item.minStock)}</div>}
                        {states.length > 0 && (
                          <div className="text-[11px] text-slate-500">{states.map(([st, v]) => `${STATE_LABEL[st]} ${fmtQty(v, 0)}`).join(' · ')}</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-500">{g.rows.length || '—'}</td>
                      <td className={clsx('px-3 py-2.5 whitespace-nowrap', g.nearest && g.nearest < Date.now() ? 'text-red-600 font-medium' : g.nearest && g.nearest < soon ? 'text-amber-700' : 'text-slate-600')}>
                        {g.nearest ? new Date(g.nearest).toLocaleDateString('ru-RU') : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{g.value ? fmtMoney(g.value) : '—'}</td>
                      <td className="px-4 py-2.5 text-right">
                        {act && <Link to={act.to} onClick={(e) => e.stopPropagation()} className="text-xs border border-slate-200 rounded-md px-2.5 py-1 hover:border-brand-500 hover:text-brand-700 whitespace-nowrap">{act.label}</Link>}
                      </td>
                    </tr>
                    {isOpen && g.rows.map((r) => {
                      const exp = r.lot.expiresAt ? Date.parse(r.lot.expiresAt) : null;
                      return (
                        <tr key={r.lotId + r.state} className="border-b border-slate-100 bg-slate-50/60 text-[13px]">
                          <td />
                          <td className="px-2 py-1.5 pl-6" colSpan={2}>
                            <Link to={`/stock/warehouse?tab=moves&lotId=${r.lotId}`} className="font-mono text-xs text-brand-700 hover:underline">{r.lot.number}</Link>
                            <span className="text-slate-500 ml-2 text-xs">
                              {[r.lot.barrel && `бочка ${r.lot.barrel}`, r.lot.supplierLot && `лот пост. ${r.lot.supplierLot}`, STATE_LABEL[r.state]].filter(Boolean).join(' · ')}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtQty(r.qty)} {g.item.unit}</td>
                          <td className="px-3 py-1.5 text-right text-xs text-slate-500">{r.lot.unitCost != null ? `${fmtMoney(r.lot.unitCost)} ₽` : ''}</td>
                          <td className={clsx('px-3 py-1.5 whitespace-nowrap', exp && exp < Date.now() ? 'text-red-600' : exp && exp < soon ? 'text-amber-700' : 'text-slate-500')}>{fmtDate(r.lot.expiresAt)}</td>
                          <td className="px-3 py-1.5 text-right text-slate-500">{r.lot.unitCost != null ? fmtMoney(r.lot.unitCost * r.qty) : ''}</td>
                          <td />
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
            {total > 0 && (
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={6} className="px-4 py-2.5 text-right text-slate-500">Итого по известным ценам</td>
                  <td className="px-3 py-2.5 text-right">{fmtMoney(total)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>
    </div>
  );
}
