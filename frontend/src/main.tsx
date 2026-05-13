import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';
import Login from './pages/Login';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import Editor from './pages/Editor';
import Admin from './pages/Admin';
import { PrivateRoute } from './components/PrivateRoute';
import { AdminRoute } from './components/AdminRoute';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<PrivateRoute />}>
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/projects/:id/editor" element={<Editor />} />
        </Route>
        <Route element={<AdminRoute />}>
          <Route path="/admin" element={<Admin />} />
        </Route>
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
