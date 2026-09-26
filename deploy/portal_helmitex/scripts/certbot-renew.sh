#!/usr/bin/env bash
# Продление сертификата portal.helmitex.ru. Запускается portal-helmitex-certbot.timer дважды в сутки.
set -euo pipefail
cd /portal_helmitex
docker run --rm \
  -v /portal_helmitex/data/certbot/conf:/etc/letsencrypt \
  -v /portal_helmitex/data/certbot/www:/var/www/certbot \
  certbot/certbot renew --webroot -w /var/www/certbot --quiet
docker compose exec -T nginx nginx -s reload
