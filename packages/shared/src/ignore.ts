/**
 * Hard-coded ignore patterns for the file watcher and the git index.
 *
 * Applied BEFORE any per-project `.backupsapp.json` config is loaded.
 * Per-project config can ONLY add to this list, not remove from it.
 *
 * The patterns are written for `chokidar` (anymatch) AND for `.gitignore`
 * style matchers. They are intentionally aggressive: any directory that
 * routinely contains tens of thousands of files belongs here.
 */
export const HARD_IGNORE_PATTERNS: readonly string[] = [
  // Dependency directories
  '**/node_modules/**',
  '**/.pnpm-store/**',
  '**/bower_components/**',
  '**/jspm_packages/**',
  '**/vendor/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/*.egg-info/**',

  // Build artifacts
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/.turbo/**',
  '**/.parcel-cache/**',
  '**/.cache/**',
  '**/coverage/**',

  // VCS / IDE
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/.vs/**',

  // OS
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/desktop.ini',
  '**/.Trash/**',
  '**/$RECYCLE.BIN/**',

  // Logs and tmp
  '**/*.log',
  '**/*.tmp',
  '**/.tmp/**',
  '**/tmp/**',

  // Lockfiles that change every install (still synced as files but not watched live)
  // -> kept tracked, NOT ignored. Listed here as a reminder.

  // Sensitive
  '**/.env.local',
  '**/.env.*.local',
];

/** Patterns matching files we should never sync at all (security). */
export const HARD_NEVER_SYNC: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/id_rsa',
  '**/id_rsa.pub',
  '**/id_ed25519',
  '**/id_ed25519.pub',
  '**/*.pem',
  '**/*.key',
];

/** Combined list — what `chokidar` should be initialized with. */
export const WATCHER_IGNORE_PATTERNS: readonly string[] = [
  ...HARD_IGNORE_PATTERNS,
  ...HARD_NEVER_SYNC,
];

/**
 * Build the contents of a `.gitignore` file from the hard ignore lists, plus
 * any extra patterns supplied by `.backupsapp.json`.
 */
export function buildGitignore(extra: readonly string[] = []): string {
  const banner = [
    '# Managed by Backups App. Do not edit by hand.',
    '# Add custom patterns to .backupsapp.json -> "ignore" instead.',
    '',
  ];
  const sections = [
    '# Hard-coded never-sync patterns',
    ...HARD_NEVER_SYNC,
    '',
    '# Hard-coded ignored directories and files',
    ...HARD_IGNORE_PATTERNS,
  ];
  if (extra.length > 0) {
    sections.push('', '# Extra from .backupsapp.json');
    sections.push(...extra);
  }
  return [...banner, ...sections, ''].join('\n');
}
