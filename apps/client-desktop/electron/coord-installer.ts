import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-project установщик координационных хуков для Claude Code.
 *
 * Что делает при installForProject():
 *   1. Создаёт <projectDir>/.claude/backups-app.local.json — наш файл-маркер
 *      с serverId/projectId/projectName. Хуки читают его, чтобы понять
 *      на каком сервере и в каком проекте они работают.
 *   2. Создаёт/мерджит <projectDir>/.claude/settings.local.json с двумя
 *      хуками — PreToolUse(Edit|Write|MultiEdit|NotebookEdit) и Stop.
 *      Команды абсолютные (бандлятся вместе с Electron-app).
 *   3. В корневой CLAUDE.md проекта дописывает помеченный блок В НАЧАЛО
 *      (между BACKUPS_APP_COORD:BEGIN и :END). Юзерский контент ниже
 *      не трогается. Если CLAUDE.md нет — создаём с одним этим блоком.
 *   4. Дописывает .claude/* в .gitignore, если ещё не там — settings.local.json
 *      и backups-app.local.json машинно-зависимые, в git их нет смысла тащить.
 *
 * uninstallForProject() симметрично снимает ВСЁ что установили (полезно при
 * stopSync или удалении проекта). CLAUDE.md остаётся, но наш блок вырезается.
 *
 * Хуки/настройки только per-project — глобальный ~/.claude/settings.json
 * мы НЕ трогаем (по требованию юзера).
 */

const COORD_BLOCK_BEGIN = '<!-- BACKUPS_APP_COORD:BEGIN -->';
const COORD_BLOCK_END = '<!-- BACKUPS_APP_COORD:END -->';

const COORD_BLOCK_BODY = `<!-- BACKUPS_APP_COORD:BEGIN -->
# Координация Claude-агентов

Этот проект синхронизирован через **Backups App**. Над ним могут параллельно
работать другие Claude-сессии (на других машинах). Координация — через
лок-механизм на сервере проекта.

**Автоматика (без участия Claude'а):**
- Перед каждым \`Edit\` / \`Write\` / \`MultiEdit\` / \`NotebookEdit\` срабатывает
  PreToolUse-хук \`coord-check.js\`. Он берёт лок на проект (или продлевает,
  если уже у тебя). Если лок держит другой Claude — Edit будет **заблокирован**
  с сообщением «🔒 Project lock held by ...» в stderr.
- При завершении сессии — Stop-хук \`coord-release.js\` отпускает лок.

**Что делать, если видишь блок «🔒 Project lock held by ...»:**
1. Прочитай \`Currently editing\` и \`Touched this session\` из сообщения —
   это файлы, которые сейчас правит другой Claude.
2. Возьми задачу в **другой части проекта**, не пересекающейся с этой зоной
   (читать (\`Read\`, \`Grep\`, \`Bash\`) не блокируется — только запись).
3. Или дождись освобождения лока: TTL 15 мин, без heartbeat'а отпустится сам.

Лок берут **только Claude'ы и только на момент редактирования**. Юзер,
работающий в IDE напрямую, лок не берёт — его правки идут через git как
обычно, конфликты решаются стандартным merge'ем.
<!-- BACKUPS_APP_COORD:END -->
`;

interface InstallParams {
  projectDir: string;
  serverId: string;
  projectId: string;
  projectName: string;
  hookCheckPath: string; // абсолютный путь до coord-check.js
  hookReleasePath: string; // абсолютный путь до coord-release.js
}

export function installForProject(params: InstallParams): void {
  const { projectDir } = params;
  if (!fs.existsSync(projectDir)) return;

  const dotClaude = path.join(projectDir, '.claude');
  fs.mkdirSync(dotClaude, { recursive: true });

  // 1. Файл-маркер.
  writeBackupsAppMarker(dotClaude, params);

  // 2. Hooks в settings.local.json (мерджим, не затираем чужие хуки).
  writeOrMergeClaudeSettings(dotClaude, params);

  // 3. CLAUDE.md.
  writeOrUpdateClaudeMd(projectDir);

  // 4. .gitignore.
  ensureGitignore(projectDir);
}

