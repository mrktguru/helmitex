import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { STATE_LABEL, btnPrimary, fmtDate, fmtQty, inputCls } from './common';

// Разбор кодов из текста: по одному в строке; пустые строки — разделители квантов (необязательно)
function parseCodes(text: string, perQuant: number): { quants: string[][]; total: number } {
  const all = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/\\u001[dD]|<GS>|\{GS\}|␝/g, '\x1d'));
  const quants: string[][] = [];
  for (let i = 0; i < all.length; i += perQuant) quants.push(all.slice(i, i + perQuant));
  return { quants, total: all.length };
}

export default function StockQuantAssemble() {
  const [params] = useSearchParams();
  const imported = params.get('import') === '1';
  const navigate = useNavigate();

  const [types, setTypes] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);
  const [typeId, setTypeId] = useState('');
  const [lotKey, setLotKey] = useState('');
  const [count, setCount] = useState('1');
  const [codesText, setCodesText] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.getQuantTypes().then((t) => setTypes(t.filter((x: any) => !x.archived))); }, []);

  const qt = types.find((t) => t.id === typeId);
  useEffect(() => {
    setLotKey('');
    if (qt) api.getBalances({ itemId: qt.productItemId }).then(setBalances);
  }, [typeId]);

  // Источник: «без ЧЗ» для сборки, «с ЧЗ» — для ввода существующих или досборки из россыпи
  const lots = balances.filter((b) => (imported ? b.state === 'LABELED' : b.state === 'UNLABELED' || b.state === 'LABELED') && b.qty > 0)
    .sort((a, b) => (a.lot.expiresAt ? Date.parse(a.lot.expiresAt) : Infinity) - (b.lot.expiresAt ? Date.parse(b.lot.expiresAt) : Infinity));
  const src = lots.find((b) => `${b.lotId}|${b.state}` === lotKey);
  const n = qt?.unitsPerQuant ?? 0;
  const k = Number(count) || 0;
  const parsed = useMemo(() => (imported && qt?.trackCz ? parseCodes(codesText, n) : null), [codesText, n, imported, qt]);
  const effK = parsed ? parsed.quants.length : k;

  const maxByStock = src && n ? Math.floor(src.qty / n) : null;
  const maxByCodes = !imported && qt?.trackCz && qt.freeCodes != null ? Math.floor(qt.freeCodes / n) : null;

  async function submit() {
    setError('');
    if (!qt || !src) { setError('Выберите вариант кванта и партию'); return; }
    if (parsed) {
      if (parsed.total % n !== 0) { setError(`Кодов ${parsed.total} — не делится на ${n} (единиц в кванте)`); return; }
      if (parsed.quants.length === 0) { setError('Вставьте коды ЧЗ'); return; }
    } else if (k < 1) { setError('Укажите количество квантов'); return; }
    setBusy(true);
    try {
      const doc = await api.assembleQuants({
        quantTypeId: qt.id, sourceLotId: src.lotId, sourceState: src.state, quantCount: effK,
        comment: comment || null, imported, codes: parsed?.quants,
      });
      navigate(`/stock/quant/${doc.id}`, { replace: true });
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/stock/quants" className="text-slate-500 hover:text-slate-900 text-sm">← Кванты</Link>
        <h2 className="text-xl font-semibold">{imported ? 'Ввод существующих квантов' : 'Сборка квантов'}</h2>
      </div>

      {imported && (
        <p className="text-sm text-slate-600 bg-brand-50 border border-brand-100 rounded-lg px-3 py-2">
          Для квантов, собранных до запуска учёта. Единицы берутся из партии в состоянии «с ЧЗ» (внесите их начальными остатками),
          коды ЧЗ вставляются списком. Короба и материалы не списываются, этикетки не печатаются.
        </p>
      )}

      <div className="bg-white rounded-xl border p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-slate-500">Вариант кванта
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={inputCls}>
            <option value="">— выберите —</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.unitsPerQuant} шт</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">Партия
          <select disabled={!qt} value={lotKey} onChange={(e) => setLotKey(e.target.value)} className={inputCls}>
            <option value="">{qt && lots.length === 0 ? '— нет остатков —' : '— выберите —'}</option>
            {lots.map((b) => (
              <option key={b.lotId + b.state} value={`${b.lotId}|${b.state}`}>
                {b.lot.number} · {STATE_LABEL[b.state]} · {fmtQty(b.qty)} шт{b.lot.expiresAt ? ` · до ${fmtDate(b.lot.expiresAt)}` : ''}
              </option>
            ))}
          </select>
        </label>
        {!parsed && (
          <label className="flex flex-col gap-1 text-xs text-slate-500">Количество квантов
            <input value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} className={inputCls + ' text-right'} />
          </label>
        )}
        <label className={clsx('flex flex-col gap-1 text-xs text-slate-500', parsed && 'sm:col-span-2')}>Комментарий
          <input value={comment} onChange={(e) => setComment(e.target.value)} className={inputCls} />
        </label>
      </div>

      {parsed && (
        <div className="bg-white rounded-xl border p-4 space-y-2">
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            Коды ЧЗ — по одному в строке, подряд по квантам ({n} кодов = 1 квант). Можно вставить из сканера или CSV-столбца.
            <textarea value={codesText} onChange={(e) => setCodesText(e.target.value)} rows={10} className={inputCls + ' font-mono text-xs'} />
          </label>
          <p className={clsx('text-sm', parsed.total % n !== 0 ? 'text-red-600' : 'text-slate-600')}>
            Кодов: {parsed.total} → квантов: {Math.floor(parsed.total / n)}{parsed.total % n !== 0 && `, лишних ${parsed.total % n}`}
          </p>
        </div>
      )}

      {qt && src && (
        <div className="bg-white rounded-xl border p-4 text-sm grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div><div className="text-xs text-slate-500">Единиц</div>{effK * n} из {fmtQty(src.qty)}</div>
          <div><div className="text-xs text-slate-500">Хватит на квантов</div>{maxByStock}</div>
          {maxByCodes != null && <div><div className="text-xs text-slate-500">Свободных кодов ЧЗ</div>{qt.freeCodes} (на {maxByCodes} кв.)</div>}
          {!imported && <div><div className="text-xs text-slate-500">Короб</div>{qt.boxItem ? `${qt.boxItem.name} × ${effK}` : '—'}</div>}
          {!imported && qt.materials.length > 0 && (
            <div className="col-span-2 lg:col-span-4 text-xs text-slate-600">
              Спишется: {qt.materials.map((m: any) => `${m.item.name} × ${fmtQty(m.qtyPerQuant * effK)}`).join(', ')}
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button disabled={busy || !src || effK < 1 || (maxByStock != null && effK > maxByStock) || (maxByCodes != null && effK > maxByCodes)}
        onClick={submit} className={btnPrimary}>
        {busy ? 'Формирую…' : imported ? `Внести ${effK} кв.` : `Собрать ${effK} кв. и выдать коды ЧЗ`}
      </button>
      {!imported && qt?.trackCz && (
        <p className="text-xs text-slate-500">На каждый квант выдаётся {n} кодов ЧЗ из проекта «{qt.project?.name}». После проведения появятся PDF: этикетки ЧЗ по квантам подряд и этикетки квантов.</p>
      )}
    </div>
  );
}
