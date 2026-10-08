import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import clsx from 'clsx';

const TABS = [
  { to: '/stock', label: 'Остатки', end: true },
  { to: '/stock/docs', label: 'Документы', end: false },
  { to: '/stock/mixes', label: 'Замесы', end: false },
  { to: '/stock/recipes', label: 'Рецептуры', end: false },
  { to: '/stock/items', label: 'Номенклатура', end: false },
  { to: '/stock/moves', label: 'Журнал движений', end: false },
];

export default function StockLayout() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-gray-50 print:bg-white">
      <header className="bg-white shadow-sm px-4 sm:px-6 pt-3 sm:pt-4 print:hidden">
        <div className="flex items-center gap-3 sm:gap-4 mb-2">
          <button onClick={() => navigate('/projects')} className="text-gray-500 hover:text-gray-900 shrink-0">← Проекты</button>
          <h1 className="text-lg sm:text-xl font-bold">Склад</h1>
        </div>
        <nav className="flex gap-1 overflow-x-auto -mb-px">
          {TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) => clsx(
                'px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap',
                isActive ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-800',
              )}
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-6 print:p-0 print:max-w-none">
        <Outlet />
      </main>
    </div>
  );
}
