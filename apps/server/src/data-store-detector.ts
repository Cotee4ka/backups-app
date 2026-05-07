import { listExternalTreeRecursive, type ExternalFileEntry } from './host-fs.js';

/**
 * Серверный детектор файлов, которые юзеру обычно не нужно тащить с прода
 * вместе с исходниками. Делит находки на две категории:
 *
 *   1. **junk** — мусорные директории (node_modules, .git, dist, build, …).
 *      Это не «данные», это автогенерируемый кэш/зависимости. По умолчанию
 *      исключаются полностью.
 *   2. **dataStore** — БД, бэкапы, дампы, архивы, статистика, логи.
 *      По умолчанию качаются только по отдельной кнопке.
 */

/**
 * Имена папок, в которые НИКОГДА не нужно лезть. host-fs прибьёт обход
 * на этих именах, размер агрегирует. Клиент покажет их отдельной секцией
 * визарда с пометкой «исключить» по умолчанию.
 */
export const JUNK_DIR_NAMES = new Set<string>([
  // node / web
  'node_modules',
  'bower_components',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.parcel-cache',
  // python
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  // ruby / php
  'vendor',
  // rust / go / java
  'target',
  // generic build outputs
  'dist',
  'build',
  'out',
  '.turbo',
  '.cache',
  // VCS / IDE
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  // temp
  'tmp',
  'temp',
  // coverage / iac state
  'coverage',
  '.nyc_output',
  '.terraform',
  '.serverless',
]);

/**
 * Точные расширения «хранилища данных». Совпадение → файл сразу попадает
 * в dataStore с человекочитаемой меткой.
 */
const EXTENSION_PATTERNS: { regex: RegExp; label: string }[] = [
  { regex: /\.sql(\.gz|\.bz2|\.zst)?$/i, label: 'SQL-дамп' },
  { regex: /\.dump$/i, label: 'дамп БД' },
  { regex: /\.bak$/i, label: 'бэкап' },
  { regex: /\.backup$/i, label: 'бэкап' },
  { regex: /\.sqlite3?$/i, label: 'SQLite БД' },
  { regex: /\.db$/i, label: 'файл БД' },
  { regex: /\.tar(\.gz|\.bz2|\.zst|\.xz)?$/i, label: 'tar-архив' },
  { regex: /\.zip$/i, label: 'zip-архив' },
  { regex: /\.7z$/i, label: '7z-архив' },
  { regex: /\.rar$/i, label: 'rar-архив' },
  { regex: /\.log$/i, label: 'лог' },
  { regex: /\.log\.\d+$/i, label: 'ротированный лог' },
  { regex: /\.pcap(ng)?$/i, label: 'сетевой дамп' },
  { regex: /\.csv$/i, label: 'CSV-выгрузка' },
];

/**
 * Триггер-слова. Применяются к **токенизированному** имени, поэтому ловят
 * `userStats`, `daily-backup-2024`, `analytics_report`, не плодя ложных
 * срабатываний на типа `installer` (нет токена «log/stats/dump»).
 */
const KEYWORD_LABELS: Record<string, string> = {
  backup: 'backup в названии',
  backups: 'backup в названии',
  dump: 'dump в названии',
  dumps: 'dump в названии',
  snapshot: 'snapshot в названии',
  snapshots: 'snapshot в названии',
  stat: 'stat в названии',
  stats: 'stats в названии',
  analytics: 'analytics в названии',
  metrics: 'metrics в названии',
  log: 'log в названии',
  logs: 'log в названии',
  cache: 'cache в названии',
};

/** Файлы крупнее этого порога считаются подозрительными вне зависимости от имени. */
const LARGE_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Разбивает имя/путь на токены: camelCase → camel + Case, snake_case,
 * kebab-case, точки, слэши, пробелы. Все токены приводит к нижнему регистру.
 *
 * `userStats.json` → ['user', 'stats', 'json']
 * `daily_backup-2024.sql.gz` → ['daily', 'backup', '2024', 'sql', 'gz']
 * `mystatscollector.go` → ['mystatscollector', 'go']  (без границ — слитное написание не словится)
 */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\-./\\]+/)
    .filter((s) => s.length > 0);
}

export interface DataStoreFinding {
  relPath: string;
  size: number;
  mtime: number;
  /** Машинно-читаемые причины: 'extension' | 'name' | 'size'. */
  reasons: Array<'extension' | 'name' | 'size'>;
  /** Человекочитаемые ярлыки: «SQL-дамп», «backup в названии», «крупнее 10 МБ». */
  labels: string[];
}

