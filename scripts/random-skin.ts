import { unused, type SkinHistory } from './skin-history.js'

/**
 * Pick random skins for bots.
 *
 * Skins reach a bot through the Velocity forwarding payload's `textures`
 * property. The property must be the **Mojang-signed** `value` + `signature`
 * pair, not one built by hand: a client silently discards an unsigned texture
 * and falls back to one of Minecraft's ~9 built-in default skins, chosen by
 * UUID. That looks like a small set of skins reshuffling between bots on every
 * run, and no amount of server-side checking reveals it, because the server
 * faithfully advertises whatever it was given.
 *
 * MineSkin's per-skin endpoint returns exactly that signed pair. The listing
 * endpoint does not — it carries only the texture id — so each chosen skin needs
 * a second request.
 *
 * Network failures are never fatal here. A bot with no skin is a cosmetic loss;
 * a bot that fails to spawn is not.
 */

const API = 'https://api.mineskin.org/v2'

/** A skin ready to forward: Mojang's signed property for one texture. */
export interface SkinChoice {
  /** Mojang texture id, used for de-duplication and history. */
  readonly texture: string
  /** Base64 profile property value, signed by Mojang. */
  readonly value: string
  /** Mojang's signature over `value`. Without it the client ignores the skin. */
  readonly signature: string
}

interface ListingEntry {
  uuid?: string
  texture?: string
}

interface ListingPage {
  skins?: ListingEntry[]
  pagination?: { next?: { after?: string } }
}

/** A candidate from the listing, before its signed data has been fetched. */
export interface SkinCandidate {
  readonly id: string
  readonly texture: string
}

/** Fisher-Yates, so picks are uniform rather than biased toward the head. */
export function pickRandom<T>(items: readonly T[], count: number): T[] {
  const pool = [...items]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  return pool.slice(0, count)
}

/**
 * Turn a raw listing into candidates, dropping malformed entries and
 * **de-duplicating by texture id**.
 *
 * The listing can carry one texture under several upload ids, which once put
 * two bots in identical skins in the same run. Shuffling cannot help with that,
 * because the duplicates are distinct entries.
 */
export function toCandidates(entries: readonly ListingEntry[]): SkinCandidate[] {
  const seen = new Set<string>()
  const candidates: SkinCandidate[] = []
  for (const entry of entries) {
    const { uuid, texture } = entry
    if (typeof uuid !== 'string' || typeof texture !== 'string') continue
    if (!/^[0-9a-f]{16,}$/.test(texture)) continue
    if (seen.has(texture)) continue
    seen.add(texture)
    candidates.push({ id: uuid, texture })
  }
  return candidates
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

/**
 * Collect candidates from a random slice of MineSkin's history.
 *
 * The listing is newest-first, so two runs minutes apart otherwise see almost
 * the same page and keep drawing the same skins. Following the pagination cursor
 * a random number of pages first lands the pool somewhere different each run.
 */
async function collectCandidates(
  signal: AbortSignal,
  pageSize: number,
  maxDepth: number,
): Promise<SkinCandidate[]> {
  const depth = Math.floor(Math.random() * (maxDepth + 1))
  const collected: ListingEntry[] = []
  let after: string | undefined

  for (let page = 0; page <= depth; page++) {
    const query = `size=${pageSize}${after ? `&after=${encodeURIComponent(after)}` : ''}`
    const body = await getJson<ListingPage>(`${API}/skins?${query}`, signal)
    const skins = body?.skins ?? []
    if (skins.length === 0) break
    // Keep the last two pages, so the pool stays large enough to survive
    // history filtering without paging the whole way again.
    if (page >= depth - 1) collected.push(...skins)
    after = body?.pagination?.next?.after
    if (!after) break
  }
  return toCandidates(collected)
}

/** Fetch the Mojang-signed property for one skin. */
async function fetchSigned(
  candidate: SkinCandidate,
  signal: AbortSignal,
): Promise<SkinChoice | null> {
  const body = await getJson<{
    skin?: { texture?: { data?: { value?: string; signature?: string } } }
  }>(`${API}/skins/${candidate.id}`, signal)

  const data = body?.skin?.texture?.data
  if (!data?.value || !data.signature) return null
  return { texture: candidate.texture, value: data.value, signature: data.signature }
}

/**
 * Return up to `count` distinct, signed skins that are not in `history`.
 *
 * Guaranteed within a batch: every returned skin has a different texture, so no
 * two bots spawned together can share one.
 */
export async function fetchRandomSkins(
  count: number,
  opts: {
    history?: SkinHistory
    pageSize?: number
    maxDepth?: number
    timeoutMs?: number
  } = {},
): Promise<SkinChoice[]> {
  const pageSize = opts.pageSize ?? 48
  const maxDepth = opts.maxDepth ?? 12
  const timeoutMs = opts.timeoutMs ?? 25_000
  const history = opts.history ?? { used: [] }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const candidates = await collectCandidates(controller.signal, pageSize, maxDepth)

    // Prefer unseen skins, but never return nothing just because the history is
    // saturated — fall back to the full pool rather than spawning bare bots.
    const fresh = unused(history, candidates)
    const preferred =
      fresh.length >= count
        ? fresh
        : [...fresh, ...candidates.filter((c) => !fresh.includes(c))]

    const chosen: SkinChoice[] = []
    for (const candidate of pickRandom(preferred, preferred.length)) {
      if (chosen.length >= count) break
      const signed = await fetchSigned(candidate, controller.signal)
      if (signed) chosen.push(signed)
    }
    return chosen
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
