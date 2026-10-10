import { useState } from 'react';
import clsx from 'clsx';
import { api } from '../../api/client';
import { AD, CAMPAIGN_STATE, ORG, fmt, parseNum, pct, placementLabel, rub } from './util';

// Число, которое правится по клику: Enter/✓ — сохранить, Esc/✕ — отмена
export function InlineNumber({ value, suffix, onSave, label, digits = 2 }: { value: number | null; suffix: string; onSave: (v: number) => Promise<void>; label: string; digits?: number }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    const v = parseNum(edit ?? '');
    if (v == null || v <= 0) { setErr('Введите число больше 0'); return; }
    setBusy(true); setErr('');
    try { await onSave(v); setEdit(null); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  }
  if (edit == null) {
    return (
      <button onClick={() => setEdit(value != null ? String(value).replace('.', ',') : '')} title={`Изменить: ${label}`}
        className="tabular-nums text-sm px-2 py-1 rounded-md border border-dashed border-slate-300 hover:border-brand-500 hover:text-brand-700 whitespace-nowrap">
        {value != null ? `${fmt(value, digits)} ${suffix}` : `— ${suffix}`}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex items-center gap-1">
        <input autoFocus value={edit} onChange={(e) => setEdit(e.target.value)} aria-label={label} inputMode="decimal"
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEdit(null); }}
          className="w-20 border rounded-md px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500" />
        <button disabled={busy} onClick={save} className="w-8 h-8 rounded-md bg-brand-600 text-white text-sm disabled:opacity-50" aria-label="Сохранить">✓</button>
        <button onClick={() => { setEdit(null); setErr(''); }} className="w-8 h-8 rounded-md border border-slate-300 text-slate-500 text-sm" aria-label="Отмена">✕</button>
      </span>
      {err && <span className="text-xs text-red-600 max-w-[220px] whitespace-normal">{err}</span>}
    </span>
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onChange}
      className={clsx('relative w-10 h-6 rounded-full transition-colors flex-none disabled:opacity-50', on ? 'bg-brand-600' : 'bg-slate-300')}>
      <span className={clsx('absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

// Ячейка этапа: число, доля от итога полосой, конверсия из предыдущего этапа
function Cell({ v, total, prev, color, bold }: { v: number | null; total: number; prev?: number | null; color: string; bold?: boolean }) {
  if (v == null) return <td className="px-3 py-2.5 text-right text-slate-300">—</td>;
  return (
    <td className="px-3 py-2.5 text-right align-top">
      <div className={clsx('tabular-nums', bold && 'font-semibold')}>{fmt(v)}</div>
      <div className="h-1 rounded bg-slate-100 mt-1 ml-auto w-full max-w-[110px]"><i className="block h-1 rounded" style={{ width: `${total ? Math.min(100, (v / total) * 100) : 0}%`, background: color }} /></div>
      {prev != null && prev > 0 && <div className="text-[11px] text-slate-400 tabular-nums mt-0.5">{pct(v / prev)}</div>}
    </td>
  );
}

export default function SourceFunnel({ report, onChanged, onNew }: { report: any; onChanged: () => Promise<void>; onNew: () => void }) {
  const { sources, product } = report;
  const sku: string = product.sku;
  const t = sources.total;
  const totalSpend = sources.cpc.reduce((s: number, c: any) => s + c.spend, 0) + sources.selected.spend + (sources.allSku?.spend ?? 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setError('');
    try { await fn(); await onChanged(); } catch (e: any) { setError(e.message); }
    setBusy(null);
  }
  function toggleCampaign(c: any, on: boolean) {
    if (c.productsCount > 1 && !confirm(`Кампания ${c.id} рекламирует ещё ${c.productsCount - 1} тов.: ${c.otherProducts.join(', ')}.\n${on ? 'Включить' : 'Выключить'} всю кампанию?`)) return;
    run(c.id, () => api.adsCampaignState(c.id, on));
  }

  const cpo = (spend: number, orders: number) => (orders ? spend / orders : null);
  const breakEven = report.kpi.cur.breakEvenDrr as number | null;
  const drrCls = (v: number | null) => clsx('tabular-nums', v != null && breakEven != null && v > breakEven && 'text-red-600 font-semibold');

  return (
    <section className="bg-white rounded-xl border border-slate-200 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-slate-100">
        <div>
          <h2 className="font-semibold">Воронка по источникам</h2>
          <p className="text-xs text-slate-500 mt-0.5">Под числом — доля в этапе и конверсия из предыдущего этапа. Ставки, бюджеты и переключатели меняются прямо здесь и пишутся в журнал.</p>
        </div>
        <button onClick={onNew} className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium">+ Новая кампания</button>
      </div>
      {error && <p className="mx-5 mt-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[980px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <th className="px-5 py-2.5 text-left font-medium">Источник</th>
              <th className="px-3 py-2.5 text-left font-medium">Ставка · бюджет</th>
              <th className="px-3 py-2.5 text-right font-medium">Показы</th>
              <th className="px-3 py-2.5 text-right font-medium">Карточка</th>
              <th className="px-3 py-2.5 text-right font-medium">Корзина</th>
              <th className="px-3 py-2.5 text-right font-medium">Заказ</th>
              <th className="px-3 py-2.5 text-right font-medium">Расход</th>
              <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">₽ / заказ</th>
              <th className="px-5 py-2.5 text-right font-medium">ДРР</th>
            </tr>
          </thead>
          <tbody>
            {sources.cpc.map((c: any) => {
              const st = CAMPAIGN_STATE[c.state] ?? { label: c.state, on: false };
              const drr = c.ordersMoney ? c.spend / c.ordersMoney : null;
              return (
                <tr key={c.id} className={clsx('border-b border-slate-100 align-top', !st.on && 'bg-slate-50/60')}>
                  <td className="px-5 py-2.5">
                    <div className="flex items-start gap-3">
                      <Switch on={st.on} disabled={busy === c.id || c.state === 'CAMPAIGN_STATE_ARCHIVED'} onChange={() => toggleCampaign(c, !st.on)} label={`Кампания ${c.id}`} />
                      <div className="min-w-0">
                        <div className="font-medium leading-snug">{c.title}</div>
                        <div className="text-xs text-slate-500">№ {c.id} · за клик · {placementLabel(c.placement)} · <span className={st.on ? 'text-green-700' : ''}>{st.label}</span>{c.productsCount > 1 && ` · ещё ${c.productsCount - 1} тов.`}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-col items-start gap-1">
                      {c.bid != null
                        ? <InlineNumber value={c.bid} suffix="₽/клик" label={`Ставка в кампании ${c.id}`} onSave={(v) => run(c.id, () => api.adsCampaignBid(c.id, sku, v))} />
                        : <span className="text-xs text-slate-400">товар убран из РК</span>}
                      <InlineNumber value={c.weeklyBudget || null} suffix="₽/нед" digits={0} label={`Недельный бюджет кампании ${c.id}`} onSave={(v) => run(c.id, () => api.adsCampaignBudget(c.id, { weeklyBudget: v }))} />
                      {c.dailyBudget > 0 && <span className="text-xs text-slate-500 tabular-nums">дневной {rub(c.dailyBudget)}</span>}
                    </div>
                  </td>
                  <Cell v={c.views} total={t.views} color={AD} />
                  <Cell v={c.clicks} total={t.pdpViews} prev={c.views} color={AD} />
                  <Cell v={c.toCart} total={t.toCart} prev={c.clicks} color={AD} />
                  <Cell v={c.orders} total={t.orders} prev={c.toCart} color={AD} />
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{rub(c.spend)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{rub(cpo(c.spend, c.orders))}</td>
                  <td className={clsx('px-5 py-2.5 text-right', drrCls(drr))}>{pct(drr)}</td>
                </tr>
              );
            })}

            <tr className="border-b border-slate-100 align-top">
              <td className="px-5 py-2.5">
                <div className="flex items-start gap-3">
                  <Switch on={sources.selected.enabled} disabled={busy === 'sel' || !sources.selected.campaignId} onChange={() => run('sel', () => api.adsSelected(sku, !sources.selected.enabled))} label="Оплата за заказ, выбранные товары" />
                  <div>
                    <div className="font-medium">Оплата за заказ: выбранные</div>
                    <div className="text-xs text-slate-500">{sources.selected.campaignId ? `№ ${sources.selected.campaignId} · ` : ''}берётся почти со всех заказов товара, а не только с рекламных</div>
                  </div>
                </div>
              </td>
              <td className="px-3 py-2.5">
                <InlineNumber value={sources.selected.enabled ? sources.selected.bid : null} suffix="% цены" digits={1} label="Ставка за заказ, %" onSave={(v) => run('sel', () => api.adsSelectedBid(sku, v))} />
              </td>
              <td colSpan={4} className="px-3 py-2.5 text-xs text-slate-400 text-right">показы и заказы Ozon не разделяет</td>
              <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">≈ {rub(sources.selected.spend)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{rub(cpo(sources.selected.spend, t.orders))}<div className="text-[11px] text-slate-400">на любой заказ</div></td>
              <td className="px-5 py-2.5 text-right tabular-nums">{pct(t.revenue ? sources.selected.spend / t.revenue : null)}</td>
            </tr>

            {sources.allSku && (
              <tr className="border-b border-slate-100 align-top">
                <td className="px-5 py-2.5">
                  <div className="font-medium pl-[52px]">Оплата за заказ: все товары</div>
                  <div className="text-xs text-slate-500 pl-[52px]">№ {sources.allSku.id} · {CAMPAIGN_STATE[sources.allSku.state]?.label ?? sources.allSku.state} · доля списаний по выручке товара</div>
                </td>
                <td className="px-3 py-2.5 text-xs text-slate-400">в кабинете Ozon</td>
                <td colSpan={4} />
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">≈ {rub(sources.allSku.spend)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{rub(cpo(sources.allSku.spend, t.orders))}</td>
                <td className="px-5 py-2.5 text-right tabular-nums">{pct(t.revenue ? sources.allSku.spend / t.revenue : null)}</td>
              </tr>
            )}

            <tr className="border-b border-slate-200 align-top">
              <td className="px-5 py-2.5">
                <div className="flex items-center gap-2 pl-[52px]"><i className="w-2.5 h-2.5 rounded-sm" style={{ background: ORG }} /><span className="font-medium">Органика</span></div>
                <div className="text-xs text-slate-500 pl-[52px]">всё, что не пришло с кликов: поиск, рекомендации, внешний трафик</div>
              </td>
              <td />
              <Cell v={sources.organic.views} total={t.views} color={ORG} />
              <Cell v={sources.organic.clicks} total={t.pdpViews} prev={sources.organic.views} color={ORG} />
              <Cell v={sources.organic.toCart} total={t.toCart} prev={sources.organic.clicks} color={ORG} />
              <Cell v={sources.organic.orders} total={t.orders} prev={sources.organic.toCart} color={ORG} />
              <td className="px-3 py-2.5 text-right text-slate-400">—</td>
              <td className="px-3 py-2.5 text-right text-slate-400">—</td>
              <td className="px-5 py-2.5" />
            </tr>

            <tr className="bg-slate-50 align-top">
              <td className="px-5 py-3 font-semibold"><span className="pl-[52px]">Всего</span></td>
              <td />
              <Cell v={t.views} total={t.views} color="#334155" bold />
              <Cell v={t.pdpViews} total={t.pdpViews} prev={t.views} color="#334155" bold />
              <Cell v={t.toCart} total={t.toCart} prev={t.pdpViews} color="#334155" bold />
              <Cell v={t.orders} total={t.orders} prev={t.toCart} color="#334155" bold />
              <td className="px-3 py-3 text-right tabular-nums font-semibold whitespace-nowrap">{rub(totalSpend)}</td>
              <td className="px-3 py-3 text-right tabular-nums font-semibold whitespace-nowrap">{rub(cpo(totalSpend, t.orders))}</td>
              <td className={clsx('px-5 py-3 text-right font-semibold', drrCls(t.revenue ? totalSpend / t.revenue : null))}>{pct(t.revenue ? totalSpend / t.revenue : null)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="px-5 py-3 text-xs text-slate-500 border-t border-slate-100">
        Карточка у кампаний — клики. «Оплата за заказ» — фактические списания из начислений Ozon, распределённые по товарам пропорционально выручке (≈).
        {breakEven != null && <> Красным — ДРР выше предела {pct(breakEven)}: выше него реклама съедает всю прибыль.</>}
      </p>
    </section>
  );
}
