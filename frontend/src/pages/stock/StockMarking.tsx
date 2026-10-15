import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, downloadFile, uploadForm } from '../../api/client';
import TemplatePreview from '../../components/TemplatePreview';
import { btnPrimary, btnSecondary, fmtDate, fmtQty, inputCls } from './common';
import { PageHeader } from './StockLayout';

const TABS = [
  { key: 'queue', label: 'Ждут маркировки' },
  { key: 'done', label: 'Промаркированы' },
  { key: 'base', label: 'Коды и этикетки' },
] as const;

// Маркировка: очередь партий после фасовки → печать ЧЗ с партией и сроком годности из склада
export default function StockMarking() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'queue') as (typeof TABS)[number]['key'];
  const [queueCount, setQueueCount] = useState<number | null>(null);

  return (
    <div>
      <PageHeader title="Маркировка" hint="Партии после фасовки, которые ждут кодов Честного знака. В этикетку подставляются партия (номер бочки полуфабриката) и срок годности; напечатанные банки переходят в «с ЧЗ».">
        <Link to="/stock/marking?tab=base" className={btnSecondary}>Загрузить ЧЗ</Link>
      </PageHeader>
      <div className="flex gap-1 mb-4">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setParams(t.key === 'queue' ? {} : { tab: t.key })}
            className={clsx('px-3 py-1.5 rounded-full text-sm', tab === t.key ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-100')}>
            {t.label}{t.key === 'queue' && queueCount != null ? ` · ${queueCount}` : ''}
          </button>
        ))}
      </div>
      {tab === 'queue' && <Queue onCount={setQueueCount} onMarked={() => setParams({ tab: 'done' })} />}
      {tab === 'done' && <History />}
      {tab === 'base' && <Base />}
    </div>
  );
}

// ───────────── Ждут маркировки ─────────────

