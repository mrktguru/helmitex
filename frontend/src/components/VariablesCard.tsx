import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { precomputeWraps } from '../lib/wrap';

interface Props {
  projectId: string;
  /** Called after a successful save so parent can re-render preview. */
  onSaved?: (variables: Record<string, string>) => void;
}

interface VarDef {
  token: string;
  name: string;
}

/**
 * Card on the project dashboard listing all declared `variableDefs` of the
 * template, with an input for each value. Saves to LabelTemplate.variables.
 *
 * For backward compatibility, when `variableDefs` is empty but legacy `variable`
 * elements exist on the canvas, fall back to deriving fields from those elements.
 */
export default function VariablesCard({ projectId, onSaved }: Props) {
  const [defs, setDefs] = useState<VarDef[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [template, setTemplate] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.getTemplate(projectId)
      .then((t) => {
        if (cancelled) return;
        setTemplate(t);
        let list: VarDef[] = Array.isArray(t.variableDefs) ? t.variableDefs : [];
        if (list.length === 0) {
          // Legacy fallback — derive from canvas variable elements
          const legacy = (t.elements ?? [])
            .filter((el: any) => el.type === 'variable')
            .map((el: any): VarDef => ({
              token: el.key,
              name: el.label ?? `Переменная ${el.key}`,
            }))
            .filter((v: VarDef, i: number, arr: VarDef[]) =>
              arr.findIndex((x) => x.token === v.token) === i);
          list = legacy;
        }
        setDefs(list);
        setValues(t.variables ?? {});
      })
      .catch(() => setTemplate(null))
      .finally(() => setLoading(false));
    return () => { cancelled = true; };
  }, [projectId]);

  async function handleSave() {
    if (!template) return;
    setSaving(true);
    setError('');
    try {
      const validKeys = new Set(defs.map((d) => d.token));
      const filtered: Record<string, string> = {};
      Object.entries(values).forEach(([k, v]) => { if (validKeys.has(k)) filtered[k] = v; });
      // Recompute browser-side wraps on the substituted text so the PDF generator
      // matches the dashboard preview pixel-for-pixel.
      const elementsWithWraps = precomputeWraps(template.elements ?? [], filtered);
      await api.saveTemplate(projectId, {
        widthMm: template.widthMm,
        heightMm: template.heightMm,
        elements: elementsWithWraps,
        czArea: template.czArea,
        barcodeValue: template.barcodeValue ?? null,
        printMargins: template.printMargins ?? null,
        variables: filtered,
        variableDefs: template.variableDefs ?? null,
      });
      setValues(filtered);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
      onSaved?.(filtered);
    } catch (err: any) {
      setError(err.message ?? 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="bg-white rounded-xl border p-5"><p className="text-sm text-gray-400">Загрузка…</p></div>;
  }

  return (
    <div className="bg-white rounded-xl border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Переменные</h3>
        {savedFlash && <span className="text-xs text-green-600">✓ Сохранено</span>}
      </div>
      {defs.length === 0 ? (
        <p className="text-sm text-gray-500">
          В шаблоне нет переменных. Объявите их в редакторе (инструмент <span className="font-mono">{'{ }'}</span> Переменные)
          и вставляйте в любой текст как <code className="bg-gray-100 px-1 rounded">{'{{token}}'}</code>.
        </p>
      ) : (
        <>
          <div className="space-y-3">
            {defs.map((d) => (
              <div key={d.token}>
                <label className="block text-sm mb-1">
                  <span className="font-medium text-gray-800">{d.name}</span>
                  <span className="ml-2 font-mono text-xs text-purple-600">{`{{${d.token}}}`}</span>
                </label>
                <input
                  type="text"
                  value={values[d.token] ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [d.token]: e.target.value }))}
                  placeholder={`Значение для ${d.name}`}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            ))}
          </div>
          {error && <p className="text-xs text-red-500 mt-3">{error}</p>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="mt-4 w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            {saving ? 'Сохранение…' : 'Сохранить значения'}
          </button>
        </>
      )}
    </div>
  );
}
