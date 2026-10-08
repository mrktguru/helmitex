import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { PageHeader } from './StockLayout';
import { DOC_STATUS, DOC_TYPES, docPath, docTypeLabel, fmtDate, fmtMoney, newDocPath } from './common';

export default function StockDocs({ fixedType, embedded, title, hint }: { fixedType?: string; embedded?: boolean; title?: string; hint?: string }) {
  const [params, setParams] = useSearchParams();
  const type = fixedType ?? params.get('dtype') ?? '';
  const setType = (t: string) => { const p = new URLSearchParams(params); if (t) p.set('dtype', t); else p.delete('dtype'); setParams(p); };
  const [docs, setDocs] = useState<any[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => { setDocs(null); api.getDocs(type || undefined).then(setDocs); }, [type]);

  const label = DOC_TYPES.find((t) => t.value === fixedType)?.label;
  return (
    <div className="space-y-4">
      {title && (
        <PageHeader title={title} hint={hint}>
          {fixedType && <Link to={newDocPath(fixedType)} className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium">+ {label}</Link>}
        </PageHeader>
      )}
      <div className={clsx('flex flex-wrap items-center justify-between gap-2', (title || (embedded && fixedType)) && 'hidden')}>
        <div className={clsx('flex gap-1 flex-wrap', fixedType && 'invisible')}>
          {[{ value: '', short: 'Все' }, ...DOC_TYPES].map((t) => (
            <button key={t.value} onClick={() => setType(t.value)}
              className={clsx('px-3 py-1.5 rounded-lg text-sm font-medium border',
                type === t.value ? 'bg-brand-600 border-brand-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50')}>
              {t.short}
            </button>
          ))}
        </div>
        <div className={clsx('flex gap-2 flex-wrap', (embedded || title) && 'hidden')}>
          {DOC_TYPES.filter((t) => !fixedType || t.value === fixedType).map((t) => (
            <Link key={t.value} to={newDocPath(t.value)}
              className={clsx('px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap',
                t.value === (fixedType ?? 'RECEIPT') ? 'bg-brand-600 hover:bg-brand-700 text-white' : 'border bg-white hover:bg-slate-50 text-slate-700')}>
              + {t.short}
            </Link>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border overflow-x-auto">
        {!docs ? <p className="p-6 text-slate-500">Загрузка…</p> : docs.length === 0 ? <p className="p-6 text-slate-500">Документов пока нет.</p> : (
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
                <th className="px-3 py-2 font-medium">Номер</th>
                <th className="px-3 py-2 font-medium">Тип</th>
                <th className="px-3 py-2 font-medium">Дата</th>
                <th className="px-3 py-2 font-medium">Поставщик / основание</th>
                <th className="px-3 py-2 font-medium text-right">Строк</th>
                <th className="px-3 py-2 font-medium text-right">Сумма, ₽</th>
                <th className="px-3 py-2 font-medium">Статус</th>
                <th className="px-3 py-2 font-medium">Автор</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} onClick={() => navigate(docPath(d))} className="border-b last:border-0 cursor-pointer hover:bg-brand-50/40">
                  <td className="px-3 py-2 font-mono text-xs">{d.number}</td>
                  <td className="px-3 py-2">{docTypeLabel(d.type)}</td>
                  <td className="px-3 py-2">{fmtDate(d.date)}</td>
                  <td className="px-3 py-2 text-slate-600">{[d.outputItem?.name, d.plannedQty && `${d.plannedQty} кг`, d.barrel && `бочка ${d.barrel}`, d.supplier, d.docRef, d.comment].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="px-3 py-2 text-right">{d.lineCount}</td>
                  <td className="px-3 py-2 text-right">{fmtMoney(d.total)}</td>
                  <td className="px-3 py-2"><span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', DOC_STATUS[d.status].cls)}>{DOC_STATUS[d.status].label}</span></td>
                  <td className="px-3 py-2 text-slate-500 truncate max-w-[160px]">{d.user.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