function Queue({ onCount, onMarked }: { onCount: (n: number) => void; onMarked: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api.getMarkingQueue().then((r) => { setRows(r); onCount(r.length); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!rows) return <p className="text-sm text-slate-500">Загрузка…</p>;
  if (rows.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
        Все расфасованные партии промаркированы. Новые появятся здесь после проведения фасовки SKU с маркировкой ЧЗ.
      </div>
    );
  }
  return <div className="space-y-3">{rows.map((r) => <LotRow key={r.lotId} row={r} onMarked={onMarked} />)}</div>;
}

function LotRow({ row, onMarked }: { row: any; onMarked: () => void }) {
  const navigate = useNavigate();
  const qty = Math.floor(row.qty);
  const free = row.sku.freeCodes as number;
  const tpl = row.sku.project?.template;
  const [count, setCount] = useState(String(Math.min(qty, free) || qty));
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const n = Number(count);
  const ok = !!tpl?.hasCzArea && free >= n && n >= 1 && n <= qty;
  const editor = `/projects/${row.sku.project.id}/editor?back=${encodeURIComponent('/stock/marking')}`;

  async function mark() {
    if (!confirm(`Напечатать ${n} этикеток ЧЗ для партии ${row.number}?\n${n} шт. перейдут из «без ЧЗ» в «с ЧЗ».`)) return;
    setBusy(true); setError('');
    try {
      await api.markLot(row.lotId, n);
      onMarked();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div className={clsx('bg-white rounded-xl border p-4', ok || !tpl ? 'border-slate-200' : 'border-red-200')}>
      <div className="grid md:grid-cols-[1fr_auto_auto] gap-4 items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/stock/marking/${row.sku.id}`} className="font-semibold hover:text-brand-700">{row.sku.name}</Link>
            {!tpl ? <Badge cls="bg-amber-100 text-amber-800">нет макета этикетки</Badge>
              : !tpl.hasCzArea ? <Badge cls="bg-amber-100 text-amber-800">в макете нет поля ЧЗ</Badge>
              : free < qty ? <Badge cls="bg-red-100 text-red-700">не хватает {qty - free} кодов</Badge>
              : <Badge cls="bg-green-100 text-green-800">кодов хватает</Badge>}
          </div>
          <div className="text-sm text-slate-500 mt-1">
            Партия ГП <span className="font-mono">{row.number}</span>
            {row.fill && <> · фасовка <Link to={`/stock/fill/${row.fill.id}`} className="font-mono hover:underline">{row.fill.number}</Link> от {fmtDate(row.fill.date)}</>}
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            <Badge cls="bg-amber-50 text-amber-900 border border-amber-200">партия {row.vars.lot}</Badge>
            {row.vars.expiry
              ? <Badge cls="bg-amber-50 text-amber-900 border border-amber-200">годен до {row.vars.expiry}</Badge>
              : <Badge cls="bg-red-50 text-red-700 border border-red-200">срок годности не задан</Badge>}
          </div>
        </div>
        <div className="text-center md:px-4">
          <div className="text-3xl font-bold">{fmtQty(row.qty)}</div>
          <div className="text-xs text-slate-500">шт. без ЧЗ</div>
          <div className={clsx('text-xs', free >= qty ? 'text-green-700' : 'text-red-600')}>свободно кодов: {free}</div>
        </div>
        <div className="flex flex-col gap-2 md:w-56">
          {!tpl ? (
            <button className={btnPrimary} onClick={() => navigate(editor)}>Создать этикетку</button>
          ) : (
            <>
              <div className="flex gap-2">
                <input className={clsx(inputCls, 'w-20 text-center')} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} />
                <button className={clsx(btnPrimary, 'flex-1')} disabled={!ok || busy} onClick={mark}>{busy ? 'Печать…' : `Маркировать ${n || ''}`}</button>
              </div>
              <button className="text-sm text-brand-700 hover:underline text-left" onClick={() => setPreview((v) => !v)}>{preview ? 'Скрыть этикетку' : 'Предпросмотр этикетки'}</button>
            </>
          )}
        </div>
      </div>
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      {preview && tpl && (
        <div className="mt-4 pt-4 border-t border-slate-100 grid md:grid-cols-[1fr_auto] gap-4 items-start">
          <div className="bg-slate-50 rounded-lg p-4"><TemplatePreview projectId={row.sku.project.id} maxWidthPx={420} variables={row.vars} /></div>
          <div className="text-xs text-slate-500 max-w-[240px] space-y-2">
            <p>Из партии подставляются переменные макета:</p>
            <ul className="font-mono space-y-0.5">
              <li>{'{{batch}}'} / {'{{lot}}'} — партия ({row.vars.batch})</li>
              <li>{'{{data}}'} — дата изготовления ({row.vars.data})</li>
              <li>{'{{made}}'} — она же полностью ({row.vars.made})</li>
              <li>{'{{expiry}}'} — годен до ({row.vars.expiry || '—'})</li>
            </ul>
            <p>Значения из редактора для них не используются.</p>
            <button className="text-brand-700 hover:underline" onClick={() => navigate(editor)}>Открыть редактор →</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────── Промаркированы ─────────────

const JOB: Record<string, { label: string; cls: string }> = {
  pending: { label: 'в очереди', cls: 'bg-slate-100 text-slate-600' },
  processing: { label: 'генерируется', cls: 'bg-amber-100 text-amber-800' },
  done: { label: 'готово', cls: 'bg-green-100 text-green-800' },
  error: { label: 'ошибка', cls: 'bg-red-100 text-red-700' },
};

function History() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const timer = useRef<number>();
  async function load() {
    try {
      const r = await api.getMarkingHistory();
      setRows(r);
      // пока этикетки генерируются — обновляем статус
      if (r.some((d) => d.status === 'POSTED' && d.batch && ['pending', 'processing'].includes(d.batch.jobStatus))) {
        timer.current = window.setTimeout(load, 2500);
      }
    } catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); return () => window.clearTimeout(timer.current); }, []);

  async function cancel(d: any) {
    if (!confirm(`Отменить маркировку ${d.number}? ${fmtQty(d.qty)} шт. вернутся в «без ЧЗ».`)) return;
    const printed = d.batch?.jobStatus === 'done';
    const release = !printed || confirm('Этикетки не наклеивали — вернуть коды в пул?\nОК — вернуть коды, Отмена — списать коды в брак.');
    try { await api.cancelDoc(d.id, release); load(); } catch (e: any) { setError(e.message); }
  }

  if (!rows) return <p className="text-sm text-slate-500">Загрузка…</p>;
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
      {error && <p className="text-sm text-red-600 px-4 pt-3">{error}</p>}
      {rows.length === 0 ? <p className="text-sm text-slate-500 p-6 text-center">Маркировок ещё не было</p> : (
        <table className="w-full text-sm min-w-[860px]">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr><th className="px-4 py-2">Документ</th><th>Дата</th><th>SKU</th><th>Партия ГП</th><th>Партия / годен до</th><th className="text-right">Шт.</th><th>Этикетки</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const job = d.batch ? JOB[d.batch.jobStatus] ?? JOB.pending : null;
              return (
                <tr key={d.id} className={clsx('border-t border-slate-100', d.status === 'CANCELLED' && 'text-slate-400')}>
                  <td className="px-4 py-2 font-mono">{d.number}</td>
                  <td>{new Date(d.date).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td>{d.itemName}</td>
                  <td className="font-mono text-xs">{d.lotNumber}</td>
                  <td className="font-mono text-xs">{d.vars.lot} · {d.vars.expiry || '—'}</td>
                  <td className="text-right font-semibold">{fmtQty(d.qty)}</td>
                  <td>{d.status === 'CANCELLED' ? <Badge cls="bg-slate-100 text-slate-500">отменена</Badge> : job && <Badge cls={job.cls}>{job.label}</Badge>}</td>
                  <td className="px-4 text-right whitespace-nowrap space-x-3">
                    {d.status === 'POSTED' && (
                      <button className="text-brand-700 hover:underline" title="Коды для ввода в оборот в Честном знаке" onClick={() => downloadFile(`/stock/marking/docs/${d.id}/ki.xlsx`, `КИ ${d.number}.xlsx`).catch((e) => setError(e.message))}>⇩ коды</button>
                    )}
                    {d.status === 'POSTED' && d.batch?.jobStatus === 'done' && (
                      <button className="text-brand-700 hover:underline" onClick={() => downloadFile(`/stock/batches/${d.batch.id}/pdf`, `${d.number}.pdf`).catch((e) => setError(e.message))}>⇩ PDF</button>
                    )}
                    {d.status === 'POSTED' && <button className="text-slate-500 hover:text-red-600" onClick={() => cancel(d)}>Отменить</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ───────────── Коды и этикетки по SKU ─────────────

function Base() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([api.getMarking(), api.getItems('PRODUCT')])
      .then(([m, p]) => { setRows(m); setProducts(p); })
      .catch((e) => { setError(e.message); setRows([]); });
  }, []);

  async function enable() {
    if (!pick) return;
    setError('');
    try {
      await api.enableMarking(pick);
      navigate(`/stock/marking/${pick}`);
    } catch (e: any) { setError(e.message); }
  }

  const marked = new Set((rows ?? []).map((r) => r.id));
  const free = products.filter((p) => !marked.has(p.id));

  return (
    <div>
      <CzImport skus={rows ?? []} onDone={() => api.getMarking().then(setRows).catch(() => {})} />
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <p className="text-sm text-slate-500 flex-1 min-w-[260px]">Товары с маркировкой. В карточке — база кодов SKU, макет этикетки и печать.</p>
        <button className={btnSecondary} onClick={() => setAdding((v) => !v)}>+ Включить маркировку для SKU</button>
      </div>
      {adding && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4 flex flex-wrap items-center gap-2">
          <select className={clsx(inputCls, 'w-80')} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Выберите SKU…</option>
            {free.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className={btnPrimary} disabled={!pick} onClick={enable}>Включить и создать этикетку</button>
        </div>
      )}
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {!rows && <p className="text-sm text-slate-500">Загрузка…</p>}
      {rows && rows.length === 0 && (
        <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          Нет SKU с маркировкой. Включите её кнопкой выше или в карточке товара в справочниках.
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows?.map((r) => {
          const usedPct = r.codes.total ? Math.round((r.codes.used / r.codes.total) * 100) : 0;
          return (
            <Link key={r.id} to={`/stock/marking/${r.id}`} className="bg-white rounded-xl border border-slate-200 p-4 hover:border-brand-400 hover:shadow-sm transition">
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold leading-snug">{r.name}</div>
                {r.shortage > 0
                  ? <Badge cls="bg-red-100 text-red-700">не хватает {r.shortage}</Badge>
                  : r.codes.pending > 0 && <Badge cls="bg-green-100 text-green-800">коды есть</Badge>}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                GTIN {r.gtin ? <span className="font-mono">{r.gtin.gtin}</span> : <span className="text-amber-700">не определён</span>} ·{' '}
                Этикетка: {r.project?.template ? `${r.project.template.widthMm}×${r.project.template.heightMm} мм` : 'макет не создан'}
                {r.project?.template && !r.project.template.hasCzArea && <span className="text-amber-700"> · нет поля ЧЗ</span>}
              </div>
              <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                <Num label="Свободных кодов" value={r.codes.pending} cls={r.codes.pending ? 'text-green-700' : 'text-slate-400'} />
                <Num label="Выпущено без ЧЗ" value={r.stock.unlabeled} />
                <Num label="С ЧЗ / в квантах" value={`${fmtQty(r.stock.labeled)} / ${fmtQty(r.stock.inQuant)}`} />
              </div>
              <div className="mt-3 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-brand-500" style={{ width: `${usedPct}%` }} /></div>
              <div className="text-[11px] text-slate-500 mt-1">Загружено {r.codes.total} · использовано {r.codes.used}{r.codes.spoiled ? ` · испорчено ${r.codes.spoiled}` : ''}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ───────────── Загрузка ЧЗ на все SKU ─────────────

function CzImport({ skus, onDone }: { skus: any[]; onDone: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const [shown, setShown] = useState(5);
  const fileRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number>();

  async function load() {
    try {
      const r = await api.getCzImports();
      setRows(r);
      window.clearTimeout(timer.current);
      if (r.some((x) => x.status === 'processing')) timer.current = window.setTimeout(load, 2000);
      else onDone();
    } catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); return () => window.clearTimeout(timer.current); }, []);

  // Несколько файлов — по очереди; ошибка одного не останавливает остальные
  async function upload(list: FileList | File[] | null | undefined) {
    const files = Array.from(list ?? []).filter((f) => /\.(pdf|csv|txt)$/i.test(f.name) || /pdf|csv|text\/plain/.test(f.type));
    if (!files.length) { setError('Подходят только PDF, CSV или TXT'); return; }
    setError(''); setShown((n) => Math.max(5, files.length));
    const errors: string[] = [];
    for (const [i, f] of files.entries()) {
      setBusy(files.length > 1 ? `Загрузка ${i + 1} из ${files.length}: ${f.name}` : `Загрузка ${f.name}…`);
      try { await uploadForm('/stock/marking/import', f); await load(); } catch (e: any) { errors.push(`${f.name}: ${e.message}`); }
    }
    if (errors.length) setError(errors.join('\n'));
    setBusy('');
  }

  async function assign(id: string, gtin: string, itemId: string) {
    if (!itemId) return;
    try { await api.assignCzImport(id, gtin, itemId); await load(); } catch (e: any) { setError(e.message); }
  }

  const recent = rows.slice(0, shown);
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 mb-5">
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy) upload(e.dataTransfer.files); }}
        onClick={() => !busy && fileRef.current?.click()}
        className={clsx('border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition', drag ? 'border-brand-500 bg-brand-50' : 'border-slate-300 hover:border-brand-400')}>
        <div className="font-semibold">{busy || (drag ? 'Отпустите — загрузим все файлы' : 'Загрузить ЧЗ — выберите или перетащите сюда файлы')}</div>
        <div className="text-xs text-slate-500 mt-1">Можно сразу несколько: PDF из Честного знака (по 500–1000 кодов) или CSV. Коды разложатся по товарам сами по GTIN; повторно загруженные коды пропускаются.</div>
        <input ref={fileRef} type="file" multiple accept="application/pdf,.pdf,text/csv,.csv,.txt" className="hidden"
          onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; upload(files); }} />
      </div>
      {error && <p className="text-sm text-red-600 mt-3 whitespace-pre-line">{error}</p>}
      {recent.length > 0 && (
        <div className="mt-4 divide-y divide-slate-100">
          {recent.map((r) => (
            <div key={r.id} className="py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.fileName}</span>
                <span className="text-xs text-slate-500">{new Date(r.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span>
                {r.status === 'processing' && <Badge cls="bg-amber-100 text-amber-800">распознаётся {r.decoded}/{r.pages || '…'}</Badge>}
                {r.status === 'error' && <Badge cls="bg-red-100 text-red-700">ошибка: {r.error}</Badge>}
              </div>
              {r.status === 'processing' && r.pages > 0 && (
                <div className="mt-1.5 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-brand-500 transition-all" style={{ width: `${(r.decoded / r.pages) * 100}%` }} /></div>
              )}
              {r.result && (
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {r.result.bySku.map((b: any) => (
                    <span key={b.gtin}><b className="text-green-700">+{b.added}</b> {b.name}{b.duplicates ? <span className="text-slate-500"> · повторов {b.duplicates}</span> : ''}</span>
                  ))}
                  {r.result.invalid > 0 && <span className="text-amber-700">не коды ЧЗ: {r.result.invalid}</span>}
                  {r.result.failedPages?.length > 0 && <span className="text-red-600">не распознаны страницы: {r.result.failedPages.slice(0, 10).join(', ')}{r.result.failedPages.length > 10 ? '…' : ''}</span>}
                </div>
              )}
              {r.result && Object.entries(r.result.unassigned ?? {}).map(([gtin, n]) => (
                <div key={gtin} className="mt-2 flex flex-wrap items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs">
                  <span>GTIN <span className="font-mono">{gtin}</span> — {String(n)} кодов: товар не найден.</span>
                  <select className={clsx(inputCls, 'w-72 text-xs')} defaultValue="" onChange={(e) => assign(r.id, gtin, e.target.value)}>
                    <option value="">Это коды товара…</option>
                    {skus.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Badge({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={clsx('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap', cls)}>{children}</span>;
}

function Num({ label, value, cls }: { label: string; value: number | string; cls?: string }) {
  return (
    <div className="bg-slate-50 rounded-lg py-2">
      <div className={clsx('text-lg font-bold', cls)}>{typeof value === 'number' ? fmtQty(value) : value}</div>
      <div className="text-[11px] text-slate-500 leading-tight">{label}</div>
    </div>
  );
}
