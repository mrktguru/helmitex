import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { STATE_LABEL, docPath, docTypeLabel, fmtQty } from './common';

export default function StockMoves() {
  const [params, setParams] = useSearchParams();
  const lotId = params.get('lotId') ?? undefined;
  // Внутри вкладки склада сохраняем ?tab=moves
  const setLot = (id?: string) => { const p = new URLSearchParams(params); if (id) p.set('lotId', id); else p.delete('lotId'); setParams(p); };
  const [moves, setMoves] = useState<any[] | null>(null);

  useEffect(() => { setMoves(null); api.getMoves({ lotId, limit: 500 }).then(setMoves); }, [lotId]);

  const lot = lotId && moves?.[0]?.lot;

  return (
    <div className="space-y-4">
      {lotId && (
        <div className="flex items-center gap-3 text-sm">
          <span>Лот <b className="font-mono">{lot?.number ?? '…'}</b>{lot && ` · ${lot.item.name}`}</span>
          <button onClick={() => setLot()} className="text-brand-600 hover:underline">Показать все движения</button>
        </div>
      )}
      <div className="bg-white rounded-xl border overflow-x-auto">
        {!moves ? <p className="p-6 text-slate-500">Загрузка…</p> : moves.length === 0 ? <p className="p-6 text-slate-500">Движений нет.</p> : (
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
                <th className="px-3 py-2 font-medium">Когда</th>
                <th className="px-3 py-2 font-medium">Документ</th>
                <th className="px-3 py-2 font-medium">Позиция</th>
                <th className="px-3 py-2 font-medium">Лот</th>
                <th className="px-3 py-2 font-medium text-right">Кол-во</th>
                <th className="px-3 py-2 font-medium">Автор</th>
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="px-3 py-1.5 whitespace-nowrap text-slate-500">{new Date(m.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <Link to={docPath(m.doc)} className="font-mono text-xs text-brand-700 hover:underline">{m.doc.number}</Link>
                    <span className="text-slate-500 ml-2">{docTypeLabel(m.doc.type)}</span>
                  </td>
                  <td className="px-3 py-1.5">{m.lot.item.name}{m.state !== 'NONE' && <span className="text-slate-500"> · {STATE_LABEL[m.state]}</span>}</td>
                  <td className="px-3 py-1.5">
                    <button onClick={() => setLot(m.lotId)} className="font-mono text-xs text-brand-700 hover:underline">{m.lot.number}</button>
                  </td>
                  <td className={clsx('px-3 py-1.5 text-right whitespace-nowrap font-medium', m.qty < 0 ? 'text-red-600' : 'text-green-700')}>
                    {m.qty > 0 ? '+' : ''}{fmtQty(m.qty)} {m.lot.item.unit}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500 truncate max-w-[160px]">{m.doc.user.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
