import { useEditorStore, LabelElement } from '../store/useEditorStore';

const TYPE_LABELS: Record<string, string> = {
  text: 'Текст',
  barcode: 'Штрихкод',
  image: 'Изображение',
  rect: 'Прямоугольник',
};

export default function LayerList() {
  const { elements, selectedId, selectElement, deleteElement, reorderElements } = useEditorStore();

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

  if (elements.length === 0) {
    return <p className="text-xs text-gray-400">Нет элементов</p>;
  }

  return (
    <div className="space-y-1">
      {[...elements].reverse().map((el, revIdx) => {
        const idx = elements.length - 1 - revIdx;
        const label = el.type === 'text' ? (el as any).text?.slice(0, 12) : TYPE_LABELS[el.type];
        return (
          <div
            key={el.id}
            onClick={() => selectElement(el.id)}
            className={`flex items-center justify-between px-2 py-1 rounded text-sm cursor-pointer ${
              selectedId === el.id ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50'
            }`}
          >
            <span className="truncate flex-1">{label}</span>
            <div className="flex gap-1 ml-1 shrink-0" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => moveUp(idx)} className="text-gray-400 hover:text-gray-700 text-xs">↑</button>
              <button onClick={() => moveDown(idx)} className="text-gray-400 hover:text-gray-700 text-xs">↓</button>
              <button onClick={() => deleteElement(el.id)} className="text-red-400 hover:text-red-600 text-xs">✕</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
