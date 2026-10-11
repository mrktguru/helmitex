import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import TemplatePreview from '../../components/TemplatePreview';
import VariablesCard from '../../components/VariablesCard';
import CzStatusCard from '../../components/CzStatusCard';
import ExportSection from '../../components/ExportSection';
import { btnPrimary, fmtQty } from './common';
import { PageHeader, Section } from './StockLayout';

// Карточка маркировки SKU: остатки, база кодов ЧЗ, макет этикетки (редактор из сервиса этикеток), печать
export default function StockMarkingItem() {
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<any>(null);
  const [error, setError] = useState('');
  const [previewKey, setPreviewKey] = useState(0);
  const [czKey, setCzKey] = useState(0);
  const navigate = useNavigate();

  const load = () => api.getMarkingItem(id!).then(setRow).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  function czChanged() { setCzKey((k) => k + 1); load(); }

  if (error) return <div><Link to="/stock/marking" className="text-sm text-brand-700">← Маркировка</Link><p className="text-red-600 mt-3">{error}</p></div>;
  if (!row) return <p className="text-sm text-slate-500">Загрузка…</p>;
  const pid = row.project.id as string;
  const editor = `/projects/${pid}/editor?back=${encodeURIComponent(`/stock/marking/${id}`)}`;

  return (
    <div className="space-y-5">
      <div>
        <Link to="/stock/marking" className="text-sm text-brand-700 hover:underline">← Маркировка</Link>
        <PageHeader title={row.name} hint={`Проект этикетки: ${row.project.name}`}>
          <button className={btnPrimary} onClick={() => navigate(editor)}>{row.project.template ? 'Редактировать этикетку' : 'Создать макет этикетки'}</button>
        </PageHeader>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Tile label="Свободных кодов" value={row.codes.pending} cls="text-green-700" />
        <Tile label="Выпущено без ЧЗ" value={row.stock.unlabeled} />
        <Tile label="Не хватает кодов" value={row.shortage} cls={row.shortage ? 'text-red-600' : 'text-slate-400'} />
        <Tile label="Оклеено россыпью" value={row.stock.labeled} />
        <Tile label="В квантах" value={row.stock.inQuant} />
      </div>
      {row.codes.noText > 0 && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {row.codes.noText} кодов из PDF ещё распознаются — текст кода нужен для передачи в WB и выгрузки таблицы, обычно это занимает несколько минут.
        </p>
      )}

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <Section title="Этикетка" hint={row.project.template ? `${row.project.template.widthMm} × ${row.project.template.heightMm} мм · правится в редакторе, печать ниже берёт этот макет` : 'Макет ещё не создан'}
            right={<button className="text-sm text-brand-700 hover:underline" onClick={() => navigate(editor)}>Открыть редактор →</button>}>
            <div key={previewKey} className="bg-slate-50 rounded-lg p-4 min-h-[200px] flex items-center justify-center">
              <TemplatePreview projectId={pid} />
            </div>
          </Section>
        </div>
        <div className="space-y-5">
          <CzStatusCard projectId={pid} onCzChange={czChanged} />
          <VariablesCard projectId={pid} onSaved={() => setPreviewKey((k) => k + 1)} />
        </div>
      </div>

      <ExportSection projectId={pid} czKey={czKey} onCzChange={czChanged} />
    </div>
  );
}

function Tile({ label, value, cls }: { label: string; value: number; cls?: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-2xl font-bold ${cls ?? ''}`}>{fmtQty(value)}</div>
    </div>
  );
}
