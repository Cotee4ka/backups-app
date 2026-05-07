/**
 * Минимальная версия серверной части, с которой совместим этот клиент.
 * Бампать вместе с релизом фич, которые требуют новых endpoint'ов.
 *
 * Если на VPS установлен сервер старее — клиент покажет плашку
 * "обновите серверное ПО" с готовой командой.
 */
export const MIN_SERVER_VERSION = '0.3.0';

/** Простой semver-парсер: '1.2.3' → [1, 2, 3]. Игнорирует pre-release. */
function parseSemver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Возвращает true, если actual < required по semver. */
export function isOlderThan(actual: string, required: string): boolean {
  const [a1, a2, a3] = parseSemver(actual);
  const [r1, r2, r3] = parseSemver(required);
  if (a1 !== r1) return a1 < r1;
  if (a2 !== r2) return a2 < r2;
  return a3 < r3;
}

/** Команда обновления, которую копирует пользователь по кнопке. */
export function buildUpdateCommand(): string {
  return [
    'sudo docker pull ghcr.io/cotee4ka/backups-app-server:latest',
    'sudo docker compose -f /opt/backups-app/docker-compose.yml up -d',
  ].join(' && ');
}
