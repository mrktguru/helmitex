import { Navigate, useLocation } from 'react-router-dom';

// Перенаправление со старого адреса; keepQuery — дописать текущие параметры (?lotId=…)
export default function Redirect({ to, keepQuery }: { to: string; keepQuery?: boolean }) {
  const { search } = useLocation();
  const extra = keepQuery && search ? (to.includes('?') ? '&' : '?') + search.slice(1) : '';
  return <Navigate to={to + extra} replace />;
}
