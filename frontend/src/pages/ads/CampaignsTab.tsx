import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../api/client';
import HeatTable from './HeatTable';
import InlineNumber from './InlineNumber';
import { Bucket, CAMPAIGN_METRICS, Gran, campaignBuckets, finishCampaign, bucketLabel } from './periods';
import { CAMPAIGN_STATE, fmt, placementLabel, rub, pct } from './util';
import { Icon } from './icons';

type CGran = '30' | '60' | '180' | 'day' | 'week';
const CG: [CGran, string][] = [['30', '30 мин'], ['60', '1 час'], ['180', '3 часа'], ['day', 'Дни'], ['week', 'Недели']];

export function Switch({ on, warn, onChange, label, disabled }: { on: boolean; warn?: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onChange}
      className={clsx('relative w-10 h-6 rounded-full flex-none transition-colors duration-150 disabled:opacity-50', on ? (warn ? 'bg-amber-500' : 'bg-brand-600') : 'bg-slate-300')}>
      <span className={clsx('absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-150', on && 'translate-x-4')} />
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex bg-slate-100 rounded-lg p-0.5">
      {options.map(([k, l]) => (
        <button key={k} aria-pressed={value === k} onClick={() => onChange(k)}
          className={clsx('h-8 px-3 text-[13px] rounded-md whitespace-nowrap transition-colors', value === k ? 'bg-white text-slate-900 font-semibold shadow-sm' : 'text-slate-600 hover:text-slate-900')}>{l}</button>
      ))}
    </div>
  );
}

const todayMsk = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const shiftDay = (d: string, n: number) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86_400_000).toISOString().slice(0, 10);

