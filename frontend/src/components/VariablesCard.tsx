import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface Props {
  projectId: string;
  /** Called after a successful save so parent can re-render preview. */
  onSaved?: (variables: Record<string, string>) => void;
}

interface VariableField {
  key: string;
  label: string;
  placeholder?: string;
}

/**
 * Card on the project dashboard listing all `variable`-type elements found in the
 * template, with an input for each. Saves to LabelTemplate.variables on submit.
 */
export default function VariablesCard({ projectId, onSaved }: Props) {
  const [fields, setFields] = useState<VariableField[]>([]);
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
        const vars: VariableField[] = (t.elements ?? [])
          .filter((el: any) => el.type === 'variable')
          .map((el: any) => ({
            key: el.key,
            label: el.label ?? `Переменная ${el.key}`,
            placeholder: el.placeholder,
          }))
          // de-duplicate by key
          .filter((v: VariableField, i: number, arr: VariableField[]) =>
            arr.findIndex((x) => x.key === v.key) === i);
        setFields(vars);
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
      // Filter values to only keys that still exist in the template
      const validKeys = new Set(fields.map((f) => f.key));
      const filtered: Record<string, string> = {};
      Object.entries(values).forEach(([k, v]) => { if (validKeys.has(k)) filtered[k] = v; });
      await api.saveTemplate(projectId, {
        widthMm: template.widthMm,
        heightMm: template.heightMm,
        elements: template.elements,
        czArea: template.czArea,
        barcodeValue: template.barcodeValue ?? null,
        printMargins: template.printMargins ?? null,
        variables: filtered,
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
      {fields.length === 0 ? (
        <p className="text-sm text-gray-500">
          В шаблоне нет переменных. Добавьте их в редакторе (инструмент <span className="font-mono">{'{ }'}</span> Переменная)
          — они появятся здесь как редактируемые поля.
        </p>
      ) : (
        <>
          <div className="space-y-3">
            {fields.map((f) => (
              <div key={f.key}>
                <label className="block text-xs text-gray-500 mb-1">
                  <span className="font-mono text-purple-600">{f.key}</span>
                  {f.placeholder && <span className="text-gray-400 ml-2">· {f.placeholder}</span>}
                </label>
                <input
                  type="text"
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder ?? ''}
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
