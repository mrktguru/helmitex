#!/bin/bash
# Запускать на сервере: bash server_setup.sh
set -e

PROJECT="helmitex_stickers"
DOMAIN="193.108.113.100"
WWW_DIR="/var/www/$PROJECT"
GIT_DIR="/opt/git/$PROJECT.git"
SSH_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAgN6qUCHZav6S3Ng2I5MtzbM5ZD6/Vod4IvZe66DjcL claude-helmitex"

echo "=== [1/6] Обновление системы ==="
apt-get update -q
apt-get install -y -q nginx git curl ufw

echo "=== [2/6] Настройка SSH-ключа ==="
mkdir -p /root/.ssh
chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
# Добавляем ключ если его ещё нет
if ! grep -qF "$SSH_KEY" /root/.ssh/authorized_keys 2>/dev/null; then
    echo "$SSH_KEY" >> /root/.ssh/authorized_keys
    echo "SSH-ключ добавлен"
else
    echo "SSH-ключ уже существует"
fi

echo "=== [3/6] Создание директорий ==="
mkdir -p "$WWW_DIR"
mkdir -p "$GIT_DIR"

echo "=== [4/6] Инициализация bare git-репозитория ==="
git init --bare "$GIT_DIR"

# post-receive hook — деплой при git push
cat > "$GIT_DIR/hooks/post-receive" << 'HOOK'
#!/bin/bash
PROJECT="helmitex_stickers"
WWW_DIR="/var/www/$PROJECT"
GIT_DIR="/opt/git/$PROJECT.git"

while read oldrev newrev ref; do
    branch=$(basename "$ref")
    echo ">>> Push на ветку: $branch"

    if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
        echo ">>> Деплой на $WWW_DIR..."
        git --work-tree="$WWW_DIR" --git-dir="$GIT_DIR" checkout -f "$branch"
        echo ">>> Деплой завершён: $(date)"
    else
        echo ">>> Ветка $branch — деплой пропущен (только main/master)"
    fi
done
HOOK

chmod +x "$GIT_DIR/hooks/post-receive"
echo "Git bare репозиторий: $GIT_DIR"

echo "=== [5/6] Настройка nginx ==="
cat > /etc/nginx/sites-available/$PROJECT << NGINX
server {
    listen 80;
    server_name $DOMAIN _;

    root $WWW_DIR;
    index index.html index.php;

    location / {
        try_files \$uri \$uri/ =404;
    }

    location ~* \.(jpg|jpeg|png|gif|ico|css|js|svg|webp)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    access_log /var/log/nginx/${PROJECT}_access.log;
    error_log  /var/log/nginx/${PROJECT}_error.log;
}
NGINX

ln -sf /etc/nginx/sites-available/$PROJECT /etc/nginx/sites-enabled/$PROJECT
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "nginx настроен"

echo "=== [6/6] Настройка файрвола ==="
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
echo "Файрвол настроен"

echo ""
echo "======================================"
echo "ГОТОВО! Сервер настроен."
echo ""
echo "Git remote для деплоя:"
echo "  git remote add production root@$DOMAIN:$GIT_DIR"
echo ""
echo "Деплой командой:"
echo "  git push production main"
echo "======================================"
