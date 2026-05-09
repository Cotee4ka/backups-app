#!/usr/bin/env bash
# Backups App — Mode 1 (Projects). Установщик для двухсторонней
# git-синхронизации проектов на VPS Ubuntu.
#
# ДВА РЕЖИМА В ЭТОМ РЕПОЗИТОРИИ — внимание, не путать:
#   * install-projects.sh (этот файл) — Mode 1: ТОЛЬКО двухсторонняя
#     git-синхронизация. БЕЗ монтирования хостовой ФС в контейнер.
#     Используется визардом «Создать сервер».
#   * install-v2.sh — Mode 2: read-only mirror с проды через монтирование
#     / -> /host:ro в контейнер. Используется визардом «Подключиться к проде».
#   * install.sh — legacy v1 для Mode 2 (без --check/--apply, без авто-апдейтов).
#
# Особенности:
#   * Идемпотентный — гонится сколько угодно раз, состояние сходится.
#   * Знает свою версию и пишет её в /opt/backups-app/install-version.txt.
#   * Не перезатирает существующие креды в .env при апдейте — читает
#     ADMIN_USER/ADMIN_PASS/JWT_SECRET и сохраняет их.
#   * Два режима вызова: --check и --apply. BACKUPS_PHASE-маркеры в stderr,
#     BACKUPS_INSTALL_RESULT в stdout.
#
# Целевая ОС: Ubuntu 20.04+ (Debian тоже должен работать).
#
# Использование:
#   sudo bash install-projects.sh --check
#   sudo bash install-projects.sh --apply --target-version 0.4.0 \
#     --image ghcr.io/cotee4ka/backups-app-server:0.4.0 \
#     --port 8443 --admin-user owner

set -euo pipefail

INSTALL_SCRIPT_VERSION="0.4.2"
INSTALL_MODE="projects"

# --- defaults ---
MODE=""
PORT=8443
PUBLIC_URL=""
ADMIN_USER=""
TARGET_VERSION=""
IMAGE="${BACKUPS_IMAGE:-ghcr.io/cotee4ka/backups-app-server:latest}"
INSTALL_DIR="/opt/backups-app"
SOURCE_DIR=""
# Mode 1 = НЕ монтируем хостовую ФС. (Если очень надо — можно дать
# --host-mount явно, но по умолчанию выключено.)
HOST_MOUNT=""

# --- helpers ---
phase() { printf 'BACKUPS_PHASE=%s\n' "$1" >&2; }
log()   { printf '[install-projects] %s\n' "$*" >&2; }
die()   { printf '[install-projects][error] %s\n' "$*" >&2; exit 1; }

# JSON-escape a string (только базовые экранирования для наших значений)
jsonesc() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g'
}

# --- parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check"; shift 1 ;;
    --apply) MODE="apply"; shift 1 ;;
    --port) PORT="$2"; shift 2 ;;
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --admin-user) ADMIN_USER="$2"; shift 2 ;;
    --target-version) TARGET_VERSION="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --source-dir) SOURCE_DIR="$2"; shift 2 ;;
    --host-mount) HOST_MOUNT="$2"; shift 2 ;;
    --no-host-mount) HOST_MOUNT=""; shift 1 ;;
    --version) echo "$INSTALL_SCRIPT_VERSION"; exit 0 ;;
    *) die "Unknown arg: $1" ;;
  esac
done

if [[ -z "$MODE" ]]; then
  die "Mode required: pass --check or --apply"
fi

