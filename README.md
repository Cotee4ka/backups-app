# Backups App

Совместная работа над проектами с облачным бекапом и историей версий через Git.

Состоит из трёх компонентов:

- **`apps/client-desktop`** — десктоп-клиент на Electron + React (Windows и macOS)
- **`apps/server`** — Node.js сервер для Ubuntu VPS (запускается в Docker)
- **`packages/shared`** — общие TypeScript-типы и протокол

## Как это работает

1. Пользователь регистрирует локальный аккаунт в клиенте (защищает локальное хранилище кредов через Electron `safeStorage`).
2. Создаёт VPS-сервер: вводит IP, SSH-логин/пароль — клиент по SSH ставит Docker и поднимает образ серверного приложения.
3. Сервер возвращает admin-токен и **fingerprint TLS-сертификата** (pinning, защита от MITM).
4. Пользователь создаёт проект — сервер выделяет bare git-репозиторий. Клиент клонирует его в выбранную папку.
5. `chokidar` следит за папкой с **жёстким ignore-листом** (`node_modules`, `.git`, `dist`, `.next`, …).
   Изменения батчуются (idle-debounce 10 сек / таймер 2 мин / кнопка «Сохранить») и пушатся как один git-коммит.
6. Сервер шлёт через WebSocket сигнал `repo:updated` остальным клиентам — те делают `git pull --ff-only`.
7. Бекапы = git-коммиты. Откат на любую версию из UI.

WebSocket — **только сигналинг**. Содержимое файлов передаётся стандартным `git push/pull` по HTTPS (с JWT-авторизацией).

## Стек

- **Клиент:** Electron 30, React 18, Vite, TypeScript, TailwindCSS + shadcn/ui, Zustand, chokidar, simple-git, ssh2, ws, electron-store, auto-launch.
- **Сервер:** Node.js 20, Fastify, ws, simple-git, node-git-server (smart-http git host), better-sqlite3, argon2, jsonwebtoken.
- **Сборка:** pnpm workspaces, electron-builder (.exe NSIS / .dmg), Docker для серверной части.

## Быстрый старт

```bash
# Установить зависимости (pnpm 9+)
pnpm install

# Запуск сервера локально (для разработки клиента)
pnpm dev:server

# Запуск клиента в dev-режиме
pnpm dev:client
```

Сборка релиза:

```bash
pnpm build
pnpm --filter @backups-app/client-desktop dist:win   # NSIS .exe
pnpm --filter @backups-app/client-desktop dist:mac   # DMG
```

Сервер собирается в Docker-образ:

```bash
cd apps/server
docker build -t backups-app-server .
docker compose up -d
```

## Развёртывание на VPS

См. [`apps/server/scripts/install.sh`](apps/server/scripts/install.sh). Клиент запускает его автоматически по SSH из мастера «Создать сервер».

## Структура

```
backups-app/
├── apps/
│   ├── client-desktop/    # Electron + React (Windows/macOS клиент)
│   └── server/            # Node.js сервер для VPS (Docker)
├── packages/
│   └── shared/            # Общие типы и протокол
├── package.json           # pnpm workspace root
└── pnpm-workspace.yaml
```

## Безопасность

- TLS сертификат-pinning по SHA-256 fingerprint (без глобального отключения проверки).
- SSH-пароли пользователя не сохраняются (используются только для bootstrap).
- Креды серверов шифруются Electron `safeStorage`.
- Пароли хешируются `argon2id`.
- JWT 15 мин + refresh 7 дней. Rate-limiting на login.

## Лицензия

MIT
