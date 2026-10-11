import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { btnPrimary, btnSecondary, fmtQty, inputCls } from './common';
import { PageHeader } from './StockLayout';

// Маркировка: SKU с обязательным ЧЗ — база кодов и выпущенный без ЧЗ остаток
export default function StockMarking() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function load() {
    try {
      const [m, p] = await Promise.all([api.getMarking(), api.getItems('PRODUCT')]);
      setRows(m); setProducts(p);
    } catch (e: any) { setError(e.message); setRows([]); }
  }
  useEffect(() => { load(); }, []);

  async function enable() {
    if (!pick) return;
    setError('');
    try {
      await api.enableMarking(pick);
      navigate(`/stock/marking/${pick}`);
    } catch (e: any) { setError(e.message); }
  }

  const marked = new Set((rows ?? []).map((r) => r.id));
  const free = products.filter((p) => !marked.has(p.id));

  return (
    <div>
      <PageHeader title="Маркировка" hint="Коды Честного знака для выпущенной продукции: загрузка кодов по каждому SKU, макет этикетки и печать. Отсюда же коды берут кванты Ozon и отправки WB.">
        <button className={btnSecondary} onClick={() => setAdding((v) => !v)}>+ Включить маркировку для SKU</button>
      </PageHeader>

      {adding && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4 flex flex-wrap items-center gap-2">
          <select className={clsx(inputCls, 'w-80')} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Выберите SKU…</option>
            {free.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className={btnPrimary} disabled={!pick} onClick={enable}>Включить и создать этикетку</button>
          <span className="text-xs text-slate-500">Для SKU создастся макет этикетки — его можно отредактировать в редакторе.</span>
        </div>
      )}

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {!rows && <p className="text-sm text-slate-500">Загрузка…</p>}
      {rows && rows.length === 0 && (
        <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          Нет SKU с маркировкой. Включите её кнопкой выше или в карточке товара в справочниках.
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows?.map((r) => {
          const usedPct = r.codes.total ? Math.round((r.codes.used / r.codes.total) * 100) : 0;
          return (
            <Link key={r.id} to={`/stock/marking/${r.id}`}
              className="bg-white rounded-xl border border-slate-200 p-4 hover:border-brand-400 hover:shadow-sm transition">
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold leading-snug">{r.name}</div>
                {r.shortage > 0
                  ? <span className="shrink-0 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">не хватает {r.shortage}</span>
                  : r.codes.pending > 0 && <span className="shrink-0 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">коды есть</span>}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Этикетка: {r.project?.template ? `${r.project.template.widthMm}×${r.project.template.heightMm} мм` : 'макет не создан'}
                {r.project?.template && !r.project.template.hasCzArea && <span className="text-amber-700"> · нет поля ЧЗ</span>}
              </div>
              <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                <Num label="Свободных кодов" value={r.codes.pending} cls={r.codes.pending ? 'text-green-700' : 'text-slate-400'} />
                <Num label="Выпущено без ЧЗ" value={r.stock.unlabeled} />
                <Num label="Оклеено / в квантах" value={`${fmtQty(r.stock.labeled)} / ${fmtQty(r.stock.inQuant)}`} />
              </div>
              <div className="mt-3 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-brand-500" style={{ width: `${usedPct}%` }} /></div>
              <div className="text-[11px] text-slate-500 mt-1">Загружено {r.codes.total} · использовано {r.codes.used}{r.codes.spoiled ? ` · испорчено ${r.codes.spoiled}` : ''}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function Num({ label, value, cls }: { label: string; value: number | string; cls?: string }) {
  return (
    <div className="bg-slate-50 rounded-lg py-2">
      <div className={clsx('text-lg font-bold', cls)}>{typeof value === 'number' ? fmtQty(value) : value}</div>
      <div className="text-[11px] text-slate-500 leading-tight">{label}</div>
    </div>
  );
}
