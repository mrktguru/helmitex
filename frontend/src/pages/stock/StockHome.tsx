import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { PageHeader } from './StockLayout';
import { fmtQty } from './common';

const ACTIONS = [
  { to: '/stock/docs/new?type=RECEIPT', label: 'Приход', hint: 'сырьё, тара, упаковка' },
  { to: '/stock/mix/new', label: 'Замес', hint: 'сырьё → бочка' },
  { to: '/stock/fill/new', label: 'Фасовка', hint: 'бочка → тубы, банки' },
  { to: '/stock/quant/new', label: 'Сборка квантов', hint: 'коды ЧЗ → короба' },
  { to: '/stock/fbo', label: 'Поставка FBO', hint: 'кванты → Ozon' },
];

const LEVEL = {
  crit: { bar: 'bg-red-600', text: 'text-red-700' },
  warn: { bar: 'bg-amber-500', text: 'text-amber-800' },
  info: { bar: 'bg-sky-600', text: 'text-slate-800' },
};

export default function StockHome() {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.getDashboard().then(setD).catch((e) => setError(e.message)); }, []);

  const today = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const f = d?.flow;
  const stages = f ? [
    { k: '1 · Материалы', v: f.materials.items, unit: 'поз.', d: `${f.materials.lots} лотов на складе`, to: '/stock/warehouse?type=RAW,CONTAINER,PACKAGING,LABEL' },
    { k: '2 · Бочки', v: f.barrels.count, unit: 'шт', d: `${fmtQty(f.barrels.kg, 1)} кг полуфабриката`, to: '/stock/warehouse?type=SEMI' },
    { k: '3 · Фасовано', v: fmtQty(f.unlabeled.units, 0), unit: 'шт', d: `без ЧЗ${f.unlabeled.labeled ? ` · ${fmtQty(f.unlabeled.labeled, 0)} с ЧЗ россыпью` : ''}`, to: '/stock/warehouse?type=PRODUCT' },
    { k: '4 · Кванты', v: f.quants.count, unit: 'кв.', d: `${fmtQty(f.quants.units, 0)} шт в коробах`, to: '/stock/quants' },
    { k: '5 · FBO', v: f.fbo.active, unit: 'пост.', d: `${f.fbo.boxes} коробок в работе`, to: '/stock/fbo' },
  ] : [];

  return (
    <div>
      <PageHeader title="Сводка" hint={<span className="capitalize">{today}</span>} />

      {error && <p className="text-red-600 mb-4">{error}</p>}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-6">
        {(stages.length ? stages : Array.from({ length: 5 }, () => null)).map((s, i) => s ? (
          <Link key={s.k} to={s.to} className="relative bg-white border border-slate-200 rounded-xl p-4 hover:border-brand-500 transition-colors group">
            <div className="text-xs text-slate-500">{s.k}</div>
            <div className="text-2xl font-bold tabular-nums mt-1">{s.v} <span className="text-sm font-normal text-slate-400">{s.unit}</span></div>
            <div className="text-xs text-slate-500 mt-1">{s.d}</div>
            {i < 4 && <span className="hidden md:block absolute -right-2 top-1/2 -translate-y-1/2 text-slate-300 z-10">›</span>}
          </Link>
        ) : <div key={i} className="bg-white/60 border border-slate-200 rounded-xl h-[104px] animate-pulse" />)}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5">
        <section>
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Требует внимания {d && <span className="text-slate-400 font-normal">{d.alerts.length}</span>}</h2>
          {d && d.alerts.length === 0 && <div className="bg-white border border-slate-200 rounded-xl p-5 text-sm text-slate-500">Всё спокойно: нет просрочек, нехватки и незавершённых документов.</div>}
          <div className="space-y-2">
            {d?.alerts.map((a: any, i: number) => (
              <div key={i} className="bg-white border border-slate-200 rounded-xl flex items-stretch overflow-hidden">
                <div className={clsx('w-1 shrink-0', LEVEL[a.level as keyof typeof LEVEL].bar)} />
                <div className="flex-1 min-w-0 px-4 py-3">
                  <div className={clsx('text-sm font-semibold', LEVEL[a.level as keyof typeof LEVEL].text)}>{a.title}</div>
                  {a.text && <div className="text-xs text-slate-500 mt-0.5">{a.text}</div>}
                </div>
                {a.action && (
                  <Link to={a.action.to} className="self-center mr-3 shrink-0 text-sm border border-slate-200 rounded-lg px-3 py-1.5 hover:border-brand-500 hover:text-brand-700">{a.action.label}</Link>
                )}
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Действия</h2>
          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
            {ACTIONS.map((a) => (
              <Link key={a.to} to={a.to} className="flex items-center justify-between px-4 py-3 hover:bg-brand-50 group">
                <div>
                  <div className="text-sm font-medium group-hover:text-brand-700">+ {a.label}</div>
                  <div className="text-xs text-slate-500">{a.hint}</div>
                </div>
                <span className="text-slate-300 group-hover:text-brand-600">→</span>
              </Link>
            ))}
          </div>
          {f?.quants.byType.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 mt-3">
              <div className="text-xs text-slate-500 mb-2">Кванты на складе</div>
              {f.quants.byType.map((t: any) => (
                <div key={t.name} className="flex justify-between text-sm py-0.5"><span>{t.name}</span><b className="tabular-nums">{t.count}</b></div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
