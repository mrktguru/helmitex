import React, { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';

export function PrivateRoute() {
  const token = useAuthStore((s) => s.accessToken);
  return token ? <Outlet /> : <Navigate to="/login" replace />;
}
