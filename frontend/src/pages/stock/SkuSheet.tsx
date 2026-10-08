import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { btnPrimary, btnSecondary, fmtQty, inputCls, parseNum } from './common';
import QuantVariants from './QuantVariants';
import { Section } from './StockLayout';

interface Mat { key: string; itemId: string; qty: string }
let seq = 0;

// Карточка SKU: производство, срок годности, маркировка ЧЗ, Ozon — на одном листе; сохраняется одной кнопкой
export default function SkuSheet({ item }: { item: any }) {
  const [spec, setSpec] = useState<any>(null);
  const [semis, setSemis] = useState<any[]>([]);
  const [mats, setMats] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [f, setF] = useState({ semiItemId: '', netQty: '', shelfLifeMonths: '', requiresCz: false, czProjectId: '' });
  const [lines, setLines] = useState<Mat[]>([]);
  const [offer, setOffer] = useState('');
  const [ozonProducts, setOzonProducts] = useState<{ offerId: string; name: string }[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ozonMsg, setOzonMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState(0);

  async function load() {
    const [all, semi, items, prj] = await Promise.all([api.getSpecs(), api.getItems('SEMI'), api.getItems(), api.getCzProjects()]);
    const sp = all.find((x: any) => x.id === item.id)?.spec ?? null;
    setSpec(sp); setSemis(semi); setProjects(prj);
    setMats(items.filter((i: any) => ['CONTAINER', 'LABEL', 'PACKAGING', 'RAW'].includes(i.type)));
    setF({
      semiItemId: sp?.semiItemId ?? '', netQty: sp?.netQty != null ? String(sp.netQty).replace('.', ',') : '',
      shelfLifeMonths: sp?.shelfLifeMonths ? String(sp.shelfLifeMonths) : '', requiresCz: !!sp?.requiresCz, czProjectId: sp?.czProjectId ?? '',
    });
    setLines(sp?.materials?.length ? sp.materials.map((m: any) => ({ key: String(++seq), itemId: m.itemId, qty: String(m.qtyPerUnit).replace('.', ',') })) : []);
    setOffer(sp?.ozonOfferId ?? '');
  }
  useEffect(() => { load(); }, [item.id]);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      if (f.requiresCz && !f.czProjectId) throw new Error('Выберите проект этикетки ЧЗ');
      const r = await api.saveSpec(item.id, {
        semiItemId: f.semiItemId || null,
        netQty: parseNum(f.netQty),
        shelfLifeMonths: f.shelfLifeMonths ? Number(f.shelfLifeMonths) : null,
        requiresCz: f.requiresCz,
        czProjectId: f.requiresCz ? f.czProjectId : null,
        materials: lines.filter((l) => l.itemId && parseNum(l.qty)).map((l) => ({ itemId: l.itemId, qtyPerUnit: parseNum(l.qty)! })),
      });
      await load();
      setRev((v) => v + 1);
      setMsg({ ok: true, text: `Сохранено${r.recalculated ? `. Срок годности пересчитан у ${r.recalculated} партий` : ''}` });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  }

  async function saveOzon() {
    setOzonMsg(null); setBusy(true);
    try {
      const r = await api.setSpecOzon(item.id, offer.trim() || null);
      await load();
      setOzonMsg(offer.trim() && r.notFound.includes(offer.trim()) ? { ok: false, text: `Артикул ${offer.trim()} не найден в Ozon` } : { ok: true, text: 'Сверено с Ozon' });
    } catch (e: any) { setOzonMsg({ ok: false, text: e.message }); }
    setBusy(false);
  }

  const dirty = spec !== null && (
    f.semiItemId !== (spec?.semiItemId ?? '') || parseNum(f.netQty) !== (spec?.netQty ?? null) ||
    (f.shelfLifeMonths ? Number(f.shelfLifeMonths) : null) !== (spec?.shelfLifeMonths ?? null) ||
    f.requiresCz !== !!spec?.requiresCz || (f.requiresCz && f.czProjectId !== (spec?.czProjectId ?? '')) ||
    JSON.stringify(lines.filter((l) => l.itemId).map((l) => [l.itemId, parseNum(l.qty)])) !== JSON.stringify((spec?.materials ?? []).map((m: any) => [m.itemId, m.qtyPerUnit]))
  );
  const net = parseNum(f.netQty);
  const project = projects.find((p) => p.id === f.czProjectId);

  return (
    <div className="space-y-4">
      <Section title="Производство" hint="Из чего фасуется и что уходит на одну единицу. Используется в фасовке и себестоимости.">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label className="flex flex-col gap-1 text-xs text-slate-500">Полуфабрикат
            <select value={f.semiItemId} onChange={(e) => setF({ ...f, semiItemId: e.target.value })} className={inputCls}>
              <option value="">— любой —</option>
              {semis.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-500">Нетто в 1 шт, кг
            <input value={f.netQty} onChange={(e) => setF({ ...f, netQty: e.target.value })} className={inputCls + ' text-right'} placeholder="0,35" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-500">Срок годности, мес
            <input value={f.shelfLifeMonths} onChange={(e) => setF({ ...f, shelfLifeMonths: e.target.value.replace(/\D/g, '').slice(0, 3) })} className={inputCls + ' text-right'} placeholder="12" />
          </label>
        </div>
        <p className="text-xs text-slate-500 mt-2">
          {f.shelfLifeMonths ? `Партия годна ${f.shelfLifeMonths} мес. с даты фасовки. При изменении срок пересчитается у уже выпущенных партий.` : 'Без срока партия берёт срок годности бочки.'}
          {net ? ` Из 100 кг полуфабриката ≈ ${fmtQty(Math.floor(100 / net), 0)} шт.` : ''}
        </p>

        <div className="mt-4">
          <div className="text-xs text-slate-500 mb-1.5">Материалы на 1 шт (тара, крышка, этикетка без ЧЗ)</div>
          {lines.map((l) => (
            <div key={l.key} className="flex gap-2 mb-1.5 items-center">
              <select value={l.itemId} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, itemId: e.target.value } : x)))} className={inputCls + ' flex-1'}>
                <option value="">— материал —</option>
                {mats.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <input value={l.qty} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)))} className={inputCls + ' w-20 text-right'} />
              <span className="text-xs text-slate-500 w-6">{mats.find((m) => m.id === l.itemId)?.unit}</span>
              <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="text-slate-400 hover:text-red-600 px-1">✕</button>
            </div>
          ))}
          <button onClick={() => setLines((ls) => [...ls, { key: String(++seq), itemId: '', qty: '1' }])} className="text-sm text-brand-700 hover:underline">+ Материал</button>
        </div>
      </Section>

      <Section title="Маркировка «Честный знак»" hint="Если включено — каждый квант этого SKU собирается только с кодами ЧЗ, список кодов хранится в кванте.">
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={f.requiresCz} onChange={(e) => setF({ ...f, requiresCz: e.target.checked })} className="w-4 h-4" />
          <span className="font-medium">Требуется маркировка ЧЗ</span>
        </label>
        {f.requiresCz && (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
            <label className="flex flex-col gap-1 text-xs text-slate-500">Проект этикетки с кодами ЧЗ
              <select value={f.czProjectId} onChange={(e) => setF({ ...f, czProjectId: e.target.value })} className={inputCls}>
                <option value="">— выберите проект —</option>
                {projects.filter((p) => p.hasCzArea).map((p) => <option key={p.id} value={p.id}>{p.name} · свободно {p.freeCodes}</option>)}
              </select>
            </label>
            {project && (
              <Link to={`/projects/${project.id}`} className={clsx('text-sm px-3 py-2 rounded-lg border', project.freeCodes === 0 ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 text-slate-700')}>
                {project.freeCodes === 0 ? 'Кодов нет — загрузить' : `Кодов: ${project.freeCodes}`} →
              </Link>
            )}
          </div>
        )}
      </Section>

      <div className="flex flex-wrap items-center gap-3 sticky bottom-3 z-10">
        <button disabled={busy || !dirty} onClick={save} className={clsx(btnPrimary, 'shadow-sm')}>Сохранить карточку</button>
        {dirty && <span className="text-sm text-amber-700 bg-amber-50 px-2 py-1 rounded">Есть несохранённые изменения</span>}
        {msg && <span className={clsx('text-sm', msg.ok ? 'text-emerald-700' : 'text-red-600')}>{msg.text}</span>}
      </div>

      <Section title="Ozon" hint="Артикул нужен для поставок FBO. SKU и название подтягиваются из Ozon.">
        <div className="flex flex-wrap gap-2 items-end">
          <label className="flex flex-col gap-1 text-xs text-slate-500 flex-1 min-w-[260px]">Артикул (offer_id)
            <input list="ozon-products" value={offer} onFocus={() => { if (!ozonProducts) api.getOzonProducts().then(setOzonProducts).catch(() => {}); }}
              onChange={(e) => setOffer(e.target.value)} className={inputCls + ' font-mono'} />
            <datalist id="ozon-products">{(ozonProducts ?? []).map((p) => <option key={p.offerId} value={p.offerId}>{p.name}</option>)}</datalist>
          </label>
          <button disabled={busy} onClick={saveOzon} className={btnSecondary}>{offer.trim() === (spec?.ozonOfferId ?? '') ? 'Сверить с Ozon' : 'Сохранить и сверить'}</button>
        </div>
        {spec?.ozonSku ? <p className="text-sm text-slate-600 mt-2">SKU Ozon <span className="font-mono">{spec.ozonSku}</span> · {spec.ozonName}</p>
          : <p className="text-sm text-amber-700 mt-2">{spec?.ozonOfferId ? 'SKU Ozon не сверен' : 'Без артикула этот SKU нельзя отгрузить на FBO'}</p>}
        {ozonMsg && <p className={clsx('text-sm mt-1', ozonMsg.ok ? 'text-emerald-700' : 'text-red-600')}>{ozonMsg.text}</p>}
      </Section>

      <QuantVariants key={rev} item={item} spec={spec} />
    </div>
  );
}
