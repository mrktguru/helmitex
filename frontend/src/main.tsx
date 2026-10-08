import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';
import Login from './pages/Login';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import Editor from './pages/Editor';
import Admin from './pages/Admin';
import StockLayout from './pages/stock/StockLayout';
import StockBalances from './pages/stock/StockBalances';
import StockItems from './pages/stock/StockItems';
import StockDocs from './pages/stock/StockDocs';
import StockDocEdit from './pages/stock/StockDocEdit';
import StockMoves from './pages/stock/StockMoves';
import StockRecipes from './pages/stock/StockRecipes';
import StockMixEdit from './pages/stock/StockMixEdit';
import StockFillEdit from './pages/stock/StockFillEdit';
import StockSkus from './pages/stock/StockSkus';
import StockQuantTypes from './pages/stock/StockQuantTypes';
import StockQuants from './pages/stock/StockQuants';
import StockQuantAssemble from './pages/stock/StockQuantAssemble';
import StockQuantDoc from './pages/stock/StockQuantDoc';
import StockQuantDetail from './pages/stock/StockQuantDetail';
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
          <Route path="/stock" element={<StockLayout />}>
            <Route index element={<StockBalances />} />
            <Route path="items" element={<StockItems />} />
            <Route path="docs" element={<StockDocs />} />
            <Route path="docs/new" element={<StockDocEdit />} />
            <Route path="docs/:id" element={<StockDocEdit />} />
            <Route path="moves" element={<StockMoves />} />
            <Route path="recipes" element={<StockRecipes />} />
            <Route path="mixes" element={<StockDocs fixedType="MIX" />} />
            <Route path="mix/new" element={<StockMixEdit />} />
            <Route path="mix/:id" element={<StockMixEdit />} />
            <Route path="fills" element={<StockDocs fixedType="FILL" />} />
            <Route path="fill/new" element={<StockFillEdit />} />
            <Route path="fill/:id" element={<StockFillEdit />} />
            <Route path="skus" element={<StockSkus />} />
            <Route path="quant-types" element={<StockQuantTypes />} />
            <Route path="quants" element={<StockQuants />} />
            <Route path="quants/:id" element={<StockQuantDetail />} />
            <Route path="quant/new" element={<StockQuantAssemble />} />
            <Route path="quant/:id" element={<StockQuantDoc />} />
          </Route>
        </Route>
        <Route element={<AdminRoute />}>
          <Route path="/admin" element={<Admin />} />
        </Route>
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
