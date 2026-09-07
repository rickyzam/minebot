import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Remembers which skins have been handed out, so a respawned group does not
 * keep drawing the same handful.
 *
 * Cost is negligible: an entry is a 64-character texture id, so the default
 * 1000-entry history is roughly **70 KB** on disk and the same in memory. There
 * is no reason to keep it smaller.
 *
 * Oldest entries fall off once the cap is reached, so a skin becomes eligible
 * again only after 1000 others have been used.
 */
export const DEFAULT_HISTORY_LIMIT = 1000

export interface SkinHistory {
  /** Texture ids already used, oldest first. */
  readonly used: readonly string[]
}

export function emptyHistory(): SkinHistory {
  return { used: [] }
}

/** Add ids to the history, dropping the oldest beyond `limit`. */
export function remember(
  history: SkinHistory,
  ids: readonly string[],
  limit: number = DEFAULT_HISTORY_LIMIT,
): SkinHistory {
  // De-duplicate against what is already there, so re-remembering an id does
  // not push newer entries out early.
  const existing = new Set(history.used)
  const additions = ids.filter((id) => !existing.has(id))
  const combined = [...history.used, ...additions]
  return { used: combined.slice(Math.max(0, combined.length - limit)) }
}

/** Ids not used recently, preserving input order. */
export function unused<T extends { texture: string }>(
  history: SkinHistory,
  candidates: readonly T[],
): T[] {
  const seen = new Set(history.used)
  return candidates.filter((c) => !seen.has(c.texture))
}

export function loadHistory(path: string): SkinHistory {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SkinHistory>
    if (!Array.isArray(parsed.used)) return emptyHistory()
    return { used: parsed.used.filter((id): id is string => typeof id === 'string') }
  } catch {
    // Missing or unreadable: start fresh rather than fail a spawn over history.
    return emptyHistory()
  }
}

export function saveHistory(path: string, history: SkinHistory): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ used: history.used }, null, 2))
  } catch {
    // Losing the history costs variety, not correctness.
  }
}
