# Деплой на сервер 193.108.113.100

## Шаг 1: Подключитесь к серверу с вашего компьютера

```bash
ssh root@193.108.113.100
# пароль: ixu2DIISSi
```

## Шаг 2: Запустите скрипт настройки

Скопируйте и запустите на сервере:

```bash
curl -fsSL https://raw.githubusercontent.com/... > /tmp/setup.sh
# ИЛИ вручную создайте файл и вставьте содержимое server_setup.sh
bash /tmp/server_setup.sh
```

**Или скопируйте скрипт через scp:**

```bash
scp deploy/server_setup.sh root@193.108.113.100:/tmp/
ssh root@193.108.113.100 "bash /tmp/server_setup.sh"
```

## Шаг 3: Добавьте production remote в git

После успешного запуска скрипта, выполните локально:

```bash
git remote add production root@193.108.113.100:/opt/git/helmitex_stickers.git
```

## Шаг 4: Деплой на сервер

```bash
git push production main
```

## SSH-ключ (уже добавлен скриптом)

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAgN6qUCHZav6S3Ng2I5MtzbM5ZD6/Vod4IvZe66DjcL claude-helmitex
```

## Структура на сервере

```
/var/www/helmitex_stickers/   — файлы сайта (www-root)
/opt/git/helmitex_stickers.git/ — bare git репозиторий
/etc/nginx/sites-available/helmitex_stickers — конфиг nginx
```