# ============================================================
#  CHECK MODE — только инспекция, ничего не меняет.
# ============================================================
if [[ "$MODE" == "check" ]]; then
  installed="false"
  script_version=""
  server_version=""
  image_ref=""
  image_digest=""
  container_running="false"

  if [[ -f "$INSTALL_DIR/install-version.txt" ]]; then
    installed="true"
    script_version=$(tr -d '[:space:]' < "$INSTALL_DIR/install-version.txt" || true)
  fi

  if [[ -f "$INSTALL_DIR/docker-compose.yml" ]]; then
    image_ref=$(grep -E '^[[:space:]]*image:[[:space:]]*' "$INSTALL_DIR/docker-compose.yml" \
      | head -n1 | sed -E 's/^[[:space:]]*image:[[:space:]]*//' | tr -d '"' | tr -d "'" || true)
  fi

  if command -v docker >/dev/null 2>&1; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'backups-app-server'; then
      container_running="true"
      image_digest=$(docker inspect --format='{{.Image}}' backups-app-server 2>/dev/null \
        | sed 's/^sha256://' || true)
      # Попробуем достать версию из самого приложения по локальному порту,
      # без TLS-валидации (мы внутри хоста — это безопасно).
      server_version=$(curl -fsS --max-time 3 -k "https://127.0.0.1:${PORT}/api/version" 2>/dev/null \
        | grep -oE '"version":"[^"]*"' | head -n1 \
        | sed -E 's/.*"version":"([^"]*)".*/\1/' || true)
    fi
  fi

  printf 'BACKUPS_CHECK_RESULT={"installed":%s,"scriptVersion":"%s","serverVersion":"%s","imageRef":"%s","imageDigest":"%s","containerRunning":%s,"installDir":"%s"}\n' \
    "$installed" \
    "$(jsonesc "$script_version")" \
    "$(jsonesc "$server_version")" \
    "$(jsonesc "$image_ref")" \
    "$(jsonesc "$image_digest")" \
    "$container_running" \
    "$(jsonesc "$INSTALL_DIR")"
  exit 0
fi

# ============================================================
#  APPLY MODE — ставит/апдейтит до целевой версии.
# ============================================================
if [[ "$MODE" != "apply" ]]; then
  die "Unknown mode: $MODE"
fi

if [[ $EUID -ne 0 ]]; then
  die "apply mode requires root (use sudo)"
fi

if [[ -z "$TARGET_VERSION" ]]; then
  TARGET_VERSION="$INSTALL_SCRIPT_VERSION"
fi

# ---------------- step 1: prereqs ----------------
phase "checking-prereqs"
log "target version: $TARGET_VERSION"
log "install dir:    $INSTALL_DIR"
log "image:          $IMAGE"

# ---------------- step 2: docker engine ----------------
phase "installing-docker"
if ! command -v docker >/dev/null 2>&1; then
  log "docker not found, installing via get.docker.com"
  curl -fsSL https://get.docker.com | sh >&2
else
  log "docker already present: $(docker --version 2>&1 | head -n1)"
fi

# ---------------- step 3: docker compose plugin ----------------
phase "installing-compose"
if ! docker compose version >/dev/null 2>&1; then
  log "compose plugin missing, installing"
  apt-get update -y >&2 || true
  apt-get install -y docker-compose-plugin >&2 || true
fi
docker compose version >/dev/null 2>&1 || die "docker compose plugin still not available"

# ---------------- step 4: ufw ----------------
if command -v ufw >/dev/null 2>&1; then
  ufw allow "${PORT}"/tcp >&2 || true
fi

# ---------------- step 5: prepare install dir + .env (preserving creds) ----------------
phase "preparing-dir"
mkdir -p "$INSTALL_DIR"

