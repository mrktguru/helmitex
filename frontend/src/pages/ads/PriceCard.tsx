import { useState } from 'react';
import { api } from '../../api/client';
import Modal from './Modal';
import InlineNumber from './InlineNumber';
import { fmtDate } from '../stock/common';
import { parseNum, pct, rub } from './util';

// Цена: базовая (с зачёркнутой и минимальной) и цена в акциях продавца — это и есть цена продажи
export default function PriceCard({ report, onChanged }: { report: any; onChanged: () => Promise<void> }) {
  const p = report.product.price;
  const promo: any[] = report.product.promo ?? [];
  const sku = report.product.sku;
  const share = report.kpi.cur.ozonShare as number | null;
  const [edit, setEdit] = useState(false);
  const [showAll, setShowAll] = useState(false);

  if (!p) {
    return (
      <section className="bg-white rounded-xl border border-slate-200 p-5">
        <h2 className="font-semibold">Цена</h2>
        <p className="text-sm text-slate-500 mt-2">Нет артикула Ozon — цену не получить. Свяжите товар с Ozon в карточке SKU.</p>
      </section>
    );
  }
  const others = (p.marketing ?? []).filter((m: any) => !promo.some((x) => x.title === m.title));
  const sale = p.sellerPrice || p.price;

  return (
    <section className="bg-white rounded-xl border border-slate-200 min-w-0">
      <div className="flex items-baseline justify-between gap-2 px-5 pt-4 pb-3 border-b border-slate-100">
        <h2 className="font-semibold">Цена</h2>
        <button onClick={() => setEdit(true)} className="text-sm text-brand-700 hover:underline">Изменить базовую</button>
      </div>
      <div className="p-5 space-y-4">
        <div>
          <div className="text-xs text-slate-500">Цена продажи (с акциями продавца)</div>
          <div className="text-3xl font-bold tabular-nums tracking-tight">{rub(sale)}</div>
          {share != null && <div className="text-xs text-slate-500 mt-0.5">Покупатель в среднем платит {rub(sale * (1 - share))} — Ozon доплачивает {pct(share, 0)} баллами и скидками</div>}
        </div>

        <dl className="grid grid-cols-3 gap-3 text-sm">
          <div><dt className="text-xs text-slate-500">Базовая</dt><dd className="tabular-nums font-medium">{rub(p.price)}</dd></div>
          <div><dt className="text-xs text-slate-500">Зачёркнутая</dt><dd className="tabular-nums font-medium">{p.oldPrice ? rub(p.oldPrice) : '—'}</dd></div>
          <div><dt className="text-xs text-slate-500">Минимальная</dt><dd className="tabular-nums font-medium">{p.minPrice ? rub(p.minPrice) : '—'}</dd></div>
          <div><dt className="text-xs text-slate-500">Себестоимость</dt><dd className="tabular-nums font-medium">{p.netPrice ? rub(p.netPrice) : '—'}</dd></div>
        </dl>

        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Акции продавца</div>
          {promo.length === 0 && <p className="text-sm text-slate-500">Товар не участвует в акциях — продаётся по базовой цене.</p>}
          {promo.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 rounded-lg px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium leading-snug">{a.title}</div>
                <div className="text-xs text-slate-500">до {fmtDate(a.dateEnd)}{a.maxActionPrice ? ` · максимум ${rub(a.maxActionPrice)}` : ''}</div>
              </div>
              <InlineNumber value={a.actionPrice} suffix="₽" digits={0} label={`Цена в акции ${a.title}`}
                onSave={async (v) => {
                  if (a.maxActionPrice && v > a.maxActionPrice) throw new Error(`Не выше ${a.maxActionPrice} ₽ — иначе Ozon исключит товар из акции`);
                  await api.adsActionPrice(sku, a.id, v); await onChanged();
                }} />
            </div>
          ))}
        </div>

        {others.length > 0 && (
          <div>
            <button onClick={() => setShowAll(!showAll)} className="text-xs text-slate-500 hover:text-slate-800" aria-expanded={showAll}>
              {showAll ? '▾' : '▸'} Другие акции и программы Ozon ({others.length})
            </button>
            {showAll && (
              <ul className="mt-2 space-y-1 text-xs text-slate-600">
                {others.map((m: any, i: number) => <li key={i} className="flex justify-between gap-3"><span>{m.title}</span><span className="tabular-nums text-slate-400 whitespace-nowrap">до {fmtDate(m.to)}</span></li>)}
              </ul>
            )}
          </div>
        )}
      </div>
      {edit && <PriceModal p={p} sku={sku} onClose={() => setEdit(false)} onSaved={async () => { setEdit(false); await onChanged(); }} />}
    </section>
  );
}

function PriceModal({ p, sku, onClose, onSaved }: { p: any; sku: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [price, setPrice] = useState(String(p.price || ''));
  const [oldPrice, setOldPrice] = useState(String(p.oldPrice || ''));
  const [minPrice, setMinPrice] = useState(String(p.minPrice || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const np = parseNum(price), no = parseNum(oldPrice), nm = parseNum(minPrice);
    const data = {
      price: np != null && np !== p.price ? np : null,
      oldPrice: no != null && no !== p.oldPrice ? no : null,
      minPrice: nm != null && nm !== p.minPrice ? nm : null,
    };
    if (data.price == null && data.oldPrice == null && data.minPrice == null) { setError('Ничего не изменилось'); return; }
    setBusy(true); setError('');
    try { await api.adsPrice(sku, data); await onSaved(); } catch (err: any) { setError(err.message); }
    setBusy(false);
  }
  const field = (label: string, v: string, set: (s: string) => void, hint: string) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input value={v} onChange={(e) => set(e.target.value)} inputMode="decimal" className="border rounded-lg px-2.5 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500" />
      <span className="text-xs text-slate-500">{hint}</span>
    </label>
  );
  return (
    <Modal title="Базовая цена в Ozon" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {field('Цена, ₽', price, setPrice, 'Цена до акций. Цена в акциях продавца меняется отдельно — в карточке цены.')}
        {field('Зачёркнутая, ₽', oldPrice, setOldPrice, 'Должна быть выше цены.')}
        {field('Минимальная, ₽', minPrice, setMinPrice, 'Ниже неё Ozon не опустит цену в автоакциях.')}
        <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2">Изменение уходит в Ozon сразу и записывается в журнал. Ozon применяет цену в течение нескольких минут.</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium">Отмена</button>
          <button disabled={busy} className="bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium">{busy ? 'Сохраняю…' : 'Сохранить в Ozon'}</button>
        </div>
      </form>
    </Modal>
  );
}
