# Деплой portal.helmitex.ru

Сервер: **200.165.239.159** (helmitex-tbcloud, Ubuntu 24.04), ssh-алиас `helmitex-tbcloud` (ключ `~/.ssh/Helmitex_TBcloud`).
Всё хозяйство портала — в `/portal_helmitex`, отдельный docker compose-проект `portal_helmitex`.

## Как устроено

```
интернет :80/:443
   └─ /edge (edge-nginx, общий для всех сайтов на IP; :443 — SNI passthrough, :80 — по Host)
        └─ 127.0.0.1:7080 / 7443 → portal_helmitex-nginx (TLS, статика фронта, /api → api:3100)
                                        ├─ portal_helmitex-api       (node dist/index.js)
                                        ├─ portal_helmitex-worker    (node dist/workers/pdfGenerator.js)
                                        ├─ portal_helmitex-postgres  (./data/postgres)
                                        ├─ portal_helmitex-redis     (./data/redis, AOF)
                                        └─ portal_helmitex-minio     (./data/minio)
```

С соседями (enckellpaints, mrktguru) портал не делит ни сеть, ни БД, ни сертификаты.
Единственная общая точка — по строке на каждый домен в двух `map` в `/edge/nginx.conf`.

```
/portal_helmitex/
  docker-compose.yml, .env (chmod 600, только на сервере)
  app/backend/          — исходники бэкенда (образ собирается на сервере из Dockerfile)
  app/frontend/dist/    — собранный фронт
  nginx/conf.d/portal.conf  (+ nginx/portal.conf, nginx/bootstrap.conf — шаблоны)
  data/{postgres,redis,minio,certbot}
  scripts/  certbot-issue.sh, certbot-renew.sh, backup.sh
  backups/  дампы БД (последние 14)
```

Файлы, кроме `app/` и `.env`, лежат в репозитории в `deploy/portal_helmitex/`.

## Деплой

```bash
# Бэкенд
rsync -az --delete --exclude node_modules --exclude dist --exclude .env \
  backend/ helmitex-tbcloud:/portal_helmitex/app/backend/
ssh helmitex-tbcloud "cd /portal_helmitex && docker compose up -d --build api worker"

# Фронтенд
cd frontend && npm run build
rsync -az --delete dist/ helmitex-tbcloud:/portal_helmitex/app/frontend/dist/

# Инфраструктурные файлы (compose, nginx, скрипты)
rsync -az deploy/portal_helmitex/ helmitex-tbcloud:/portal_helmitex/ --exclude .env.example
ssh helmitex-tbcloud "cd /portal_helmitex && cp nginx/portal.conf nginx/conf.d/portal.conf && docker compose up -d && docker compose exec nginx nginx -s reload"
```

## Полезное

```bash
ssh helmitex-tbcloud
cd /portal_helmitex
docker compose ps
docker compose logs -f api worker
docker compose exec postgres psql -U labelstudio labelstudio
```

## TLS

Сертификат Let's Encrypt `portal.helmitex.ru` (SAN: portal.helmitex.ru, helmitex.ru, www.helmitex.ru), webroot через nginx портала.

- Продление: `portal-helmitex-certbot.timer` (дважды в сутки) → `scripts/certbot-renew.sh` (renew + reload nginx).
  Проверка: `systemctl list-timers | grep portal`, `journalctl -u portal-helmitex-certbot`.
- Добавить/убрать домен: поправить список в `scripts/certbot-issue.sh` и запустить его (`--expand`).
  Скрипт берёт только имена, которые уже резолвятся на 200.165.239.159.
- Ручное продление: `/portal_helmitex/scripts/certbot-renew.sh`.

## Бэкапы

`portal-helmitex-backup.timer` ежедневно в 02:30 UTC делает `pg_dump` в `/portal_helmitex/backups` (хранятся последние 14).
Данные MinIO (`data/minio`) в бэкап не входят.

## Производительность генерации

Замеры на 340 этикетках (2 vCPU):
- свежий PDF с кодами ЧЗ, кэша нет: ~70 с в сумме (подготовка кодов ~22 с, сборка страниц ~17 с, сохранение PDF ~25 с);
- те же коды повторно: ~45 с (подготовка кодов ~5 с).
После загрузки PDF воркер в фоне (задание `warm-cz-cache` в очереди `pdf-generation`) распознаёт все страницы: ~25 с на 340 страниц. Если оператор нажмёт «Сгенерировать» раньше, генерация не дублирует работу, а ждёт уже идущие страницы. Тогда генерация после прогрева занимает ~40 с.
До оптимизации первая генерация занимала ~4 мин. Сейчас основное время уходит на сборку и сохранение PDF (pdf-lib).
- Распознавание DataMatrix идёт через пул постоянных Python-процессов (`services/datamatrix.ts`, размер пула = число ядер, переопределяется `DECODER_POOL_SIZE`).
- Страницы PDF рендерятся Ghostscript диапазонами по 20 страниц за запуск; одновременно не больше `GS_CONCURRENCY` (по умолчанию 2) процессов на весь воркер.
- Переменные необязательные, задаются в `.env`.

## Образ MinIO

MinIO больше не публикует образы на Docker Hub. Используемый образ `minio/minio:RELEASE.2025-09-07T16-13-09Z`
загружен на сервер вручную (`docker save | docker load`), не удаляйте его через `docker image prune -a`.

## Первичная установка с нуля (для справки)

1. Создать папки, скопировать `deploy/portal_helmitex/`, `backend/` → `app/backend`, `frontend/dist` → `app/frontend/dist`, заполнить `.env` по `.env.example`.
2. `cp nginx/bootstrap.conf nginx/conf.d/portal.conf && docker compose up -d --build`.
3. Добавить домены в обе `map` `/edge/nginx.conf` → `127.0.0.1:7443` / `127.0.0.1:7080`, `docker exec edge-nginx nginx -s reload`.
4. `scripts/certbot-issue.sh`, затем `cp nginx/portal.conf nginx/conf.d/portal.conf` и reload nginx.
5. `cp systemd/* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now portal-helmitex-certbot.timer portal-helmitex-backup.timer`.
