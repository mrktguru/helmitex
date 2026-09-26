# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mandatory: Git + Deploy After Every Code Change

Every code change **must** be committed and deployed immediately.

### 1. Commit and push

```bash
git add -A
git commit -m "описание изменений"
git push origin main
```

### 2. Deploy backend changes

```bash
rsync -az --delete --exclude node_modules --exclude dist --exclude .env \
  backend/ helmitex-tbcloud:/portal_helmitex/app/backend/
ssh helmitex-tbcloud "cd /portal_helmitex && docker compose up -d --build api worker"
```

### 3. Deploy frontend changes

```bash
cd frontend && npm run build
rsync -az --delete dist/ helmitex-tbcloud:/portal_helmitex/app/frontend/dist/
```

The site is live at **https://portal.helmitex.ru** (shared `/edge` router → portal nginx on 127.0.0.1:7443 → static dist + api container on 3100). Full details: `deploy/README_DEPLOY.md`.

## Architecture

**Monorepo** with two separate apps:

```
backend/   — Express + TypeScript API (port 3100 on server)
frontend/  — React + Vite SPA (static, served from /helmitex/frontend/dist)
deploy/    — server_setup.sh и README_DEPLOY.md
docker-compose.yml — local dev infra only (Postgres, Redis, MinIO)
```

### Backend (`backend/src/`)

Express API with JWT cookie auth. All routes require `authMiddleware` except `/api/health` and `/api/auth`.

- **`routes/auth.ts`** — login/logout/refresh, argon2 password hashing, two JWT cookies (access 15 min, refresh 7 days)
- **`routes/projects.ts`** — CRUD for projects (each project belongs to one user)
- **`routes/templates.ts`** — label template CRUD; template stores `elements[]` + `czArea` + `variables`/`variableDefs` as JSON in Postgres
- **`routes/cz.ts`** — upload Честный знак source: either PDF (pages decoded to DataMatrix via Ghostscript+pdf2pic) or CSV (codes stored directly); deduplication via SHA-256 file hash; codes stored as `CzCode` records with status PENDING
- **`routes/batches.ts`** — create output batch (N pending codes → `OutputBatch`, codes marked USED, PDF job enqueued); download generated PDF; delete batch (rolls codes back to PENDING)
- **`workers/pdfGenerator.ts`** — BullMQ worker (concurrency 4); for each code: fetch DataMatrix PNG, render all template elements onto pdf-lib page, embed DataMatrix in czArea with letterboxing; upload final PDF to S3
- **`services/pdf.ts`** — converts CZ PDF pages to PNG at 450 DPI via pdf2pic, trims whitespace, pads to square
- **`services/czRender.ts`** — CZ PNG cache/pipeline
- **`services/datamatrix.ts`** — re-encodes code string as DataMatrix PNG (for CSV-sourced codes)
- **`services/barcode.ts`** — EAN-13 vector rendering (drawEan13Vector → pdf-lib rectangles + text)
- **`services/s3.ts`** — S3/MinIO wrappers

**Key PDF WYSIWYG trick:** the browser pre-computes `_wrappedLines` and `_resolvedFontSizePt` on every template save. The PDF worker uses these cached values directly instead of re-computing text layout, so browser and PDF output match exactly.

### Frontend (`frontend/src/`)

React 18 + Zustand + React Router + Tailwind, no Redux.

- **`store/useEditorStore.ts`** — all editor state: elements, czArea, dimensions, variables, undo/redo history (`past[]`/`future[]` stacks using `structuredClone`)
- **`store/useAuthStore.ts`** — user session state
- **`pages/Editor.tsx`** — visual label editor: HTML5 Canvas for rendering (scale 3.7795×3 px/mm), drag-resize elements, snap to 0.5 mm grid, `browserWrapText` for WYSIWYG text wrapping
- **`pages/ProjectDetail.tsx`** — batch management: upload CZ source (PDF or CSV), set batch size, trigger PDF generation, poll job status, download
- **`pages/Projects.tsx`** / **`pages/Admin.tsx`** — project list, user management (ADMIN only)
- **`api/client.ts`** — axios instance with base URL + credential cookies
- **`lib/variables.ts`** — `{{token}}` substitution in text elements
- **`lib/wrap.ts`** — `precomputeWraps()` called on template save to populate `_wrappedLines`

### Element types

`text` | `barcode` (EAN-13) | `image` (S3-stored) | `rect` | `eac` (EAC mark SVG) | `variable` (dynamic text from template variables)

### Data model (Prisma / PostgreSQL)

`User` → `Project` → `LabelTemplate` (one per project, stores elements as JSON)
`Project` → `CzBatch[]` → `CzCode[]` (PENDING → USED lifecycle)
`Project` → `OutputBatch[]` (generated PDFs, status: pending → processing → done | error)

## Local Development

```bash
# Start infra (Postgres, Redis, MinIO)
docker-compose up -d

# Backend
cd backend
cp .env.example .env   # edit DATABASE_URL, JWT_SECRET etc.
npm install
npm run prisma:migrate
npm run dev            # API on :3000
npm run worker         # PDF worker (separate terminal)

# Frontend
cd frontend
npm install
npm run dev            # Vite dev server on :5173
```

## Production Server

- **IP:** `200.165.239.159` (helmitex-tbcloud), SSH alias `helmitex-tbcloud` (key `~/.ssh/Helmitex_TBcloud`)
- **Path:** `/portal_helmitex` — standalone docker compose project `portal_helmitex` (postgres, redis, minio, api, worker, nginx); config in repo at `deploy/portal_helmitex/`
- **Routing:** shared `/edge` nginx (80/443, SNI passthrough) → portal nginx on `127.0.0.1:7080/7443`. Don't touch neighbour projects (`/mrktguru`, `/opt/enckellpaints`)
- **TLS:** own certbot data in `data/certbot`, renewed by `portal-helmitex-certbot.timer`
- **Backups:** `portal-helmitex-backup.timer` → `/portal_helmitex/backups`

### Useful server commands

```bash
ssh helmitex-tbcloud
cd /portal_helmitex
docker compose ps
docker compose logs -f api worker
systemctl list-timers | grep portal
```

## Backend env vars

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | Token signing |
| `REDIS_URL` | BullMQ queue connection |
| `S3_BUCKET` / `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | MinIO/S3 |
| `FRONTEND_URL` | CORS allowed origin |
| `PORT` | API listen port (3100 on server) |
