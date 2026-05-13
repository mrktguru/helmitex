import { useState } from 'react';
import { useEditorStore, LabelElement } from '../store/useEditorStore';

const TYPE_LABELS: Record<string, string> = {
  text: 'Текст',
  barcode: 'Штрихкод',
  image: 'Изображение',
  rect: 'Прямоугольник',
};

export default function LayerList() {
  const { elements, selectedId, selectElement, deleteElement, reorderElements, updateElement } = useEditorStore();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');

  function moveUp(index: number) {
    if (index === 0) return;
    const next = [...elements];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    reorderElements(next);
  }

  function moveDown(index: number) {
    if (index === elements.length - 1) return;
    const next = [...elements];
    [next[index + 1], next[index]] = [next[index], next[index + 1]];
    reorderElements(next);
  }

  function startRename(el: LabelElement) {
    setRenamingId(el.id);
    setRenameVal(el.label ?? TYPE_LABELS[el.type] ?? el.type);
  }

  function commitRename(id: string) {
    updateElement(id, { label: renameVal.trim() || undefined } as any);
    setRenamingId(null);
  }

  if (elements.length === 0) {
    return <p className="text-xs text-gray-400">Нет элементов</p>;
  }

  return (
    <div className="space-y-1">
      {[...elements].reverse().map((el, revIdx) => {
        const idx = elements.length - 1 - revIdx;
        const displayLabel = el.label ?? (el.type === 'text' ? (el as any).text?.slice(0, 12) || 'Текст' : TYPE_LABELS[el.type]);

        return (
          <div
            key={el.id}
            onClick={() => { if (renamingId !== el.id) selectElement(el.id); }}
            className={`flex items-center gap-1 px-2 py-1 rounded text-sm cursor-pointer ${
              selectedId === el.id ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50'
            }`}
          >
            {renamingId === el.id ? (
              <input
                autoFocus
                className="flex-1 border rounded px-1 text-xs py-0.5 min-w-0"
                value={renameVal}
                onChange={(e) => setRenameVal(e.target.value)}
                onBlur={() => commitRename(el.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(el.id);
                  if (e.key === 'Escape') setRenamingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="truncate flex-1 min-w-0"
                onDoubleClick={(e) => { e.stopPropagation(); startRename(el); }}
                title="Двойной клик — переименовать"
              >
                {displayLabel}
              </span>
            )}
            <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => startRename(el)} className="text-gray-300 hover:text-gray-600 text-xs" title="Переименовать">✎</button>
              <button onClick={() => moveUp(idx)} className="text-gray-300 hover:text-gray-600 text-xs">↑</button>
              <button onClick={() => moveDown(idx)} className="text-gray-300 hover:text-gray-600 text-xs">↓</button>
              <button onClick={() => deleteElement(el.id)} className="text-red-300 hover:text-red-600 text-xs">✕</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
