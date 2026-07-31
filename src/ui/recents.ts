/** A recently opened case. Stable identifiers only — keys/titles can change, ids and paths are re-keyed on migration. */
export interface RecentCase {
  /** Project file path. */
  path: string
  /** Task id. */
  id: string
}

export const RECENT_CASES_MAX = 15

/** Most-recent-first push with dedup (by path+id) and cap. Pure — returns a new array. */
export function pushRecent(list: RecentCase[], entry: RecentCase): RecentCase[] {
  return [entry, ...list.filter((r) => r.path !== entry.path || r.id !== entry.id)].slice(0, RECENT_CASES_MAX)
}

// PMSettings lives in types.ts, which a concurrent change owns — the optional
// field is added by augmentation instead. Fold into types.ts when convenient.
declare module '../types' {
  interface PMSettings {
    /** Recently opened cases, most recent first (cap 15). Absent in older data.json. */
    recentCases?: RecentCase[]
  }
}
