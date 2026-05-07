/**
 * Совпадает ли путь с одним из правил: точное равенство ИЛИ префикс с
 * разделителем. Префикс важен для пометок «исключить целую папку».
 */
export function matchesRule(path: string, rules?: string[] | null): boolean {
  if (!rules || rules.length === 0) return false;
  for (const r of rules) {
    if (!r) continue;
    if (r === path) return true;
    if (path.startsWith(r + '/')) return true;
  }
  return false;
}
