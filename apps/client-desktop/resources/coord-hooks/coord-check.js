#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * PreToolUse hook для Edit | Write | MultiEdit | NotebookEdit.
 *
 * Сценарий:
 *   1. Получает payload (cwd, tool, file_path).
 *   2. Ищет .backupsapp.json вверх по дереву от cwd. Нет → exit 0
 *      (мы не в синкаемом проекте, не вмешиваемся).
 *   3. Читает ~/.backups-app/credentials.json для соответствующего сервера.
 *   4. Дёргает GET /api/projects/<id>/lock:
 *        - lock null  → POST /lock acquire (reason: "claude editing X.ts")
 *                       → exit 0.
 *        - holder=я   → POST /lock/heartbeat (currentlyEditing+=path)
 *                       → exit 0.
 *        - holder!=я  → exit 2 + сообщение «Project locked by ...» —
 *                       Claude увидит и не сможет править.
 *
 * Любая ошибка инфраструктуры (нет сети, нет токена, сервер не отвечает)
 * → exit 0, чтобы не мешать работе. Лок — это «полезный сигнал», не
 * критическая защита.
 */

const path = require('node:path');
const {
  readStdin,
  findProjectConfig,
  readServerCreds,
  apiRequest,
} = require('./common.js');

(async () => {
  try {
    const payload = await readStdin();
    const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const tool = payload.tool_name || payload.toolName || '';
    const input = payload.tool_input || payload.toolInput || {};
    const filePath =
      input.file_path || input.filePath || input.notebook_path || '';

    const cfg = findProjectConfig(cwd);
    if (!cfg || !cfg.serverId || !cfg.projectId) {
      // Не в синкаемом проекте — хук не вмешивается.
      process.exit(0);
    }

    const server = readServerCreds(cfg.serverId);
    if (!server) {
      // Нет кредов — Electron не запущен или юзер вышел. Пропускаем.
      process.exit(0);
    }

    // Имя файла относительно проекта — для красивого reason.
    let relPath = filePath;
    if (filePath && cfg.projectDir) {
      try {
        const rel = path.relative(cfg.projectDir, filePath);
        if (rel && !rel.startsWith('..')) {
          relPath = rel.replace(/\\/g, '/');
        }
      } catch {
        /* keep absolute */
      }
    }

    // 1. GET /lock — узнаём состояние.
    const get = await apiRequest(server, 'GET', `/api/projects/${encodeURIComponent(cfg.projectId)}/lock`).catch(
      () => null,
    );
    if (!get || get.status >= 500) {
      process.exit(0);
    }

    const myUserId = (server.userId ?? '') || (server.username ?? '');
    const lockState = get.body && get.body.lock;

    // Если в payload пришёл username из подключенного сервера, используем его
    // (Electron-store записывает по нему userId). Уточняем по holderUsername.
    const meIsHolder =
      lockState &&
      (lockState.holderUserId === myUserId ||
        lockState.holderUsername === server.username);

    const reason = `${tool} ${relPath || '(unknown file)'}`.slice(0, 280);

    if (!lockState) {
      // 2a. Свободен — берём.
      const acquired = await apiRequest(
        server,
        'POST',
        `/api/projects/${encodeURIComponent(cfg.projectId)}/lock`,
        { reason, ttlSec: 900 },
      ).catch(() => null);
      if (!acquired || acquired.status >= 500) process.exit(0);
      // 409 (кто-то перехватил между GET и POST) — рекурсивно перепроверим.
      if (acquired.status === 409) {
        const nowState = acquired.body && acquired.body.lock;
        if (
          nowState &&
          nowState.holderUsername !== server.username &&
          nowState.holderUserId !== myUserId
        ) {
          blockEdit(nowState);
        }
        process.exit(0);
      }
      process.exit(0);
    }

    if (meIsHolder) {
      // 2b. Я держу — heartbeat'им и обновляем currentlyEditing.
      const currentlyEditing = Array.isArray(lockState.currentlyEditing)
        ? lockState.currentlyEditing.slice(0, 50)
        : [];
      if (relPath && !currentlyEditing.includes(relPath)) {
        currentlyEditing.push(relPath);
      }
      await apiRequest(
        server,
        'POST',
        `/api/projects/${encodeURIComponent(cfg.projectId)}/lock/heartbeat`,
        { currentlyEditing, ttlSec: 900 },
      ).catch(() => null);
      process.exit(0);
    }

    // 2c. Кто-то другой держит — блокируем.
    blockEdit(lockState);
  } catch (e) {
    // Любая неожиданная ошибка — не мешаем Claude'у работать.
    console.error('[coord-check] unexpected:', e && e.message);
    process.exit(0);
  }
})();

function blockEdit(lock) {
  const editing =
    Array.isArray(lock.currentlyEditing) && lock.currentlyEditing.length > 0
      ? lock.currentlyEditing.slice(0, 5).join(', ')
      : null;
  const session =
    Array.isArray(lock.sessionFiles) && lock.sessionFiles.length > 0
      ? lock.sessionFiles.slice(-5).join(', ')
      : null;
  const since = lock.acquiredAt
    ? new Date(lock.acquiredAt).toISOString().slice(0, 19).replace('T', ' ')
    : '?';
  const heartbeat = lock.heartbeatAt
    ? Math.round((Date.now() - lock.heartbeatAt) / 1000)
    : null;

  const lines = [
    `🔒 Project lock held by ${lock.holderUsername || 'another user'} since ${since}.`,
    lock.reason ? `Reason: ${lock.reason}` : null,
    editing ? `Currently editing: ${editing}` : null,
    session ? `Touched this session: ${session}` : null,
    heartbeat !== null ? `Last heartbeat: ${heartbeat}s ago` : null,
    '',
    'Edit blocked. Wait for them to finish, or pick a different scope of work.',
    'You can read files freely (Read/Grep/Bash are not blocked) — only writes are gated.',
  ].filter(Boolean);

  process.stderr.write(lines.join('\n') + '\n');
  process.exit(2);
}
