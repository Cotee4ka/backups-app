/**
 * Формат строки-приглашения в проект. Owner создаёт через UI, копирует и
 * отдаёт другу. Друг вставляет в ConnectServerWizard → клиент парсит,
 * валидирует код через `/api/invites/:code/info` (без auth, по
 * fingerprint'у) и предлагает зарегистрироваться/залогиниться.
 *
 * Префикс `bapi.` чтобы отличать от pair-токена (`bap1.` / `bap2.`).
 *
 * Безопасность:
 *   - URL и fingerprint в токене позволяют клиенту дойти до сервера
 *     БЕЗ предварительной настройки.
 *   - Сам инвайт-код одноразовый и с TTL. Утечка ссылки в чат → один
 *     неизвестный мембер с указанной ролью; owner может его потом удалить.
 *   - Для server-level инвайтов (admin/member на сервер целиком) есть
 *     отдельный flow `POST /invites` — НЕ через эту ссылку.
 */
export interface InviteTokenPayload {
  v: 1;
  /** Полный URL сервера: `https://host:port` */
  url: string;
  /** SHA-256 fingerprint TLS-сертификата сервера, формат AA:BB:... */
  fp: string;
  /** Сам инвайт-код (nanoid). */
  code: string;
  /** Подсказка для UI до регистрации. Не доверять — сервер вернёт авторитет. */
  role?: 'admin' | 'member' | 'viewer';
  /** Имя проекта для UI. Опционально. */
  projectName?: string;
}

const PREFIX = 'bapi.';

/** Собирает строку для копирования. */
export function buildInviteToken(p: InviteTokenPayload): string {
  const json = JSON.stringify(p);
  // base64url без padding'а — короче, не нужны =/+/.
  const b64 = btoa(json)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return PREFIX + b64;
}

/** Парсит строку. Возвращает null если формат неверный. */
export function parseInviteToken(raw: string): InviteTokenPayload | null {
  let s = raw.trim();
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  // Восстанавливаем стандартный base64
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  try {
    const json = atob(s);
    const obj = JSON.parse(json) as InviteTokenPayload;
    if (obj.v !== 1) return null;
    if (!obj.url || !obj.fp || !obj.code) return null;
    return obj;
  } catch {
    return null;
  }
}
