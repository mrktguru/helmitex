#!/usr/bin/env bash
# Дамп БД портала в /portal_helmitex/backups (хранятся последние 14).
set -euo pipefail
cd /portal_helmitex
mkdir -p backups
set -a; . ./.env; set +a
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" \
  > "backups/labelstudio-$(date +%Y%m%d-%H%M%S).dump"
ls -1t backups/labelstudio-*.dump | tail -n +15 | xargs -r rm --
