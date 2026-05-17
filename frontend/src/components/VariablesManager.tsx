import { useState } from 'react';
import { useEditorStore } from '../store/useEditorStore';
import { VARIABLE_NAME_RE } from '../lib/variables';

export default function VariablesManager() {
  const defs = useEditorStore((s) => s.variableDefs);
  const addVariableDef = useEditorStore((s) => s.addVariableDef);
  const updateVariableDef = useEditorStore((s) => s.updateVariableDef);
  const removeVariableDef = useEditorStore((s) => s.removeVariableDef);

  const [draftName, setDraftName] = useState('');
  const [draftToken, setDraftToken] = useState('');
  const [error, setError] = useState('');

  const tokenTaken = (t: string) => defs.some((d) => d.token === t);

  function handleAdd() {
    const name = draftName.trim();
    const token = draftToken.trim();
    if (!name) { setError('Укажите название'); return; }
    if (!VARIABLE_NAME_RE.test(token)) {
      setError('Токен: латиница, цифры, _; не начинается с цифры');
      return;
    }
    if (tokenTaken(token)) { setError('Такой токен уже есть'); return; }
    addVariableDef({ token, name });
    setDraftName('');
    setDraftToken('');
    setError('');
  }

  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Переменные</p>

      <p className="text-xs text-gray-500 mb-3 leading-relaxed">
        Объявите переменные, которые можно вставлять в любой текстовый элемент
        как <code className="bg-gray-100 px-1 rounded">{'{{token}}'}</code>. Значения задаются на странице проекта.
      </p>

      {defs.length === 0 && (
        <div className="text-xs text-gray-400 italic mb-3 border border-dashed rounded px-3 py-4 text-center">
          Пока нет переменных
        </div>
      )}

      <div className="space-y-2 mb-4">
        {defs.map((def) => (
          <div key={def.token} className="border rounded p-2 bg-gray-50">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0 space-y-1">
                <input
                  type="text"
                  value={def.name}
                  onChange={(e) => updateVariableDef(def.token, { name: e.target.value })}
                  placeholder="Название"
                  className="w-full border rounded px-2 py-1 text-sm"
                />
                <div className="flex items-center gap-1 text-xs">
                  <span className="text-gray-400">{'{{'}</span>
                  <input
                    type="text"
                    value={def.token}
                    readOnly
                    className="flex-1 border rounded px-1 py-0.5 text-xs font-mono bg-white text-gray-700"
                    title="Токен нельзя изменить — удалите и добавьте заново"
                  />
                  <span className="text-gray-400">{'}}'}</span>
                </div>
              </div>
              <button
                onClick={() => {
                  if (confirm(`Удалить переменную "${def.name}" ({{${def.token}}})?`)) {
                    removeVariableDef(def.token);
                  }
                }}
                className="text-xs text-red-500 hover:text-red-700 px-1"
                title="Удалить"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t pt-3 space-y-2">
        <p className="text-xs font-semibold text-gray-600">Добавить переменную</p>
        <input
          type="text"
          value={draftName}
          onChange={(e) => { setDraftName(e.target.value); setError(''); }}
          placeholder="Название (напр. Дата выпуска)"
          className="w-full border rounded px-2 py-1 text-sm"
        />
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-400">{'{{'}</span>
          <input
            type="text"
            value={draftToken}
            onChange={(e) => { setDraftToken(e.target.value); setError(''); }}
            placeholder="token"
            className="flex-1 border rounded px-2 py-1 text-sm font-mono"
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          />
          <span className="text-gray-400">{'}}'}</span>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button
          onClick={handleAdd}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm py-1.5 rounded"
        >
          + Добавить
        </button>
      </div>
    </div>
  );
}
