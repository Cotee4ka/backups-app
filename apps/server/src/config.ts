import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function envOr<T>(key: string, fallback: T): string | T {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const dataDir = envOr('BACKUPS_DATA_DIR', path.resolve(__dirname, '../data'));

export const config = {
  host: envOr('BACKUPS_HOST', '0.0.0.0') as string,
  port: envInt('BACKUPS_PORT', 8443),
  publicUrl: envOr('BACKUPS_PUBLIC_URL', '') as string,

  dataDir,
  dbPath: envOr('BACKUPS_DB_PATH', path.join(dataDir, 'backups.db')) as string,
  reposDir: envOr('BACKUPS_REPOS_DIR', path.join(dataDir, 'repos')) as string,
  certsDir: envOr('BACKUPS_CERTS_DIR', path.join(dataDir, 'certs')) as string,

  tlsEnabled: (envOr('BACKUPS_TLS', 'true') as string).toLowerCase() !== 'false',

  jwtSecret: envOr(
    'BACKUPS_JWT_SECRET',
    crypto.randomBytes(48).toString('hex'),
  ) as string,

  accessTokenTtlSec: envInt('BACKUPS_ACCESS_TTL', 15 * 60),
  refreshTokenTtlSec: envInt('BACKUPS_REFRESH_TTL', 7 * 24 * 60 * 60),

  bcryptCost: envInt('BACKUPS_BCRYPT_COST', 4),

  // First-run admin bootstrap. Если задан — при пустой БД создаётся owner.
  bootstrapAdminUser: envOr('BACKUPS_ADMIN_USER', '') as string,
  bootstrapAdminPassword: envOr('BACKUPS_ADMIN_PASSWORD', '') as string,
};

export type AppConfig = typeof config;
