import { listExternalTreeRecursive, type ExternalFileEntry } from './host-fs.js';

/**
 * Детектор «хранилища данных» — файлов, которые на проде регулярно меняются
 * и/или большие, поэтому их обычно НЕ нужно тащить вместе с исходниками:
 * БД, дампы, бэкапы, архивы, статистика, логи.
 *
 * Детектор честно отдаёт причину, почему файл попал в список — клиент
 * показывает её юзеру в визарде, чтобы можно было поправить руками.
 */

/**
 * Паттерны имени/расширения. Если хоть один совпал — файл считается
 * «хранилищем данных» по совокупности признаков (см. reasons ниже).
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
];

/**
 * Триггер-слова в пути или имени файла/папки. Должно быть «целым словом»
 * (через \b), чтобы не цепляло легитимные имена вроде "logging" или
 * "stutorial".
 */
const NAME_PATTERNS: { regex: RegExp; label: string }[] = [
  { regex: /\bbackup[s]?\b/i, label: 'backup в пути' },
  { regex: /\bdump[s]?\b/i, label: 'dump в пути' },
  { regex: /\bsnapshots?\b/i, label: 'snapshot в пути' },
  { regex: /\bstats?\b/i, label: 'stats в пути' },
  { regex: /\banalytics\b/i, label: 'analytics в пути' },
  { regex: /\bmetrics\b/i, label: 'metrics в пути' },
];

/** Файлы крупнее этого порога считаются подозрительными вне зависимости от имени. */
const LARGE_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

export interface DataStoreFinding {
  relPath: string;
  size: number;
  mtime: number;
  /** Машинно-читаемые причины: 'extension' | 'name' | 'size'. */
  reasons: Array<'extension' | 'name' | 'size'>;
  /** Человекочитаемые ярлыки: «SQL-дамп», «backup в пути», «> 25 МБ» и т.п. */
  labels: string[];
}

export interface DataStoreReport {
  /** Список найденных файлов, отсортирован по размеру по убыванию. */
  files: DataStoreFinding[];
  /** Сколько всего файлов отсканировано в проекте. */
  totalScanned: number;
  /** Был ли обход обрезан лимитами host-fs. */
  truncated: boolean;
  /** Совокупный размер найденных «данных», в байтах. */
  totalDataBytes: number;
}

function detectFile(entry: ExternalFileEntry): DataStoreFinding | null {
  const reasons: DataStoreFinding['reasons'] = [];
  const labels: string[] = [];

  for (const p of EXTENSION_PATTERNS) {
    if (p.regex.test(entry.relPath)) {
      reasons.push('extension');
      labels.push(p.label);
      break;
    }
  }

  for (const p of NAME_PATTERNS) {
    if (p.regex.test(entry.relPath)) {
      if (!reasons.includes('name')) reasons.push('name');
      labels.push(p.label);
      break;
    }
  }

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
 * Проходит по дереву файлов external project, применяет эвристики и
 * возвращает отчёт. Не качает ничего, только читает stat + listdir.
 */
export async function detectDataStore(
  externalPath: string,
  subPath = '',
): Promise<DataStoreReport> {
  const tree = await listExternalTreeRecursive(externalPath, subPath);
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
  return {
    files: findings,
    totalScanned: tree.entries.length,
    truncated: tree.truncated,
    totalDataBytes,
  };
}
