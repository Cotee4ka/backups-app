/**
 * Триггеры для "тяжёлых" файлов (бэкапы, дампы, БД, статистика, архивы).
 * Эти файлы по умолчанию НЕ участвуют в авто-синхронизации — только по
 * отдельной кнопке. Список должен совпадать с electron/external-sync.ts.
 */
const HEAVY_PATTERNS: RegExp[] = [
  /\.sql(\.gz|\.bz2|\.zst)?$/i,
  /\.dump$/i,
  /\.bak$/i,
  /\.backup$/i,
  /\.sqlite3?$/i,
  /\.db$/i,
  /\.tar(\.gz|\.bz2|\.zst|\.xz)?$/i,
  /\.zip$/i,
  /\.7z$/i,
  /\.rar$/i,
  /\bbackup[s]?\b/i,
  /\bdump[s]?\b/i,
  /\bsnapshots?\b/i,
  /\bstats?\b/i,
  /\banalytics\b/i,
  /\.log$/i,
  /\.log\.\d+$/i,
];

export function isHeavyPath(relPath: string): boolean {
  return HEAVY_PATTERNS.some((p) => p.test(relPath));
}
