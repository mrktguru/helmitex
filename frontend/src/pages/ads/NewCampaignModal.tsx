import { useState } from 'react';
import clsx from 'clsx';
import { api } from '../../api/client';
import Modal from './Modal';
import { parseNum } from './util';

const PLACEMENTS = [
  { v: 'PLACEMENT_TOP_PROMOTION', label: 'Поиск', hint: 'Клик дороже, но конверсия в заказ обычно выше' },
  { v: 'PLACEMENT_SEARCH_AND_CATEGORY', label: 'Поиск и рекомендации', hint: 'Дешевле клик, больше показов, ниже конверсия' },
];

// Новая кампания с оплатой за клик: товары со ставками, размещение, бюджет, запуск
export default function NewCampaignModal({ products, sku, onClose, onCreated }: { products: any[]; sku: string; onClose: () => void; onCreated: (msg: string) => Promise<void> }) {
  const cur = products.find((p) => p.sku === sku);
  const today = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const [title, setTitle] = useState(`${cur?.name ?? sku} / поиск / ${today}`);
  const [placement, setPlacement] = useState(PLACEMENTS[0].v);
  const [budgetType, setBudgetType] = useState<'week' | 'day'>('week');
  const [budget, setBudget] = useState('50000');
  const [bids, setBids] = useState<Record<string, string>>({ [sku]: '20' });
  const [activate, setActivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = (s: string) => setBids((b) => { const n = { ...b }; if (s in n) delete n[s]; else n[s] = '20'; return n; });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const skus = Object.entries(bids).map(([s, v]) => ({ sku: s, bid: parseNum(v) ?? 0 }));
    if (!skus.length) { setError('Выберите хотя бы один товар'); return; }
    if (skus.some((s) => s.bid <= 0)) { setError('Укажите ставку для каждого товара'); return; }
    const b = parseNum(budget);
    setBusy(true); setError('');
    try {
      const r = await api.adsCreateCampaign({
        title: title.trim(), placement, skus, activate,
        weeklyBudget: budgetType === 'week' ? b : null, dailyBudget: budgetType === 'day' ? b : null,
      });
      await onCreated(r.activated ? `Кампания № ${r.id} создана и запущена` : r.activateError ? `Кампания № ${r.id} создана, но не запущена: ${r.activateError}` : `Кампания № ${r.id} создана (не запущена)`);
    } catch (err: any) { setError(err.message); }
    setBusy(false);
  }

  return (
    <Modal title="Новая рекламная кампания · оплата за клик" onClose={onClose} width="max-w-2xl">
      <form onSubmit={save} className="space-y-5">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Название</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className="border rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </label>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium mb-1">Где показывать</legend>
          <div className="grid sm:grid-cols-2 gap-2">
            {PLACEMENTS.map((p) => (
              <label key={p.v} className={clsx('border rounded-lg px-3 py-2.5 cursor-pointer flex gap-2.5', placement === p.v ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50')}>
                <input type="radio" name="placement" checked={placement === p.v} onChange={() => setPlacement(p.v)} className="accent-brand-600 mt-0.5" />
                <span><span className="text-sm font-medium block">{p.label}</span><span className="text-xs text-slate-500">{p.hint}</span></span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium mb-1">Бюджет</legend>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex border border-slate-200 rounded-lg overflow-hidden text-sm">
              {([['week', 'В неделю'], ['day', 'В день']] as const).map(([k, l]) => (
                <button type="button" key={k} onClick={() => setBudgetType(k)} className={clsx('px-3 py-2', budgetType === k ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>{l}</button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <span className="sr-only">Сумма бюджета</span>
              <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" className="w-32 border rounded-lg px-2.5 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500" /> ₽
            </label>
            <span className="text-xs text-slate-500">Ozon расходует бюджет равномерно; закончится — кампания встанет до следующего периода.</span>
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium mb-1">Товары и ставка за клик</legend>
          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-64 overflow-y-auto">
            {products.map((p) => {
              const on = p.sku in bids;
              return (
                <div key={p.sku} className={clsx('flex items-center gap-3 px-3 py-2', on && 'bg-brand-50/50')}>
                  <input type="checkbox" checked={on} onChange={() => toggle(p.sku)} aria-label={`Добавить ${p.name}`} className="accent-brand-600" />
                  <span className="flex-1 min-w-0 text-sm">{p.name} <span className="text-xs text-slate-400 font-mono">{p.sku}</span></span>
                  {on && (
                    <label className="flex items-center gap-1.5 text-sm">
                      <span className="sr-only">Ставка для {p.name}</span>
                      <input value={bids[p.sku]} onChange={(e) => setBids({ ...bids, [p.sku]: e.target.value })} inputMode="decimal" className="w-20 border rounded-lg px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500" /> ₽
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} className="accent-brand-600" />
          Запустить сразу после создания
        </label>
        <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2">Кампания создаётся в Ozon Performance с ручными ставками. Ozon может отправить её на модерацию — тогда старт будет позже. Создание пишется в журнал.</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium">Отмена</button>
          <button disabled={busy} className="bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium">{busy ? 'Создаю…' : 'Создать кампанию'}</button>
        </div>
      </form>
    </Modal>
  );
}
