import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { PageHeader } from './StockLayout';
import { TypeChip } from './StockWarehouse';
import { ITEM_TYPES, btnPrimary, btnSecondary, fmtQty, inputCls, parseNum } from './common';

export default function StockCatalog() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? '';
  const [items, setItems] = useState<any[] | null>(null);
  const [specs, setSpecs] = useState<Map<string, any>>(new Map());
  const [recipes, setRecipes] = useState<Set<string>>(new Set());
  const [qtypes, setQtypes] = useState<Map<string, number>>(new Map());
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  async function load() {
    const [i, sp, rc, qt] = await Promise.all([api.getItems(undefined, archived), api.getSpecs(), api.getRecipes(), api.getQuantTypes()]);
    setItems(i);
    setSpecs(new Map(sp.map((x: any) => [x.id, x.spec])));
    setRecipes(new Set(rc.filter((x: any) => x.recipe?.lines.length).map((x: any) => x.id)));
    const m = new Map<string, number>();
    for (const t of qt) if (!t.archived) m.set(t.productItemId, (m.get(t.productItemId) ?? 0) + 1);
    setQtypes(m);
  }
  useEffect(() => { load(); }, [archived]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (items ?? [])
      .filter((i) => !type || i.type === type)
      .filter((i) => !s || i.name.toLowerCase().includes(s))
      .sort((a, b) => ITEM_TYPES.findIndex((t) => t.value === a.type) - ITEM_TYPES.findIndex((t) => t.value === b.type) || a.name.localeCompare(b.name, 'ru'));
  }, [items, type, q]);

  // Чего не хватает позиции, чтобы она «работала» в цепочке
  function status(i: any): { ok: boolean; text: string } | null {
    if (i.type === 'SEMI') return recipes.has(i.id) ? { ok: true, text: 'рецептура' } : { ok: false, text: 'нет рецептуры' };
    if (i.type === 'PRODUCT') {
      const sp = specs.get(i.id);
      const miss = [!sp?.netQty && 'нетто', !sp?.ozonSku && 'Ozon', !qtypes.get(i.id) && 'тип кванта'].filter(Boolean);
      return miss.length ? { ok: false, text: `нет: ${miss.join(', ')}` } : { ok: true, text: `Ozon ${sp.ozonOfferId}` };
    }
    return null;
  }

  return (
    <div>
      <PageHeader title="Справочники" hint="Всё, что учитывается: сырьё, тара, упаковка, этикетки, полуфабрикаты и SKU. Рецептура, Ozon и кванты — в карточке позиции.">
        <button onClick={() => { setImporting(true); setAdding(false); }} className={btnSecondary}>Импорт SKU из Ozon</button>
        <button onClick={() => { setAdding(true); setImporting(false); }} className={btnPrimary}>+ Позиция</button>
      </PageHeader>

      {adding && <AddItem defaultType={type || 'RAW'} onDone={(id) => { setAdding(false); if (id) navigate(`/stock/catalog/${id}`); }} />}
      {importing && <ImportOzon onDone={(n) => { setImporting(false); if (n) load(); }} />}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {[{ value: '', label: 'Все' }, ...ITEM_TYPES].map((t) => (
          <button key={t.value} onClick={() => setParams(t.value ? { type: t.value } : {})}
            className={clsx('px-3 py-1.5 rounded-full text-sm border', type === t.value ? 'bg-brand-600 text-white border-brand-600' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-400')}>
            {t.label} <span className="opacity-60">{(items ?? []).filter((i) => !t.value || i.type === t.value).length}</span>
          </button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск" className={inputCls + ' w-56 ml-auto'} />
        <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Архив</label>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        {!items ? <p className="p-6 text-slate-500">Загрузка…</p> : list.length === 0 ? <p className="p-6 text-slate-500 text-sm">Позиций нет.</p> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50/80">
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                <th className="px-4 py-2.5 font-medium">Наименование</th>
                <th className="px-3 py-2.5 font-medium">Тип</th>
                <th className="px-3 py-2.5 font-medium">Ед.</th>
                <th className="px-3 py-2.5 font-medium text-right">Мин. остаток</th>
                <th className="px-4 py-2.5 font-medium">Настройка</th>
              </tr>
            </thead>
            <tbody>
              {list.map((i) => {
                const st = status(i);
                return (
                  <tr key={i.id} onClick={() => navigate(`/stock/catalog/${i.id}`)} className={clsx('border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50', i.archived && 'text-slate-400')}>
                    <td className="px-4 py-2.5 font-medium">{i.name}{i.noStock && <span className="ml-2 text-xs font-normal text-slate-400">без учёта</span>}{i.archived && <span className="ml-2 text-xs font-normal">архив</span>}</td>
                    <td className="px-3 py-2.5"><TypeChip type={i.type} /></td>
                    <td className="px-3 py-2.5 text-slate-600">{i.unit}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{i.minStock != null ? fmtQty(i.minStock) : '—'}</td>
                    <td className="px-4 py-2.5">{st && <span className={clsx('text-xs', st.ok ? 'text-emerald-700' : 'text-amber-700')}>{st.ok ? '✓ ' : '! '}{st.text}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function AddItem({ defaultType, onDone }: { defaultType: string; onDone: (id?: string) => void }) {
  const [f, setF] = useState<{ type: string; name: string; unit: string; minStock: string; noStock: boolean }>({
    type: defaultType, name: '', unit: ITEM_TYPES.find((t) => t.value === defaultType)?.unit ?? 'шт', minStock: '', noStock: false,
  });
  const [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try {
      const it = await api.createItem({ type: f.type, name: f.name.trim(), unit: f.unit.trim(), minStock: parseNum(f.minStock), noStock: f.type === 'RAW' && f.noStock });
      onDone(it.id);
    } catch (err: any) { setError(err.message); }
  }
  return (
    <form onSubmit={save} className="bg-white rounded-xl border border-brand-200 p-4 mb-4 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-slate-500">Тип
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, unit: ITEM_TYPES.find((t) => t.value === e.target.value)!.unit })} className={inputCls}>
          {ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-slate-500 flex-1 min-w-[240px]">Наименование
        <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputCls} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-slate-500 w-20">Ед.
        <input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} className={inputCls} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-slate-500 w-28">Мин. остаток
        <input value={f.minStock} onChange={(e) => setF({ ...f, minStock: e.target.value })} className={inputCls + ' text-right'} />
      </label>
      {f.type === 'RAW' && <label className="flex items-center gap-2 text-sm text-slate-600 pb-2"><input type="checkbox" checked={f.noStock} onChange={(e) => setF({ ...f, noStock: e.target.checked })} /> Без учёта (вода)</label>}
      <button disabled={!f.name.trim()} className={btnPrimary}>Создать</button>
      <button type="button" onClick={() => onDone()} className={btnSecondary}>Отмена</button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}

function ImportOzon({ onDone }: { onDone: (n: number) => void }) {
  const [products, setProducts] = useState<{ offerId: string; name: string }[] | null>(null);
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.getOzonProducts(), api.getSpecs()])
      .then(([p, sp]) => { setProducts(p); setTaken(new Set(sp.map((x: any) => x.spec?.ozonOfferId).filter(Boolean))); })
      .catch((e) => setError(e.message));
  }, []);

  const list = (products ?? []).filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.offerId.includes(q));

  async function run() {
    setBusy(true); setError('');
    try {
      const r = await api.importOzonProducts((products ?? []).filter((p) => sel.has(p.offerId)).map((p) => ({ offerId: p.offerId, name: p.name.slice(0, 200) })));
      onDone(r.created);
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div className="bg-white rounded-xl border border-brand-200 p-4 mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">Импорт SKU из Ozon</h3>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Фильтр: Unitex, Lowtex, артикул…" className={inputCls + ' w-72'} />
      </div>
      {!products && !error && <p className="text-sm text-slate-500">Загружаю товары из Ozon…</p>}
      {products && (
        <div className="max-h-80 overflow-auto border border-slate-100 rounded-lg divide-y divide-slate-100">
          {list.map((p) => (
            <label key={p.offerId} className={clsx('flex items-center gap-3 px-3 py-2 text-sm', taken.has(p.offerId) ? 'text-slate-400' : 'hover:bg-slate-50 cursor-pointer')}>
              <input type="checkbox" disabled={taken.has(p.offerId)} checked={sel.has(p.offerId) || taken.has(p.offerId)}
                onChange={() => setSel((s) => { const n = new Set(s); n.has(p.offerId) ? n.delete(p.offerId) : n.add(p.offerId); return n; })} />
              <span className="font-mono text-xs w-36 shrink-0">{p.offerId}</span>
              <span className="flex-1">{p.name}</span>
              {taken.has(p.offerId) && <span className="text-xs">уже есть</span>}
            </label>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button disabled={busy || sel.size === 0} onClick={run} className={btnPrimary}>{busy ? 'Импортирую…' : `Создать ${sel.size} SKU`}</button>
        <button onClick={() => onDone(0)} className={btnSecondary}>Закрыть</button>
      </div>
      <p className="text-xs text-slate-500">Создаётся позиция «Готовая продукция» с артикулом и SKU Ozon. Нетто, полуфабрикат, тару и тип кванта задайте в карточке.</p>
    </div>
  );
}
