export {
  HARD_IGNORE_PATTERNS,
  HARD_NEVER_SYNC,
  WATCHER_IGNORE_PATTERNS,
  buildGitignore,
} from './ignore.js';

export const PROJECT_CONFIG_FILENAME = '.backupsapp.json';

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

export const DEFAULT_SERVER_PORT = 8443;

export const SYNC_DEBOUNCE_MS = 10_000;

export const SYNC_PERIODIC_FLUSH_MS = 2 * 60 * 1000;

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export const WS_PATH = '/ws';

export const GIT_HTTP_PATH = '/git';

export const API_PATH = '/api';
