import { useEffect, useRef } from 'react';

// Простое модальное окно: Esc и клик по фону закрывают, фокус — на первое поле
export default function Modal({ title, onClose, children, width = 'max-w-lg' }: { title: string; onClose: () => void; children: React.ReactNode; width?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('.p-5 input, .p-5 select, .p-5 textarea')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-slate-900/40 p-4 overflow-y-auto" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`bg-white rounded-xl shadow-xl w-full ${width} my-8`}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Закрыть">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
