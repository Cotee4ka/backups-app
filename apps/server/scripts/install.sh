#!/usr/bin/env bash
# Backups App — установщик сервера для Linux VPS (Ubuntu/Debian).
#
# Что делает:
#   1. Ставит Docker (если его нет) — официальный get.docker.com.
#   2. Ставит docker compose plugin (если нет).
#   3. Открывает порт через ufw (если ufw активен).
#   4. Пишет docker-compose.yml + .env в /opt/backups-app.
#   5. Подкачивает образ из GitHub Container Registry (ghcr.io).
#   6. Поднимает контейнер. По умолчанию монтирует / -> /host:ro
#      для режима "external project" (read-only зеркало папок VPS).
#   7. Печатает pair-токен — одну строку, которую достаточно вставить
#      в клиент Backups App, чтобы подключить сервер.
#
# Использование:
#   curl -fsSL https://example.com/install.sh | sudo bash
#   # или с параметрами:
#   sudo bash install.sh --image ghcr.io/<user>/backups-app-server:latest \
#                        --port 8443 --no-host-mount

set -euo pipefail

PORT=8443
PUBLIC_URL=""
ADMIN_USER=""
ADMIN_PASS=""
IMAGE="${BACKUPS_IMAGE:-ghcr.io/cotee4ka/backups-app-server:latest}"
INSTALL_DIR="/opt/backups-app"
SOURCE_DIR=""
HOST_MOUNT="/:/host:ro"
PRINT_JSON=0

log() { echo "[install] $*" >&2; }
die() { echo "[install][error] $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --admin-user) ADMIN_USER="$2"; shift 2 ;;
    --admin-pass) ADMIN_PASS="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --source-dir) SOURCE_DIR="$2"; shift 2 ;;
    --host-mount) HOST_MOUNT="$2"; shift 2 ;;
    --no-host-mount) HOST_MOUNT=""; shift 1 ;;
    --json) PRINT_JSON=1; shift 1 ;;
    *) die "Unknown arg: $1" ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  die "This script must be run as root (use sudo)"
fi

if [[ -z "$ADMIN_USER" ]]; then
  ADMIN_USER="owner-$(head -c 4 /dev/urandom | xxd -p)"
fi
if [[ -z "$ADMIN_PASS" ]]; then
  ADMIN_PASS=$(openssl rand -base64 24 2>/dev/null || head -c 18 /dev/urandom | base64)
fi
JWT_SECRET=$(openssl rand -hex 48 2>/dev/null || head -c 64 /dev/urandom | xxd -p -c 256)

log "step 1/5: ensuring Docker is installed"
if ! command -v docker >/dev/null 2>&1; then
  log "  docker not found, installing via get.docker.com"
  curl -fsSL https://get.docker.com | sh >&2
fi
if ! docker compose version >/dev/null 2>&1; then
  log "  installing docker compose plugin"
  apt-get update -y >&2 || true
  apt-get install -y docker-compose-plugin >&2 || true
fi

log "step 2/5: ufw rules"
if command -v ufw >/dev/null 2>&1; then
  ufw allow "$PORT"/tcp || true
fi

log "step 3/5: preparing $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

cat > "$INSTALL_DIR/.env" <<EOF
BACKUPS_PORT=$PORT
BACKUPS_PUBLIC_URL=$PUBLIC_URL
BACKUPS_JWT_SECRET=$JWT_SECRET
BACKUPS_ADMIN_USER=$ADMIN_USER
BACKUPS_ADMIN_PASSWORD=$ADMIN_PASS
EOF
chmod 600 "$INSTALL_DIR/.env"

HOST_MOUNT_LINE=""
if [[ -n "$HOST_MOUNT" ]]; then
  HOST_MOUNT_LINE="      - $HOST_MOUNT"
fi

cat > "$INSTALL_DIR/docker-compose.yml" <<EOF
services:
  backups-app-server:
    image: $IMAGE
    container_name: backups-app-server
    restart: unless-stopped
    env_file: .env
    environment:
      - BACKUPS_HOST=0.0.0.0
      - BACKUPS_TLS=true
      - BACKUPS_DATA_DIR=/data
    ports:
      - "$PORT:8443"
    volumes:
      - backups-data:/data
$HOST_MOUNT_LINE

  watchtower:
    image: containrrr/watchtower
    container_name: backups-watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WATCHTOWER_POLL_INTERVAL=3600
      - WATCHTOWER_CLEANUP=true
      - WATCHTOWER_INCLUDE_STOPPED=false
    command: backups-app-server

volumes:
  backups-data:
EOF

log "step 4/5: pulling image $IMAGE"
if ! docker pull "$IMAGE" >&2; then
  log "  pull failed (image may not be in a registry yet)"
  if [[ -n "$SOURCE_DIR" ]] && [[ -f "$SOURCE_DIR/apps/server/Dockerfile" ]]; then
    log "  trying local build from source dir: $SOURCE_DIR"
    ( cd "$SOURCE_DIR" && docker build -t "$IMAGE" -f apps/server/Dockerfile . >&2 ) || die "local docker build failed"
  else
    die "image not pulled and no --source-dir provided"
  fi
fi

log "step 5/5: docker compose up -d"
( cd "$INSTALL_DIR" && docker compose up -d >&2 )

log "waiting for server to become healthy..."
FINGERPRINT=""
for i in $(seq 1 60); do
  if FP=$(docker exec backups-app-server cat /data/certs/fingerprint.txt 2>/dev/null); then
    FINGERPRINT="$FP"
    break
  fi
  sleep 1
done

if [[ -z "$FINGERPRINT" ]]; then
  die "server did not produce TLS fingerprint within 60s; check 'docker logs backups-app-server'"
fi

# Detect public IP if PUBLIC_URL not provided
if [[ -z "$PUBLIC_URL" ]]; then
  PUBIP=$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)
  if [[ -z "$PUBIP" ]]; then
    PUBIP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  fi
  if [[ -z "$PUBIP" ]]; then PUBIP="127.0.0.1"; fi
  PUBLIC_URL="https://$PUBIP:$PORT"
fi

# Build pair-token = base64( JSON{ v, url, fp, u, pw } )
JSON_PAYLOAD=$(printf '{"v":1,"url":"%s","fp":"%s","u":"%s","pw":"%s"}' \
  "$PUBLIC_URL" "$FINGERPRINT" "$ADMIN_USER" "$ADMIN_PASS")

# url-safe base64 (no padding) so token не ломается при копировании
PAIR_TOKEN=$(printf '%s' "$JSON_PAYLOAD" | base64 -w0 | tr '+/' '-_' | tr -d '=')

if [[ "$PRINT_JSON" == "1" ]]; then
  printf '\nBACKUPS_INSTALL_RESULT=%s\n' "$JSON_PAYLOAD"
fi

cat >&2 <<MSG

==================================================================
  ✅ Backups App сервер поднят

  URL:       $PUBLIC_URL
  Логин:     $ADMIN_USER
  Пароль:    $ADMIN_PASS
  TLS отпечаток: $FINGERPRINT

  Скопируй вот эту строку (pair-токен) и вставь в клиент:
==================================================================

bap1.$PAIR_TOKEN

==================================================================
  В клиенте: «Подключить сервер» → «Вставить pair-токен» →
  вставить строку выше → готово.

  Файлы хоста доступны как /host/... (read-only).
  Чтобы выключить: cd $INSTALL_DIR && docker compose down
==================================================================
MSG