export function uninstallForProject(projectDir: string): void {
  if (!fs.existsSync(projectDir)) return;
  const dotClaude = path.join(projectDir, '.claude');

  // Маркер.
  safeUnlink(path.join(dotClaude, 'backups-app.local.json'));

  // Hooks: вычистить только наши, оставить чужие.
  removeOurHooksFromSettings(path.join(dotClaude, 'settings.local.json'));

  // CLAUDE.md: вырезать наш блок.
  removeBlockFromClaudeMd(path.join(projectDir, 'CLAUDE.md'));
}

// ============================================================================
//  helpers
// ============================================================================

function writeBackupsAppMarker(dotClaude: string, p: InstallParams): void {
  const file = path.join(dotClaude, 'backups-app.local.json');
  const payload = {
    serverId: p.serverId,
    projectId: p.projectId,
    projectName: p.projectName,
    projectDir: p.projectDir,
    installedAt: Date.now(),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows fine */
  }
}

interface ClaudeSettingsHook {
  type: 'command';
  command: string;
}
interface ClaudeSettingsHookEntry {
  matcher?: string;
  hooks: ClaudeSettingsHook[];
}
interface ClaudeSettings {
  hooks?: {
    PreToolUse?: ClaudeSettingsHookEntry[];
    Stop?: ClaudeSettingsHookEntry[];
    [k: string]: ClaudeSettingsHookEntry[] | undefined;
  };
  [k: string]: unknown;
}

function writeOrMergeClaudeSettings(dotClaude: string, p: InstallParams): void {
  const file = path.join(dotClaude, 'settings.local.json');
  let settings: ClaudeSettings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeSettings;
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) settings.hooks = {};

  // PreToolUse
  const preMatchers = (settings.hooks.PreToolUse ??= []);
  const ourPreCommand = quoteForShell(p.hookCheckPath);
  removeMatchingEntries(preMatchers, isOurEntry);
  preMatchers.push({
    matcher: 'Edit|Write|MultiEdit|NotebookEdit',
    hooks: [
      {
        type: 'command',
        command: `node ${ourPreCommand}`,
      },
    ],
  });

  // Stop
  const stopMatchers = (settings.hooks.Stop ??= []);
  const ourStopCommand = quoteForShell(p.hookReleasePath);
  removeMatchingEntries(stopMatchers, isOurEntry);
  stopMatchers.push({
    hooks: [
      {
        type: 'command',
        command: `node ${ourStopCommand}`,
      },
    ],
  });

  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

function isOurEntry(entry: ClaudeSettingsHookEntry): boolean {
  return entry.hooks.some((h) =>
    /coord-check\.js|coord-release\.js/.test(h.command ?? ''),
  );
}

function removeMatchingEntries(
  arr: ClaudeSettingsHookEntry[],
  pred: (e: ClaudeSettingsHookEntry) => boolean,
): void {
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    if (e && pred(e)) arr.splice(i, 1);
  }
}

function removeOurHooksFromSettings(file: string): void {
  if (!fs.existsSync(file)) return;
  let settings: ClaudeSettings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeSettings;
  } catch {
    return;
  }
  if (!settings.hooks) return;
  for (const key of Object.keys(settings.hooks)) {
    const arr = settings.hooks[key];
    if (Array.isArray(arr)) removeMatchingEntries(arr, isOurEntry);
    if (Array.isArray(arr) && arr.length === 0) delete settings.hooks[key];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  // Если settings полностью опустел — удаляем файл, иначе перезаписываем.
  if (Object.keys(settings).length === 0) {
    safeUnlink(file);
  } else {
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  }
}

