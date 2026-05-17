import { useState } from 'react';
import { useEditorStore, LabelElement } from '../store/useEditorStore';

const TYPE_LABELS: Record<string, string> = {
  text: 'Текст',
  barcode: 'Штрихкод',
  image: 'Изображение',
  rect: 'Прямоугольник',
  eac: 'Знак ЕАС',
  variable: 'Переменная',
};

export default function LayerList() {
  const { elements, selectedId, selectElement, deleteElement, reorderElements, updateElement } = useEditorStore();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);

  function startRename(el: LabelElement) {
    setRenamingId(el.id);
    setRenameVal(el.label ?? TYPE_LABELS[el.type] ?? el.type);
  }

  function commitRename(id: string) {
    updateElement(id, { label: renameVal.trim() || undefined } as any);
    setRenamingId(null);
  }

  function toggleLock(el: LabelElement) {
    updateElement(el.id, { locked: !el.locked } as any);
  }

  /**
   * The list is rendered top→bottom in *reversed* element order (top of the list = topmost layer).
   * To reorder, we work on the original elements array index space.
   */
  function handleDrop(targetIdx: number) {
    if (dragId == null) return;
    const fromIdx = elements.findIndex((e) => e.id === dragId);
    if (fromIdx < 0 || fromIdx === targetIdx) {
      setDragId(null); setDropTargetIdx(null); return;
    }
    const next = [...elements];
    const [item] = next.splice(fromIdx, 1);
    // After removing, target index shifts if it was after fromIdx
    const insertAt = targetIdx > fromIdx ? targetIdx - 1 : targetIdx;
    next.splice(insertAt, 0, item);
    reorderElements(next);
    setDragId(null); setDropTargetIdx(null);
  }

  if (elements.length === 0) {
    return <p className="text-xs text-gray-400">Нет элементов</p>;
  }

  // Reversed view: list[0] = topmost layer = elements[elements.length-1]
  const reversed = [...elements].reverse();

  return (
    <div className="space-y-0.5">
      {reversed.map((el, revIdx) => {
        const idx = elements.length - 1 - revIdx;
        const displayLabel = el.label ?? (el.type === 'text' ? (el as any).text?.slice(0, 12) || 'Текст' : TYPE_LABELS[el.type] ?? el.type);
        const isDragging = dragId === el.id;
        // Drop-line indicator above this item (i.e. inserting at this idx in display order
        // ⇒ array idx = idx + 1, since reversed order)
        const showDropLine = dropTargetIdx === idx + 1 && dragId !== null && dragId !== el.id;

        return (
          <div key={el.id}>
            {showDropLine && <div className="h-0.5 bg-blue-500 rounded mx-1" />}
            <div
              draggable={renamingId !== el.id}
              onDragStart={(e) => {
                setDragId(el.id);
                e.dataTransfer.effectAllowed = 'move';
                // Required for Firefox
                e.dataTransfer.setData('text/plain', el.id);
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === el.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                // Drop above this item ⇒ insert at array idx + 1 (above = higher z-order)
                const rect = e.currentTarget.getBoundingClientRect();
                const above = (e.clientY - rect.top) < rect.height / 2;
                setDropTargetIdx(above ? idx + 1 : idx);
              }}
              onDragLeave={(e) => {
                // Only clear if leaving the element entirely (not a child)
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  // no-op; let next dragOver update
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dropTargetIdx != null) handleDrop(dropTargetIdx);
              }}
              onDragEnd={() => { setDragId(null); setDropTargetIdx(null); }}
              onClick={() => { if (renamingId !== el.id) selectElement(el.id); }}
              className={`flex items-center gap-1 px-2 py-1 rounded text-sm cursor-pointer select-none ${
                selectedId === el.id ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50'
              } ${isDragging ? 'opacity-40' : ''} ${el.locked ? 'text-gray-400' : ''}`}
              title="Перетащите для изменения порядка"
            >
              <span className="text-gray-300 text-xs cursor-grab active:cursor-grabbing" title="Перетащить">⋮⋮</span>
              <button
                onClick={(e) => { e.stopPropagation(); toggleLock(el); }}
                className="text-sm hover:opacity-80"
                style={{ filter: el.locked ? 'none' : 'grayscale(1)', opacity: el.locked ? 1 : 0.4 }}
                title={el.locked ? 'Разблокировать слой' : 'Заблокировать слой'}
              >
                🔒
              </button>
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
              <div className="flex gap-1 shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => startRename(el)} className="text-gray-300 hover:text-gray-600 text-xs" title="Переименовать">✎</button>
                <button
                  onClick={() => { if (!el.locked) deleteElement(el.id); }}
                  className={`text-xs ${el.locked ? 'text-gray-200 cursor-not-allowed' : 'text-red-300 hover:text-red-600'}`}
                  title={el.locked ? 'Снимите блокировку для удаления' : 'Удалить'}
                  disabled={el.locked}
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        );
      })}
      {/* Drop zone at the bottom (insert at array index 0 = lowest layer) */}
      {dragId && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDropTargetIdx(0); }}
          onDrop={(e) => { e.preventDefault(); handleDrop(0); }}
          className="h-3"
        >
          {dropTargetIdx === 0 && <div className="h-0.5 bg-blue-500 rounded mx-1" />}
        </div>
      )}
    </div>
  );
}
