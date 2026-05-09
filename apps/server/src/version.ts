/**
 * Версия серверной части. Клиент сравнивает с собственной, чтобы решить,
 * нужно ли накатывать апдейт. Если версия на хосте < ожидаемой — клиент
 * блокирует подключение и предлагает обновиться через SSH.
 *
 * Бампать руками вместе с релизом docker-образа (CI собирает образ из main).
 *
 * `INSTALL_SCRIPT_VERSION` — отдельная версия установочного скрипта v2
 * (`install-v2.sh`). Хранится в `/opt/backups-app/install-version.txt` на
 * хосте и используется, чтобы клиент мог отдельно понять «надо ли обновить
 * сам скрипт» (даже если образ ещё актуален).
 *
 * Соглашение: бампаем синхронно с SERVER_VERSION в одном релизе.
 */
export const SERVER_VERSION = '0.6.0';
export const INSTALL_SCRIPT_VERSION = '0.6.0';

/**
 * Список фич, которые добавлялись в этой версии и в более ранних. Клиент
 * может явно проверить присутствие фичи, не сравнивая semver, чтобы было
 * понятно, что именно отсутствует у старого сервера.
 */
export const SERVER_FEATURES = [
  'tree',
  'tree-recursive',
  'data-store-detector',
  'version',
  'junk-dirs', // 0.3.0: tree-recursive прунит node_modules / .git / dist по умолчанию
  'install-v2', // 0.4.0: идемпотентный install-v2.sh + явный version-gate в клиенте
  'unbuffered-git-push', // 0.4.1: фикс «push >1 MB → Connection reset» (no-op content-type parsers)
  'worktree-mirror', // 0.4.2: post-receive hook + worktree-зеркала в /srv/projects на хосте
  'tree-last-author', // 0.6.0: в /tree у каждой entry есть lastCommit — кто и когда последний раз менял файл
] as const;