# Читаем существующие креды, если .env есть. Не перезатираем!
EXISTING_ADMIN_USER=""
EXISTING_ADMIN_PASS=""
EXISTING_JWT_SECRET=""
if [[ -f "$INSTALL_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  EXISTING_ADMIN_USER=$(grep -E '^BACKUPS_ADMIN_USER=' "$INSTALL_DIR/.env" | head -n1 | cut -d= -f2- || true)
  EXISTING_ADMIN_PASS=$(grep -E '^BACKUPS_ADMIN_PASSWORD=' "$INSTALL_DIR/.env" | head -n1 | cut -d= -f2- || true)
  EXISTING_JWT_SECRET=$(grep -E '^BACKUPS_JWT_SECRET=' "$INSTALL_DIR/.env" | head -n1 | cut -d= -f2- || true)
  set +a
fi

if [[ -z "$ADMIN_USER" ]]; then
  if [[ -n "$EXISTING_ADMIN_USER" ]]; then
    ADMIN_USER="$EXISTING_ADMIN_USER"
  else
    ADMIN_USER="owner-$(head -c 4 /dev/urandom | xxd -p)"
  fi
fi

if [[ -n "$EXISTING_ADMIN_PASS" ]]; then
  ADMIN_PASS="$EXISTING_ADMIN_PASS"
else
  ADMIN_PASS=$(openssl rand -base64 24 2>/dev/null || head -c 18 /dev/urandom | base64)
fi

if [[ -n "$EXISTING_JWT_SECRET" ]]; then
  JWT_SECRET="$EXISTING_JWT_SECRET"
else
  JWT_SECRET=$(openssl rand -hex 48 2>/dev/null || head -c 64 /dev/urandom | xxd -p -c 256)
fi

# ---------------- step 6: write config ----------------
phase "writing-config"
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

# Mode 1 worktree-mirror: на хосте создаём /srv/projects и bind-mount'им в
# контейнер по пути /data/worktrees. После каждого push'а пост-receive хук
# обновит соответствующую папку проекта — юзер по SSH сможет `cd /srv/projects`
# и видеть актуальные файлы (не bare git, а реальные сурсы).
mkdir -p /srv/projects
chmod 755 /srv/projects

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
      - /srv/projects:/data/worktrees
$HOST_MOUNT_LINE

volumes:
  backups-data:
EOF

# ---------------- step 7: pull image ----------------
phase "pulling-image"
PULL_OK=0
if docker pull "$IMAGE" >&2; then
  PULL_OK=1
else
  log "pull failed (image may not be in a registry yet)"
  if [[ -n "$SOURCE_DIR" ]] && [[ -f "$SOURCE_DIR/apps/server/Dockerfile" ]]; then
    log "trying local build from source dir: $SOURCE_DIR"
    ( cd "$SOURCE_DIR" && docker build -t "$IMAGE" -f apps/server/Dockerfile . >&2 ) \
      || die "local docker build failed"
    PULL_OK=1
  fi
fi

if [[ "$PULL_OK" != "1" ]]; then
  die "image not pulled and no --source-dir provided"
fi

# ---------------- step 8: start (or restart) container ----------------
phase "starting-container"
( cd "$INSTALL_DIR" && docker compose up -d >&2 )

# ---------------- step 9: wait for TLS fingerprint ----------------
phase "waiting-healthy"
FINGERPRINT=""
for i in $(seq 1 90); do
  if FP=$(docker exec backups-app-server cat /data/certs/fingerprint.txt 2>/dev/null); then
    FINGERPRINT="$FP"
    break
  fi
  sleep 1
done
if [[ -z "$FINGERPRINT" ]]; then
  die "server did not produce TLS fingerprint within 90s; check 'docker logs backups-app-server'"
fi

# ---------------- step 10: detect public URL ----------------
if [[ -z "$PUBLIC_URL" ]]; then
  PUBIP=$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)
  if [[ -z "$PUBIP" ]]; then
    PUBIP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  fi
  if [[ -z "$PUBIP" ]]; then PUBIP="127.0.0.1"; fi
  PUBLIC_URL="https://$PUBIP:$PORT"
fi

# ---------------- step 11: write version marker ----------------
printf '%s\n' "$TARGET_VERSION" > "$INSTALL_DIR/install-version.txt"

# ---------------- step 12: emit result ----------------
phase "done"

JSON_PAYLOAD=$(printf '{"v":2,"url":"%s","fp":"%s","u":"%s","pw":"%s","scriptVersion":"%s"}' \
  "$(jsonesc "$PUBLIC_URL")" \
  "$(jsonesc "$FINGERPRINT")" \
  "$(jsonesc "$ADMIN_USER")" \
  "$(jsonesc "$ADMIN_PASS")" \
  "$(jsonesc "$TARGET_VERSION")")

# Машиночитаемая строка — клиент парсит её как авторитетный результат.
printf 'BACKUPS_INSTALL_RESULT=%s\n' "$JSON_PAYLOAD"

# Pair-токен для ручного режима подключения (mode 1 → «вручную»).
PAIR_TOKEN=$(printf '%s' "$JSON_PAYLOAD" | base64 -w0 | tr '+/' '-_' | tr -d '=')

cat >&2 <<MSG

==================================================================
  Backups App сервер v$TARGET_VERSION готов

  URL:           $PUBLIC_URL
  Логин:         $ADMIN_USER
  Пароль:        $ADMIN_PASS
  TLS отпечаток: $FINGERPRINT

  Pair-токен (для подключения вручную в клиенте):
==================================================================

bap2.$PAIR_TOKEN

==================================================================
  Файлы хоста доступны как /host/... (read-only).
  Чтобы выключить:  cd $INSTALL_DIR && docker compose down
==================================================================
MSG
