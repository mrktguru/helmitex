import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useAuthStore } from '../../store/useAuthStore';
import { api } from '../../api/client';

interface NavItem { to: string; label: string; icon: string; match: string[]; children?: { to: string; label: string; match: string[] }[] }

// Разделы по ходу работы: главная → склад → производство → отгрузки; справочники отдельно
const NAV: NavItem[] = [
  { to: '/stock', label: 'Главная', icon: '◎', match: ['/stock'] },
  { to: '/stock/warehouse', label: 'Склад', icon: '▦', match: ['/stock/warehouse', '/stock/docs', '/stock/moves'] },
  {
    to: '/stock/mixes', label: 'Производство', icon: '⚙', match: ['/stock/mix', '/stock/fill', '/stock/quant', '/stock/marking'],
    children: [
      { to: '/stock/mixes', label: 'Замесы', match: ['/stock/mix'] },
      { to: '/stock/fills', label: 'Фасовка', match: ['/stock/fill'] },
      { to: '/stock/marking', label: 'Маркировка', match: ['/stock/marking'] },
      { to: '/stock/quants', label: 'Кванты', match: ['/stock/quant'] },
    ],
  },
  { to: '/stock/fbo', label: 'Отгрузки FBO', icon: '⇪', match: ['/stock/fbo'] },
  { to: '/stock/wb', label: 'Отправки WB FBS', icon: '⇡', match: ['/stock/wb'] },
  { to: '/stock/ozon-fbs', label: 'Отправки Ozon FBS', icon: '⇡', match: ['/stock/ozon-fbs'] },
  { to: '/stock/ads', label: 'Аналитика рекламы', icon: '◔', match: ['/stock/ads'] },
  { to: '/stock/catalog', label: 'Справочники', icon: '☰', match: ['/stock/catalog'] },
];

// '/stock/mix' совпадает с /stock/mix/…, /stock/mixes; '/stock/quant' — с /stock/quants, /stock/quant/…
function isActive(path: string, match: string[]) {
  return match.some((m) => path === m || path.startsWith(m + '/') || path.startsWith(m + 's') || path.startsWith(m + 'es'));
}

export default function StockLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const clearAuth = useAuthStore((s) => s.clearAuth);

  async function logout() {
    await api.logout().catch(() => {});
    clearAuth();
    navigate('/login');
  }

  const prod = NAV[2];
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [pathname]);
  const current = NAV.find((n) => (n.to === '/stock' ? pathname === '/stock' : isActive(pathname, n.match)));

  const navList = (mobile: boolean) => (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((n) => {
        const active = n.to === '/stock' ? pathname === '/stock' : isActive(pathname, n.match);
        return (
          <div key={n.to}>
            <NavLink to={n.to} end={n.to === '/stock'}
              className={clsx('flex items-center gap-2.5 px-2.5 rounded-lg whitespace-nowrap', mobile ? 'py-3 text-base' : 'py-2 text-sm',
                active ? 'bg-brand-100 text-brand-800 font-semibold' : 'text-slate-700 hover:bg-slate-100')}>
              <span className="w-5 text-center text-slate-400">{n.icon}</span>{n.label}
            </NavLink>
            {n.children && (active || mobile) && (
              <div className="flex flex-col ml-7 mt-0.5 mb-1 border-l border-slate-200">
                {n.children.map((c) => (
                  <NavLink key={c.to} to={c.to}
                    className={clsx('pl-3 -ml-px border-l-2', mobile ? 'py-2.5 text-base' : 'py-1.5 text-sm',
                      isActive(pathname, c.match) ? 'border-brand-600 text-brand-700 font-medium' : 'border-transparent text-slate-500 hover:text-slate-800')}>
                    {c.label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
  const footer = (
    <div className="flex flex-col gap-1 mt-auto px-2 pt-4 border-t border-slate-100 text-sm">
      <button onClick={() => navigate('/projects')} className="text-left text-slate-600 hover:text-slate-900 py-1">Этикетки и коды ЧЗ →</button>
      <div className="text-xs text-slate-400 truncate pt-2">{user?.email}</div>
      <button onClick={logout} className="text-left text-xs text-slate-500 hover:text-slate-800 py-1">Выйти</button>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#EEF2F3] text-slate-900 font-ui lg:grid lg:grid-cols-[232px_minmax(0,1fr)] print:block print:bg-white">
      {/* Телефон: верхняя панель и выезжающее меню */}
      <header className="lg:hidden sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200 flex items-center gap-3 px-3 h-14 print:hidden">
        <button onClick={() => setMenu(true)} className="w-10 h-10 -ml-1 rounded-lg text-2xl leading-none text-slate-700 active:bg-slate-100" aria-label="Меню">☰</button>
        <div className="min-w-0"><div className="font-bold tracking-tight leading-tight">HELMITEX</div><div className="text-xs text-slate-500 truncate">{current?.label ?? 'Учёт производства'}</div></div>
      </header>
      {menu && (
        <div className="lg:hidden fixed inset-0 z-40 print:hidden" onClick={() => setMenu(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 left-0 w-[82%] max-w-xs bg-white flex flex-col px-3 py-4 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-2 pb-3">
              <div><div className="font-bold tracking-tight">HELMITEX</div><div className="text-xs text-slate-500">Учёт производства</div></div>
              <button onClick={() => setMenu(false)} className="w-10 h-10 rounded-lg text-xl text-slate-500 active:bg-slate-100" aria-label="Закрыть">✕</button>
            </div>
            {navList(true)}
            {footer}
          </aside>
        </div>
      )}
      <aside className="hidden lg:flex bg-white border-r border-slate-200 sticky top-0 h-screen flex-col gap-1 px-3 py-5 overflow-y-auto print:hidden z-20">
        <div className="px-2 pb-4">
          <div className="font-bold tracking-tight">HELMITEX</div>
          <div className="text-xs text-slate-500">Учёт производства</div>
        </div>
        {navList(false)}
        {footer}
      </aside>

      <div className="min-w-0">
        {/* Подразделы производства на мобильных */}
        {isActive(pathname, prod.match) && (
          <div className="lg:hidden flex gap-1 px-4 pt-3 overflow-x-auto print:hidden">
            {prod.children!.map((c) => (
              <NavLink key={c.to} to={c.to} className={clsx('px-3 py-1.5 rounded-full text-sm whitespace-nowrap', isActive(pathname, c.match) ? 'bg-brand-600 text-white' : 'bg-white text-slate-600')}>{c.label}</NavLink>
            ))}
          </div>
        )}
        <main className="px-3 sm:px-6 lg:px-8 py-4 lg:py-7 max-w-[1400px] print:p-0 print:max-w-none">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

// Заголовок страницы: название, подсказка, действия справа
export function PageHeader({ title, hint, children }: { title: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5 print:hidden">
      <div className="min-w-0">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{title}</h1>
        {hint && <p className="text-sm text-slate-500 mt-1 max-w-3xl">{hint}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2 w-full sm:w-auto">{children}</div>}
    </div>
  );
}

// Блок страницы с заголовком и подсказкой
export function Section({ title, hint, children, right }: { title: string; hint?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-slate-200">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-3 border-b border-slate-100">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {hint && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}
        </div>
        {right}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}
