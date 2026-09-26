#!/usr/bin/env bash
# Выпуск/расширение сертификата portal.helmitex.ru. В сертификат попадают только имена,
# которые уже резолвятся на этот сервер (иначе Let's Encrypt откажет во всём запросе).
# Перезапускать после переноса DNS helmitex.ru — сертификат расширится (--expand).
set -euo pipefail
cd /portal_helmitex
SERVER_IP=200.165.239.159
EMAIL=admin@helmitex.ru

domains=()
for d in portal.helmitex.ru www.helmitex.ru helmitex.ru; do
  if getent ahostsv4 "$d" | awk '{print $1}' | grep -qx "$SERVER_IP"; then
    domains+=(-d "$d")
  else
    echo "skip $d: DNS не указывает на $SERVER_IP"
  fi
done

docker run --rm \
  -v /portal_helmitex/data/certbot/conf:/etc/letsencrypt \
  -v /portal_helmitex/data/certbot/www:/var/www/certbot \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  --cert-name portal.helmitex.ru --expand --non-interactive --agree-tos -m "$EMAIL" \
  "${domains[@]}"

if docker compose ps --status running nginx | grep -q nginx; then
  docker compose exec -T nginx nginx -s reload
fi