export interface JunkFinding {
  /** Путь от корня external project. */
  relPath: string;
  /** Совокупный размер содержимого (рекурсивно). */
  size: number;
  /** Сколько файлов внутри. */
  fileCount: number;
  /** Имя последнего сегмента — node_modules, .git, dist… */
  name: string;
  /** Категория для UI: 'dependencies' | 'build' | 'cache' | 'vcs' | 'ide' | 'temp'. */
  category: 'dependencies' | 'build' | 'cache' | 'vcs' | 'ide' | 'temp';
}

export interface DataStoreReport {
  /** «Хранилище данных» — БД, бэкапы, архивы, статистика, логи. */
  files: DataStoreFinding[];
  /** Мусорные директории — node_modules, .git, dist… (рекомендованы к исключению). */
  junkDirs: JunkFinding[];
  /** Сколько всего файлов отсканировано (без junk-директорий). */
  totalScanned: number;
  /** Был ли обход обрезан лимитами host-fs. */
  truncated: boolean;
  /** Совокупный размер dataStore-файлов, в байтах. */
  totalDataBytes: number;
  /** Совокупный размер junk-директорий, в байтах. */
  totalJunkBytes: number;
}

function categoryFor(dirName: string): JunkFinding['category'] {
  if (dirName === 'node_modules' || dirName === 'vendor' || dirName === 'bower_components') {
    return 'dependencies';
  }
  if (dirName === '.git' || dirName === '.svn' || dirName === '.hg') return 'vcs';
  if (dirName === '.idea' || dirName === '.vscode') return 'ide';
  if (dirName === 'tmp' || dirName === 'temp') return 'temp';
  if (
    dirName === '.cache' ||
    dirName === '.parcel-cache' ||
    dirName === '.pytest_cache' ||
    dirName === '.mypy_cache' ||
    dirName === '.nyc_output' ||
    dirName === '.turbo' ||
    dirName === '__pycache__'
  ) {
    return 'cache';
  }
  return 'build';
}

function detectFile(entry: ExternalFileEntry): DataStoreFinding | null {
  const reasons: DataStoreFinding['reasons'] = [];
  const labels: string[] = [];

  // 1) расширение — самый надёжный сигнал
  for (const p of EXTENSION_PATTERNS) {
    if (p.regex.test(entry.relPath)) {
      reasons.push('extension');
      labels.push(p.label);
      break;
    }
  }

  // 2) триггер-слово — токенизируем весь путь, не только имя файла
  const tokens = tokenize(entry.relPath);
  for (const t of tokens) {
    const label = KEYWORD_LABELS[t];
    if (label) {
      if (!reasons.includes('name')) reasons.push('name');
      if (!labels.includes(label)) labels.push(label);
    }
  }

  // 3) размер — кандидат на отдельную синхронизацию
  if (entry.size >= LARGE_FILE_BYTES) {
    reasons.push('size');
    labels.push(`крупнее ${Math.round(LARGE_FILE_BYTES / 1024 / 1024)} МБ`);
  }

  if (reasons.length === 0) return null;
  return {
    relPath: entry.relPath,
    size: entry.size,
    mtime: entry.mtime,
    reasons,
    labels,
  };
}

/**
 * Полный отчёт по external project: junk-директории + хранилище данных.
 */
export async function detectDataStore(
  externalPath: string,
  subPath = '',
): Promise<DataStoreReport> {
  const tree = await listExternalTreeRecursive(externalPath, subPath, {
    pruneDirNames: JUNK_DIR_NAMES,
  });

  const findings: DataStoreFinding[] = [];
  let totalDataBytes = 0;
  for (const e of tree.entries) {
    const f = detectFile(e);
    if (f) {
      findings.push(f);
      totalDataBytes += f.size;
    }
  }
  findings.sort((a, b) => b.size - a.size);

  const junkDirs: JunkFinding[] = tree.prunedDirs.map((d) => {
    const name = d.relPath.split('/').pop() ?? d.relPath;
    return {
      relPath: d.relPath,
      size: d.size,
      fileCount: d.fileCount,
      name,
      category: categoryFor(name),
    };
  });
  junkDirs.sort((a, b) => b.size - a.size);
  const totalJunkBytes = junkDirs.reduce((a, c) => a + c.size, 0);

  return {
    files: findings,
    junkDirs,
    totalScanned: tree.entries.length,
    truncated: tree.truncated,
    totalDataBytes,
    totalJunkBytes,
  };
}
