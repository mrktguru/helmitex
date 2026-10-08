import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { PageHeader, Section } from './StockLayout';
import { TypeChip } from './StockWarehouse';
import StockRecipes from './StockRecipes';
import SkuSheet from './SkuSheet';
import { STATE_LABEL, btnPrimary, btnSecondary, fmtDate, fmtMoney, fmtQty, inputCls, parseNum } from './common';

// Единая карточка позиции на одном листе: основное → (рецептура | производство, ЧЗ, Ozon, кванты) → остатки
export default function StockItemCard() {
  const { id } = useParams<{ id: string }>();
  const [item, setItem] = useState<any>(null);
  const [error, setError] = useState('');

  async function load() { try { setItem(await api.getItem(id!)); } catch (e: any) { setError(e.message); } }
  useEffect(() => { load(); }, [id]);

  if (error && !item) return <p className="text-red-600">{error}</p>;
  if (!item) return <p className="text-slate-500">Загрузка…</p>;

  return (
    <div className="max-w-5xl">
      <Link to="/stock/catalog" className="text-sm text-slate-500 hover:text-slate-900">← Справочники</Link>
      <PageHeader title={<span className="flex flex-wrap items-center gap-3">{item.name} <TypeChip type={item.type} />{item.archived && <span className="text-sm font-normal text-slate-400">архив</span>}</span>} />
      <div className="space-y-4">
        <Section title="Основное"><MainForm item={item} onSaved={load} /></Section>
        {item.type === 'SEMI' && <Section title="Рецептура" hint="Состав в % от массы замеса, этапы и нормы ОТК — печатаются в карте замеса."><StockRecipes itemId={item.id} /></Section>}
        {item.type === 'PRODUCT' && <SkuSheet item={item} />}
        <Section title="Остатки по лотам"><ItemStock item={item} /></Section>
      </div>
    </div>
  );
}

function MainForm({ item, onSaved }: { item: any; onSaved: () => void }) {
  const [f, setF] = useState({ name: item.name, unit: item.unit, minStock: item.minStock != null ? String(item.minStock).replace('.', ',') : '', noStock: item.noStock });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function save() {
    setMsg(null);
    try {
      await api.updateItem(item.id, { name: f.name.trim(), unit: f.unit.trim(), minStock: parseNum(f.minStock), noStock: f.noStock });
      setMsg({ ok: true, text: 'Сохранено' }); onSaved();
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  }
  async function archive() {
    await api.updateItem(item.id, { archived: !item.archived });
    onSaved();
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_100px_140px] gap-3">
        <label className="flex flex-col gap-1 text-xs text-slate-500">Наименование
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">Единица
          <input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">Мин. остаток
          <input value={f.minStock} onChange={(e) => setF({ ...f, minStock: e.target.value })} className={inputCls + ' text-right'} placeholder="—" />
        </label>
      </div>
      {item.type === 'RAW' && (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={f.noStock} onChange={(e) => setF({ ...f, noStock: e.target.checked })} />
          Без складского учёта — идёт в рецептуру, но не списывается (вода)
        </label>
      )}
      {msg && <p className={clsx('text-sm', msg.ok ? 'text-emerald-700' : 'text-red-600')}>{msg.text}</p>}
      <div className="flex gap-2">
        <button onClick={save} className={btnPrimary}>Сохранить</button>
        <button onClick={archive} className={btnSecondary}>{item.archived ? 'Вернуть из архива' : 'В архив'}</button>
      </div>
      <p className="text-xs text-slate-500">Минимальный остаток выводит предупреждение на главной и подсвечивает позицию на складе.</p>
    </div>
  );
}

function ItemStock({ item }: { item: any }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { api.getBalances({ itemId: item.id }).then(setRows); }, [item.id]);
  if (!rows) return <p className="text-slate-500">Загрузка…</p>;
  const total = rows.reduce((t, r) => t + r.qty, 0);
  return (
    <div className="overflow-x-auto -m-5">
      {rows.length === 0 ? <p className="p-6 text-sm text-slate-500">Нет остатков. Внесите их <Link to="/stock/docs/new?type=OPENING" className="text-brand-700 hover:underline">начальными остатками</Link> или приходом.</p> : (
        <table className="w-full text-sm tabular-nums">
          <thead className="bg-slate-50/80">
            <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Лот</th>
              <th className="px-3 py-2.5 font-medium">Состояние</th>
              <th className="px-3 py-2.5 font-medium text-right">Остаток</th>
              <th className="px-3 py-2.5 font-medium">Годен до</th>
              <th className="px-3 py-2.5 font-medium text-right">Цена</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.lotId + r.state} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2"><Link to={`/stock/warehouse?tab=moves&lotId=${r.lotId}`} className="font-mono text-xs text-brand-700 hover:underline">{r.lot.number}</Link>{r.lot.barrel && <span className="text-xs text-slate-500 ml-2">бочка {r.lot.barrel}</span>}</td>
                <td className="px-3 py-2 text-slate-600">{STATE_LABEL[r.state] || '—'}</td>
                <td className="px-3 py-2 text-right">{fmtQty(r.qty)} {item.unit}</td>
                <td className="px-3 py-2">{fmtDate(r.lot.expiresAt)}</td>
                <td className="px-3 py-2 text-right">{fmtMoney(r.lot.unitCost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr className="font-semibold"><td className="px-4 py-2" colSpan={2}>Итого</td><td className="px-3 py-2 text-right">{fmtQty(total)} {item.unit}</td><td colSpan={2} /></tr></tfoot>
        </table>
      )}
    </div>
  );
}
