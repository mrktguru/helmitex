import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { ITEM_TYPES, STATE_LABEL, fmtDate, fmtMoney, fmtQty } from './common';

interface Row {
  lotId: string;
  state: string;
  qty: number;
  lot: {
    id: string; number: string; supplierLot: string | null; barrel: string | null;
    expiresAt: string | null; unitCost: number | null;
    item: { id: string; name: string; unit: string; minStock: number | null };
  };
}

export default function StockBalances() {
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? 'RAW';
  const [rows, setRows] = useState<Row[] | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    setRows(null);
    Promise.all([api.getBalances({ type }), api.getItems(type)]).then(([b, i]) => { setRows(b); setItems(i); });
  }, [type]);

  // Позиции с итогом по всем лотам, включая те, которых нет в наличии (чтобы видеть нехватку до минимума)
  const groups = useMemo(() => {
    if (!rows) return [];
    const q = filter.trim().toLowerCase();
    const byItem = new Map<string, { item: Row['lot']['item']; rows: Row[]; total: number }>();
    for (const it of items) byItem.set(it.id, { item: it, rows: [], total: 0 });
    for (const r of rows) {
      const g = byItem.get(r.lot.item.id) ?? { item: r.lot.item, rows: [], total: 0 };
      g.rows.push(r);
      g.total += r.qty;
      byItem.set(r.lot.item.id, g);
    }
    return [...byItem.values()]
      .filter((g) => !q || g.item.name.toLowerCase().includes(q) || g.rows.some((r) => r.lot.number.toLowerCase().includes(q)))
      .sort((a, b) => a.item.name.localeCompare(b.item.name, 'ru'));
  }, [rows, items, filter]);

  const total = groups.reduce((s, g) => s + g.rows.reduce((t, r) => t + (r.lot.unitCost ?? 0) * r.qty, 0), 0);
  const isProduct = type === 'PRODUCT';
  const isSemi = type === 'SEMI';
  const soon = Date.now() + 30 * 86400_000;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex gap-1 flex-wrap">
          {ITEM_TYPES.map((t) => (
            <button
              key={t.value}
              onClick={() => setParams({ type: t.value })}
              className={clsx('px-3 py-1.5 rounded-lg text-sm font-medium border',
                type === t.value ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50')}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Поиск по названию или лоту"
            className="border rounded-lg px-3 py-1.5 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <Link to="/stock/docs/new?type=RECEIPT" className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap">+ Приход</Link>
        </div>
      </div>

      <div className="bg-white rounded-xl border overflow-x-auto">
        {!rows ? <p className="p-6 text-gray-500">Загрузка…</p> : groups.length === 0 ? (
          <p className="p-6 text-gray-500">Нет позиций. Добавьте их в разделе <Link to="/stock/items" className="text-blue-600 hover:underline">Номенклатура</Link>.</p>
        ) : (
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b">
                <th className="px-3 py-2 font-medium">Позиция / лот</th>
                <th className="px-3 py-2 font-medium">{isSemi ? 'Бочка' : 'Лот поставщика'}</th>
                {isProduct && <th className="px-3 py-2 font-medium">Состояние</th>}
                <th className="px-3 py-2 font-medium text-right">Остаток</th>
                <th className="px-3 py-2 font-medium">Годен до</th>
                <th className="px-3 py-2 font-medium text-right">Цена</th>
                <th className="px-3 py-2 font-medium text-right">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const low = g.item.minStock != null && g.total < g.item.minStock;
                return (
                  <Fragment key={g.item.id}>
                    <tr className="bg-gray-50 border-b">
                      <td className="px-3 py-2 font-semibold" colSpan={isProduct ? 3 : 2}>
                        {g.item.name}
                        {low && <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">ниже минимума {fmtQty(g.item.minStock)}</span>}
                      </td>
                      <td className={clsx('px-3 py-2 text-right font-semibold whitespace-nowrap', g.total === 0 && 'text-gray-400')}>
                        {fmtQty(g.total)} {g.item.unit}
                      </td>
                      <td colSpan={3} />
                    </tr>
                    {g.rows.map((r) => {
                      const exp = r.lot.expiresAt ? new Date(r.lot.expiresAt).getTime() : null;
                      return (
                        <tr key={r.lotId + r.state} className="border-b last:border-0 hover:bg-blue-50/40">
                          <td className="px-3 py-1.5 pl-6">
                            <Link to={`/stock/moves?lotId=${r.lotId}`} className="font-mono text-xs text-blue-700 hover:underline">{r.lot.number}</Link>
                          </td>
                          <td className="px-3 py-1.5 font-mono text-xs text-gray-500">{(isSemi ? r.lot.barrel : r.lot.supplierLot) ?? '—'}</td>
                          {isProduct && <td className="px-3 py-1.5">{STATE_LABEL[r.state]}</td>}
                          <td className={clsx('px-3 py-1.5 text-right whitespace-nowrap', r.qty < 0 && 'text-red-600')}>{fmtQty(r.qty)} {g.item.unit}</td>
                          <td className={clsx('px-3 py-1.5 whitespace-nowrap',
                            exp != null && exp < Date.now() ? 'text-red-600 font-medium' : exp != null && exp < soon ? 'text-amber-700' : '')}>
                            {fmtDate(r.lot.expiresAt)}
                          </td>
                          <td className="px-3 py-1.5 text-right">{fmtMoney(r.lot.unitCost)}</td>
                          <td className="px-3 py-1.5 text-right">{r.lot.unitCost != null ? fmtMoney(r.lot.unitCost * r.qty) : '—'}</td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
            {total > 0 && (
              <tfoot>
                <tr className="border-t font-semibold">
                  <td className="px-3 py-2" colSpan={isProduct ? 6 : 5}>Итого по известным ценам</td>
                  <td className="px-3 py-2 text-right">{fmtMoney(total)} ₽</td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>
      <p className="text-xs text-gray-500">Лоты внутри позиции отсортированы по сроку годности: первым расходуется верхний (FEFO).</p>
    </div>
  );
}
