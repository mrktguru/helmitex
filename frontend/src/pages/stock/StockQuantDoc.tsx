import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, downloadFile } from '../../api/client';
import { DOC_STATUS, QUANT_STATUS, STATE_LABEL, btnPrimary, btnSecondary, fmtDate, fmtMoney, fmtQty } from './common';

export default function StockQuantDoc() {
  const { id } = useParams<{ id: string }>();
  const [doc, setDoc] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [askCancel, setAskCancel] = useState(false);

  async function load() {
    try { setDoc(await api.getQuantDoc(id!)); } catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); }, [id]);

  const batches = doc?.quants.map((q: any) => q.outputBatch).filter(Boolean) ?? [];
  const done = batches.filter((b: any) => b.jobStatus === 'done').length;
  const failed = batches.filter((b: any) => b.jobStatus === 'error').length;
  const generating = batches.length > 0 && done + failed < batches.length;

  // Пока генерируются этикетки — опрашиваем раз в 3 с
  useEffect(() => {
    if (!generating) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [doc, generating]);

  async function dl(path: string, name: string) {
    setError('');
    try { await downloadFile(path, name); } catch (e: any) { setError(e.message); }
  }

  async function cancel(releaseCodes: boolean) {
    setBusy(true); setError('');
    try { await api.cancelDoc(id!, releaseCodes); setAskCancel(false); await load(); } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  if (error && !doc) return <p className="text-red-600">{error}</p>;
  if (!doc) return <p className="text-slate-500">Загрузка…</p>;
  const qt = doc.quantType;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/stock/quants" className="text-slate-500 hover:text-slate-900 text-sm">← Кванты</Link>
        <h2 className="text-xl font-semibold">{doc.imported ? 'Ввод квантов' : 'Сборка квантов'} <span className="font-mono text-base text-slate-500">{doc.number}</span></h2>
        <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', DOC_STATUS[doc.status].cls)}>{DOC_STATUS[doc.status].label}</span>
      </div>

      <div className="bg-white rounded-xl border p-4 grid grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
        <div><div className="text-xs text-slate-500">Тип</div>{qt.name}</div>
        <div><div className="text-xs text-slate-500">Партия</div><span className="font-mono text-xs">{doc.sourceLotNumber}</span> · {STATE_LABEL[doc.sourceState] || '—'}</div>
        <div><div className="text-xs text-slate-500">Квантов × ед.</div>{doc.quantCount} × {qt.unitsPerQuant} = {doc.quantCount * qt.unitsPerQuant}</div>
        <div><div className="text-xs text-slate-500">Дата</div>{fmtDate(doc.date)} · {doc.user.email}</div>
        <div><div className="text-xs text-slate-500">Себестоимость кванта</div>{fmtMoney(doc.quants[0]?.unitCost)}{doc.quants[0]?.unitCost != null && ' ₽'}</div>
      </div>

      {doc.status === 'POSTED' && (
        <div className="bg-white rounded-xl border p-4 space-y-3">
          <h3 className="font-semibold text-sm">Печать</h3>
          {batches.length > 0 && (
            <div className="text-sm">
              Этикетки ЧЗ: {generating ? <span className="text-amber-700">генерируются… {done} из {batches.length}</span>
                : failed ? <span className="text-red-600">ошибка генерации в {failed} кв. — откройте квант и замените коды или отмените сборку</span>
                : <span className="text-green-700">готовы ({done} кв.)</span>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {batches.length > 0 && (
              <button disabled={generating || failed > 0} onClick={() => dl(`/stock/quant-docs/${doc.id}/cz.pdf`, 'cz.pdf')} className={btnPrimary}>
                Этикетки ЧЗ — все кванты подряд
              </button>
            )}
            <button onClick={() => dl(`/stock/quant-labels.pdf?docId=${doc.id}`, 'quants.pdf')} className={batches.length ? btnSecondary : btnPrimary}>
              Этикетки квантов ({qt.labelWidthMm}×{qt.labelHeightMm} мм)
            </button>
            {qt.trackCz && (
              <button onClick={() => dl(`/stock/quant-codes.csv?docId=${doc.id}`, 'codes.csv')} className={btnSecondary}>Список ЧЗ (CSV)</button>
            )}
          </div>
          {batches.length > 0 && (
            <p className="text-xs text-slate-500">В файле ЧЗ этикетки идут блоками по {qt.unitsPerQuant} в порядке номеров квантов: первый блок — в {doc.quants[0]?.number}, второй — в следующий и т. д.</p>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
              <th className="px-3 py-2 font-medium">Квант</th>
              <th className="px-3 py-2 font-medium text-right">Ед.</th>
              <th className="px-3 py-2 font-medium">Статус</th>
              <th className="px-3 py-2 font-medium">Этикетки ЧЗ</th>
            </tr>
          </thead>
          <tbody>
            {doc.quants.map((q: any) => (
              <tr key={q.id} className="border-b last:border-0">
                <td className="px-3 py-2"><Link to={`/stock/quants/${q.id}`} className="font-mono text-brand-700 hover:underline">{q.number}</Link></td>
                <td className="px-3 py-2 text-right">{q.units}</td>
                <td className="px-3 py-2"><span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', QUANT_STATUS[q.status].cls)}>{QUANT_STATUS[q.status].label}</span></td>
                <td className="px-3 py-2">{q.outputBatch ? { pending: 'в очереди', processing: 'генерируется', done: 'готовы', error: 'ошибка' }[q.outputBatch.jobStatus as string] : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {doc.lines.length > 0 && (
        <div className="bg-white rounded-xl border p-4 text-sm">
          <h3 className="font-semibold text-sm mb-2">Списано</h3>
          {doc.lines.map((l: any) => (
            <div key={l.id}>{l.item.name} — {fmtQty(l.qty)} {l.item.unit} <span className="font-mono text-xs text-slate-500">{l.lotNumber}</span></div>
          ))}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {doc.status === 'POSTED' && !askCancel && <button onClick={() => setAskCancel(true)} className={btnSecondary}>Отменить сборку</button>}
      {doc.status === 'POSTED' && askCancel && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3 text-sm">
          <p>Единицы вернутся в партию, короба и материалы — на склад, кванты будут разобраны.{batches.length > 0 && ' Что делать с кодами ЧЗ?'}</p>
          <div className="flex flex-wrap gap-2">
            {batches.length > 0 ? (
              <>
                <button disabled={busy} onClick={() => cancel(false)} className={btnSecondary}>Этикетки напечатаны — коды в брак</button>
                <button disabled={busy} onClick={() => cancel(true)} className={btnSecondary}>Не печатались — вернуть коды в пул</button>
              </>
            ) : <button disabled={busy} onClick={() => cancel(false)} className={btnSecondary}>Отменить сборку</button>}
            <button onClick={() => setAskCancel(false)} className="text-slate-500 hover:underline px-2">Не отменять</button>
          </div>
        </div>
      )}
    </div>
  );
}