function quoteForShell(p: string): string {
  // На Windows кавычки прорабатывает PowerShell/cmd; на *nix — sh. Везде
  // двойные кавычки безопасный универсальный вариант. Внутрь \\ только
  // экранируем сами кавычки.
  return `"${p.replace(/"/g, '\\"')}"`;
}

function writeOrUpdateClaudeMd(projectDir: string): void {
  const file = path.join(projectDir, 'CLAUDE.md');
  let existing = '';
  if (fs.existsSync(file)) {
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      existing = '';
    }
  }

  // Если наш блок уже есть — заменяем (вдруг content обновился).
  const beginIdx = existing.indexOf(COORD_BLOCK_BEGIN);
  const endIdx = existing.indexOf(COORD_BLOCK_END);

  let withoutOurBlock = existing;
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const tailStart = endIdx + COORD_BLOCK_END.length;
    withoutOurBlock =
      existing.slice(0, beginIdx) +
      existing.slice(tailStart).replace(/^\s*\n/, ''); // убираем оставшийся пустой перевод
  }

  const next = withoutOurBlock.length === 0
    ? COORD_BLOCK_BODY
    : COORD_BLOCK_BODY + '\n' + withoutOurBlock.replace(/^\s+/, '');

  fs.writeFileSync(file, next);
}

function removeBlockFromClaudeMd(file: string): void {
  if (!fs.existsSync(file)) return;
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const beginIdx = content.indexOf(COORD_BLOCK_BEGIN);
  const endIdx = content.indexOf(COORD_BLOCK_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return;
  const tailStart = endIdx + COORD_BLOCK_END.length;
  const next =
    content.slice(0, beginIdx) +
    content.slice(tailStart).replace(/^\s*\n/, '');
  if (next.trim().length === 0) {
    safeUnlink(file);
  } else {
    fs.writeFileSync(file, next);
  }
}

function ensureGitignore(projectDir: string): void {
  const file = path.join(projectDir, '.gitignore');
  const wantedLines = [
    '/.claude/settings.local.json',
    '/.claude/backups-app.local.json',
  ];

  let content = '';
  if (fs.existsSync(file)) {
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      content = '';
    }
  }

  const lines = content.split(/\r?\n/);
  const present = new Set(lines.map((l) => l.trim()));
  const missing = wantedLines.filter((l) => !present.has(l));
  if (missing.length === 0) return;

  let appended = content;
  if (appended.length > 0 && !appended.endsWith('\n')) appended += '\n';
  appended += '\n# Backups App — машинно-зависимый координационный конфиг\n';
  appended += missing.join('\n') + '\n';
  fs.writeFileSync(file, appended);
}

function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* ok */
  }
}

/**
 * Находит абсолютные пути к bundled hook-скриптам. В dev-режиме это путь
 * относительно репы, в prod — относительно process.resourcesPath.
 */
export function findHookScriptPaths(): { check: string; release: string } | null {
  const fromEnvCheck = process.env.BACKUPS_COORD_HOOK_CHECK;
  const fromEnvRelease = process.env.BACKUPS_COORD_HOOK_RELEASE;
  if (fromEnvCheck && fromEnvRelease && fs.existsSync(fromEnvCheck) && fs.existsSync(fromEnvRelease)) {
    return { check: fromEnvCheck, release: fromEnvRelease };
  }

  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const candidates: string[] = [
    resourcesPath ? path.join(resourcesPath, 'coord-hooks') : '',
    path.resolve(process.cwd(), 'apps/client-desktop/resources/coord-hooks'),
    path.resolve(process.cwd(), '../client-desktop/resources/coord-hooks'),
    path.resolve(__dirname, '../resources/coord-hooks'),
    path.resolve(__dirname, '../../resources/coord-hooks'),
  ].filter(Boolean);

  for (const dir of candidates) {
    const check = path.join(dir, 'coord-check.js');
    const release = path.join(dir, 'coord-release.js');
    if (fs.existsSync(check) && fs.existsSync(release)) {
      return { check, release };
    }
  }
  return null;
}
