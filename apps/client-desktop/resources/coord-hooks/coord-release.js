#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Stop hook — Claude закончил session. Если мы держим лок — отпускаем.
 *
 * Работает best-effort: если лок не наш, или его уже нет, или сервер
 * недоступен — exit 0, ничего не делаем.
 */

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

    const cfg = findProjectConfig(cwd);
    if (!cfg || !cfg.serverId || !cfg.projectId) process.exit(0);

    const server = readServerCreds(cfg.serverId);
    if (!server) process.exit(0);

    // Узнаём состояние — лок наш ли?
    const get = await apiRequest(
      server,
      'GET',
      `/api/projects/${encodeURIComponent(cfg.projectId)}/lock`,
    ).catch(() => null);
    if (!get || !get.body || !get.body.lock) process.exit(0);

    const lock = get.body.lock;
    const meIsHolder =
      lock.holderUserId === server.userId ||
      lock.holderUsername === server.username;
    if (!meIsHolder) process.exit(0);

    await apiRequest(
      server,
      'POST',
      `/api/projects/${encodeURIComponent(cfg.projectId)}/lock/release`,
      { summary: 'Claude session ended' },
    ).catch(() => null);

    process.exit(0);
  } catch (e) {
    console.error('[coord-release] unexpected:', e && e.message);
    process.exit(0);
  }
})();
