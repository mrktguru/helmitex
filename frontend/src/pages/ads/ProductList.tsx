import { useState } from 'react';
import clsx from 'clsx';
import { delta, fmt, pct, rub } from './util';

const SCALE = 0.6; // шкала полосы ДРР: 0–60%

// Товары для анализа: продажи и доля рекламы за период; риска — предельный ДРР (дальше реклама в минус)
export default function ProductList({ products, sku, onSelect, loading }: { products: any[] | null; sku: string | null; onSelect: (sku: string) => void; loading: boolean }) {
  const [q, setQ] = useState('');
  const list = (products ?? []).filter((p) => !q || `${p.name} ${p.sku} ${p.offerId ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <nav aria-label="Товары" className="bg-white rounded-xl border border-slate-200 flex flex-col min-w-0 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)]">
      <div className="px-4 pt-4 pb-3 border-b border-slate-100 space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold">Товары</h2>
          <span className="text-xs text-slate-400">{products ? products.length : ''}</span>
        </div>
        <label className="block">
          <span className="sr-only">Поиск товара</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название, SKU, артикул"
            className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </label>
      </div>
      <div className="overflow-y-auto p-2 space-y-1">
        {!products && loading && <p className="text-sm text-slate-500 p-3">Загружаю…</p>}
        {products && list.length === 0 && <p className="text-sm text-slate-500 p-3">Ничего не найдено</p>}
        {list.map((p) => {
          const d = delta(p.orders, p.ordersPrev);
          const over = p.drr != null && p.breakEvenDrr != null && p.drr > p.breakEvenDrr;
          return (
            <button key={p.sku} onClick={() => onSelect(p.sku)} aria-current={p.sku === sku}
              className={clsx('w-full text-left rounded-lg px-3 py-2.5 border transition-colors',
                p.sku === sku ? 'bg-brand-50 border-brand-500' : 'border-transparent hover:bg-slate-50')}>
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium leading-snug">{p.name}</span>
                {p.price != null && <span className="text-xs text-slate-500 tabular-nums whitespace-nowrap pt-0.5">{rub(p.price)}</span>}
              </div>
              <div className="flex items-center gap-2 mt-1 text-xs text-slate-500 tabular-nums">
                <span>{fmt(p.orders)} зак.</span>
                {d && <span className={clsx(d.good === true && 'text-green-700', d.good === false && 'text-red-600')}>{d.text}</span>}
                <span className="text-slate-300">·</span>
                <span>{fmt(p.revenue / 1000, 0)} тыс. ₽</span>
                {!p.inCatalog && <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">не в каталоге</span>}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <div className="relative flex-1 h-1.5 rounded bg-slate-100" title={`ДРР ${pct(p.drr)}${p.breakEvenDrr != null ? `, предел ${pct(p.breakEvenDrr)}` : ''}`}>
                  {p.drr != null && <i className={clsx('absolute inset-y-0 left-0 rounded', over ? 'bg-red-500' : 'bg-brand-500')} style={{ width: `${Math.min(100, (p.drr / SCALE) * 100)}%` }} />}
                  {p.breakEvenDrr != null && <u className="absolute -inset-y-1 w-0.5 bg-slate-800" style={{ left: `${Math.min(100, (p.breakEvenDrr / SCALE) * 100)}%` }} />}
                </div>
                <span className={clsx('text-xs tabular-nums w-14 text-right', over ? 'text-red-600 font-semibold' : 'text-slate-600')}>{p.adSpend ? `ДРР ${pct(p.drr, 0)}` : 'без рекл.'}</span>
              </div>
            </button>
          );
        })}
      </div>
      <p className="px-4 py-3 border-t border-slate-100 text-[11px] text-slate-500 leading-snug">
        Полоса — реклама в % от заказов. Чёрная риска — предел: выплата Ozon минус себестоимость. Правее риски реклама убыточна.
      </p>
    </nav>
  );
}