function CampaignCard({ c, report, bidder, onChanged, onBidder }: { c: any; report: any; bidder: any; onChanged: () => Promise<void>; onBidder: () => void }) {
  const sku = report.product.sku;
  const [g, setG] = useState<CGran>('day');
  const [day, setDay] = useState(todayMsk());
  const [intra, setIntra] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const isIntra = g === '30' || g === '60' || g === '180';

  useEffect(() => {
    if (!isIntra) return;
    setIntra(null);
    api.adsIntraday(c.id, day, +g as 30 | 60 | 180).then(setIntra).catch((e) => setErr(e.message));
  }, [g, day, c.id]);

  const running = c.state === 'CAMPAIGN_STATE_RUNNING';
  const stopped = c.state === 'CAMPAIGN_STATE_STOPPED';
  const st = CAMPAIGN_STATE[c.state] ?? { label: c.state, on: false };
  async function run(fn: () => Promise<unknown>) { setBusy(true); setErr(''); try { await fn(); await onChanged(); } catch (e: any) { setErr(e.message); } setBusy(false); }
  function toggle() {
    const on = !(running || stopped);
    if (c.productsCount > 1 && !confirm(`Кампания рекламирует ещё ${c.productsCount - 1} тов.: ${c.otherProducts.join(', ')}.\n${on ? 'Включить' : 'Выключить'} всю кампанию?`)) return;
    run(() => api.adsCampaignState(c.id, on));
  }

  // Строки таблицы
  let rows: Bucket[] = []; let compare: ((b: Bucket) => Bucket | undefined) | undefined; let label: ((b: Bucket) => { a: string; b: string }) | undefined;
  if (isIntra && intra) {
    const step = +g; const frac = step / (24 * 60);
    const now = new Date(Date.now() + 3 * 3600_000).toISOString().slice(11, 16);
    const mk = (x: any, d: string): Bucket => finishCampaign({ ...x, key: `${d} ${x.from}`, days: 1, frac, dates: [d] }, c.weeklyBudget);
    const yest = new Map<string, Bucket>(intra.yesterday.map((x: any) => [x.from, mk(x, shiftDay(day, -1))]));
    rows = intra.today.filter((x: any) => x.hasData || (day < todayMsk()) || x.from <= now).map((x: any) => mk(x, day));
    compare = (b) => yest.get(b.key.slice(11));
    const pad = (n: number) => String(n).padStart(2, '0');
    label = (b) => { const from = b.key.slice(11); const [h, m] = from.split(':').map(Number); const end = h * 60 + m + step; return { a: from, b: `до ${pad(Math.floor(end / 60))}:${pad(end % 60)}` }; };
  } else if (!isIntra) {
    rows = campaignBuckets(report.campaignDays?.[c.id] ?? [], g as Gran, c.weeklyBudget);
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 border-b border-slate-200">
        <Switch on={running || stopped} warn={stopped} disabled={busy || c.state === 'CAMPAIGN_STATE_ARCHIVED'} onChange={toggle} label={`Кампания ${c.id}`} />
        <div className="min-w-0">
          <div className="text-[15px] font-semibold truncate max-w-[340px]">{c.title}</div>
          <div className="text-xs text-slate-500">
            № {c.id} · {placementLabel(c.placement)} · {running ? <span className="text-brand-700">активна</span> : stopped ? <span className="text-amber-700 font-medium">включена, стоит до 00:00 — кончился дневной бюджет</span> : st.label.toLowerCase()}
            {c.productsCount > 1 && ` · ещё ${c.productsCount - 1} тов.`}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-500">Ставка
          {c.bid != null ? <InlineNumber value={c.bid} suffix="₽/клик" label={`Ставка кампании ${c.id}`} onSave={(v) => run(() => api.adsCampaignBid(c.id, sku, v))} /> : <span className="text-slate-400">товар убран</span>}
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-500">Бюджет
          <InlineNumber value={c.weeklyBudget || null} suffix="₽/нед" digits={0} label={`Недельный бюджет кампании ${c.id}`} onSave={(v) => run(() => api.adsCampaignBudget(c.id, { weeklyBudget: v }))} />
        </label>
        <button onClick={onBidder} className={clsx('flex items-center gap-1.5 text-[13px] rounded-lg px-2.5 h-8', bidder?.enabled ? 'text-brand-700 bg-brand-50 font-medium' : 'text-slate-500 hover:bg-slate-100')}>
          <Icon name="bolt" />{bidder?.enabled ? `Биддер: заказ ≤ ${fmt(bidder.targetCpo)} ₽` : 'Биддер выключен'}
        </button>
        <div className="flex-1" />
        <span className="text-xs text-slate-500 tabular-nums">за период {rub(c.spend)} · {fmt(c.orders)} зак.</span>
      </div>
      {err && <p className="mx-4 mt-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 bg-slate-50 border-b border-slate-200">
        <Seg value={g} options={CG} onChange={setG} label="Детализация" />
        {isIntra ? (
          <>
            <Seg value={day === todayMsk() ? 'today' : 'yest'} options={[['today', 'Сегодня'], ['yest', 'Вчера']]} onChange={(v) => setDay(v === 'today' ? todayMsk() : shiftDay(todayMsk(), -1))} label="День" />
            <span className="text-xs text-slate-500 flex items-center gap-1.5"><Icon name="clock" />сравнение — то же время вчера
              {intra?.collectingSince && <> · снимки с {new Date(intra.collectingSince).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</>}
              {intra?.lastSnapshot && <> · последний {new Date(intra.lastSnapshot).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</>}</span>
          </>
        ) : <span className="text-xs text-slate-500">разница — к предыдущему периоду</span>}
      </div>
      {isIntra && !intra ? <p className="px-4 py-6 text-sm text-slate-500">Загружаю снимки…</p> : (
        <HeatTable rows={rows} metrics={CAMPAIGN_METRICS} gran={isIntra ? undefined : (g as Gran)} label={label} compare={compare} compact maxHeight="60vh"
          empty={isIntra ? 'Снимков за этот день ещё нет — статистика собирается каждые 30 минут.' : 'Кампания в этот период не крутилась'} />
      )}
    </section>
  );
}

export default function CampaignsTab({ report, gran, onChanged, onBidder }: { report: any; gran: Gran; onChanged: () => Promise<void>; onBidder: (id: string) => void }) {
  const camps = [...report.sources.cpc].sort((a: any, b: any) => {
    const act = (x: any) => (x.state === 'CAMPAIGN_STATE_RUNNING' || x.state === 'CAMPAIGN_STATE_STOPPED' ? 1 : 0);
    return act(b) - act(a) || b.spend - a.spend;
  }).filter((c: any) => c.spend > 0 || c.state === 'CAMPAIGN_STATE_RUNNING' || c.state === 'CAMPAIGN_STATE_STOPPED');
  const [bidders, setBidders] = useState<Record<string, any>>({});
  useEffect(() => { for (const c of camps) api.adsBidder(c.id).then((b) => setBidders((x) => ({ ...x, [c.id]: b }))).catch(() => {}); }, [report]);
  const s = report.sources; const sku = report.product.sku;
  const [err, setErr] = useState('');
  const series: any[] = report.series;
  // оплата за заказ по периодам выбранной детализации
  const buckets = new Map<string, { key: string; days: number; v: number }>();
  for (const r of series) { const k = gran === 'day' ? r.date : gran === 'month' ? r.date.slice(0, 7) : new Date(new Date(r.date + 'T00:00:00Z').getTime() - ((new Date(r.date + 'T00:00:00Z').getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10); const b = buckets.get(k) ?? { key: k, days: 0, v: 0 }; b.days++; b.v += (r.spendSelected || 0) + (r.spendAll || 0); buckets.set(k, b); }
  const cpoList = [...buckets.values()].sort((a, b) => b.key.localeCompare(a.key));
  const cpoTotal = cpoList.reduce((t, b) => t + b.v, 0);
  const revenue = series.reduce((t, r) => t + r.revenue, 0);

  return (
    <div className="space-y-4">
      {camps.length === 0 && <p className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-500">У товара нет кампаний с оплатой за клик. Создайте первую кнопкой «Новая кампания».</p>}
      {camps.map((c: any) => <CampaignCard key={c.id} c={c} report={report} bidder={bidders[c.id]} onChanged={onChanged} onBidder={() => onBidder(c.id)} />)}

      <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 border-b border-slate-200">
          <Switch on={s.selected.enabled} disabled={!s.selected.campaignId} label="Оплата за заказ, выбранные товары"
            onChange={() => { setErr(''); api.adsSelected(sku, !s.selected.enabled).then(onChanged).catch((e) => setErr(e.message)); }} />
          <div>
            <div className="text-[15px] font-semibold">Оплата за заказ</div>
            <div className="text-xs text-slate-500">«выбранные товары»{s.selected.campaignId ? ` № ${s.selected.campaignId}` : ''} и «все товары» — Ozon отдаёт только списания, без показов и кликов</div>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-500">Ставка
            <InlineNumber value={s.selected.enabled ? s.selected.bid : null} suffix="% цены" digits={1} label="Ставка за заказ, %" onSave={(v) => api.adsSelectedBid(sku, v).then(onChanged)} />
          </label>
        </div>
        {err && <p className="mx-4 mt-3 text-sm text-red-600">{err}</p>}
        <div className="flex flex-wrap items-center gap-4 px-4 py-3 text-[13px]">
          <div className="whitespace-nowrap"><span className="text-slate-500">За период</span> <b className="tabular-nums">{rub(cpoTotal)}</b> <span className="text-slate-500 tabular-nums">· {pct(revenue ? cpoTotal / revenue : null)} выручки товара (≈ доля по выручке)</span></div>
          <div className="flex gap-1.5 overflow-x-auto thin max-w-[480px]" aria-label="По периодам">
            {cpoList.map((b) => { const L = bucketLabel(b.key, gran, b.days); return (
              <span key={b.key} className="flex-none rounded-md border border-slate-200 px-2 py-1 text-center min-w-[86px]"><span className="block text-[10.5px] text-slate-400">{L.a}</span><span className="tabular-nums text-xs">{rub(b.v)}</span></span>
            ); })}
          </div>
        </div>
      </section>
    </div>
  );
}
