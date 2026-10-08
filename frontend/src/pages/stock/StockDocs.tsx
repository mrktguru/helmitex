import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { DOC_STATUS, DOC_TYPES, docTypeLabel, fmtDate, fmtMoney } from './common';

export default function StockDocs() {
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? '';
  const [docs, setDocs] = useState<any[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => { setDocs(null); api.getDocs(type || undefined).then(setDocs); }, [type]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 flex-wrap">
          {[{ value: '', short: 'Все' }, ...DOC_TYPES].map((t) => (
            <button key={t.value} onClick={() => setParams(t.value ? { type: t.value } : {})}
              className={clsx('px-3 py-1.5 rounded-lg text-sm font-medium border',
                type === t.value ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50')}>
              {t.short}
            </button>
          ))}
        </div>
        <div className="flex gap-2 flex-wrap">
          {DOC_TYPES.map((t) => (
            <Link key={t.value} to={`/stock/docs/new?type=${t.value}`}
              className={clsx('px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap',
                t.value === 'RECEIPT' ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'border bg-white hover:bg-gray-50 text-gray-700')}>
              + {t.short}
            </Link>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border overflow-x-auto">
        {!docs ? <p className="p-6 text-gray-500">Загрузка…</p> : docs.length === 0 ? <p className="p-6 text-gray-500">Документов пока нет.</p> : (
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b">
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
                <tr key={d.id} onClick={() => navigate(`/stock/docs/${d.id}`)} className="border-b last:border-0 cursor-pointer hover:bg-blue-50/40">
                  <td className="px-3 py-2 font-mono text-xs">{d.number}</td>
                  <td className="px-3 py-2">{docTypeLabel(d.type)}</td>
                  <td className="px-3 py-2">{fmtDate(d.date)}</td>
                  <td className="px-3 py-2 text-gray-600">{[d.supplier, d.docRef, d.comment].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="px-3 py-2 text-right">{d.lineCount}</td>
                  <td className="px-3 py-2 text-right">{fmtMoney(d.total)}</td>
                  <td className="px-3 py-2"><span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', DOC_STATUS[d.status].cls)}>{DOC_STATUS[d.status].label}</span></td>
                  <td className="px-3 py-2 text-gray-500 truncate max-w-[160px]">{d.user.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
