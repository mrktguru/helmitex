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
import StockHome from './pages/stock/StockHome';
import StockWarehouse from './pages/stock/StockWarehouse';
import StockCatalog from './pages/stock/StockCatalog';
import StockItemCard from './pages/stock/StockItemCard';
import Redirect from './components/Redirect';
import StockDocs from './pages/stock/StockDocs';
import StockDocEdit from './pages/stock/StockDocEdit';
import StockMixEdit from './pages/stock/StockMixEdit';
import StockFillEdit from './pages/stock/StockFillEdit';
import StockQuants from './pages/stock/StockQuants';
import StockQuantAssemble from './pages/stock/StockQuantAssemble';
import StockQuantDoc from './pages/stock/StockQuantDoc';
import StockQuantDetail from './pages/stock/StockQuantDetail';
import StockFboList from './pages/stock/StockFboList';
import StockFbo from './pages/stock/StockFbo';
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
            <Route index element={<StockHome />} />
            <Route path="warehouse" element={<StockWarehouse />} />
            <Route path="docs/new" element={<StockDocEdit />} />
            <Route path="docs/:id" element={<StockDocEdit />} />
            <Route path="mixes" element={<StockDocs fixedType="MIX" title="Замесы" hint="Сырьё по рецептуре → бочка полуфабриката. Карта замеса печатается для оператора, факт вносится с неё." />} />
            <Route path="mix/new" element={<StockMixEdit />} />
            <Route path="mix/:id" element={<StockMixEdit />} />
            <Route path="fills" element={<StockDocs fixedType="FILL" title="Фасовка" hint="Бочка → тубы, вёдра, банки. Списываются полуфабрикат, тара и этикетки; появляется партия «без ЧЗ»." />} />
            <Route path="fill/new" element={<StockFillEdit />} />
            <Route path="fill/:id" element={<StockFillEdit />} />
            <Route path="quants" element={<StockQuants />} />
            <Route path="quants/:id" element={<StockQuantDetail />} />
            <Route path="quant/new" element={<StockQuantAssemble />} />
            <Route path="quant/:id" element={<StockQuantDoc />} />
            <Route path="fbo" element={<StockFboList />} />
            <Route path="fbo/:id" element={<StockFbo />} />
            <Route path="catalog" element={<StockCatalog />} />
            <Route path="catalog/:id" element={<StockItemCard />} />
            {/* Старые адреса */}
            <Route path="docs" element={<Redirect to="/stock/warehouse?tab=docs" />} />
            <Route path="moves" element={<Redirect to="/stock/warehouse?tab=moves" keepQuery />} />
            <Route path="items" element={<Redirect to="/stock/catalog" />} />
            <Route path="recipes" element={<Redirect to="/stock/catalog?type=SEMI" />} />
            <Route path="skus" element={<Redirect to="/stock/catalog?type=PRODUCT" />} />
            <Route path="quant-types" element={<Redirect to="/stock/catalog?type=PRODUCT" />} />
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
