/**
 * Pick random skins for bots.
 *
 * Skins reach a bot through the Velocity forwarding payload's `textures`
 * property, and a **vanilla client only loads skins from Mojang's own texture
 * CDN** — an arbitrary image host will not render. So the URL has to be
 * `https://textures.minecraft.net/texture/<hash>`, and the problem reduces to
 * finding real hashes.
 *
 * MineSkin publishes exactly that: skins the community has generated, each with
 * the Mojang texture hash it was uploaded as. Verified 2026-09-07 that a hash
 * from its listing resolves on Mojang's CDN (HTTP 200, a 1451-byte PNG).
 *
 * Network failures are never fatal here. A bot with no skin is a cosmetic loss;
 * a bot that fails to spawn is not.
 */

/** Mojang's texture CDN — the only host a vanilla client will load a skin from. */
export const TEXTURE_CDN = 'https://textures.minecraft.net/texture'

export interface SkinChoice {
  /** Mojang texture hash. */
  readonly texture: string
  /** Full CDN URL, ready for `texturesProperty`. */
  readonly url: string
}

interface MineSkinEntry {
  texture?: string
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
 * Turn a raw MineSkin listing into usable choices, dropping malformed entries
 * and **de-duplicating by texture hash**.
 *
 * The listing can carry the same texture under more than one upload id, which
 * once put two bots in identical skins on the same run — shuffling cannot help
 * with that, because the duplicates are distinct entries.
 */
export function toSkinChoices(entries: readonly MineSkinEntry[]): SkinChoice[] {
  const seen = new Set<string>()
  const choices: SkinChoice[] = []
  for (const entry of entries) {
    const texture = entry.texture
    if (typeof texture !== 'string' || !/^[0-9a-f]{16,}$/.test(texture)) continue
    if (seen.has(texture)) continue
    seen.add(texture)
    choices.push({ texture, url: `${TEXTURE_CDN}/${texture}` })
  }
  return choices
}

interface MineSkinPage {
  skins?: MineSkinEntry[]
  pagination?: { next?: { after?: string } }
}

/**
 * Fetch a batch of skins and return `count` of them at random.
 *
 * The listing is ordered newest-first, so two runs minutes apart see almost the
 * same page and keep drawing the same skins — which is exactly what was observed.
 * Following the pagination cursor a **random number of pages** first lands the
 * pool somewhere different in MineSkin's history on each run, so repeats across
 * runs become unlikely rather than routine.
 *
 * Returns fewer — or none — rather than throwing: the caller treats skins as
 * decoration and carries on without them.
 */
export async function fetchRandomSkins(
  count: number,
  opts: { poolSize?: number; timeoutMs?: number; maxDepth?: number } = {},
): Promise<SkinChoice[]> {
  const poolSize = opts.poolSize ?? 48
  const timeoutMs = opts.timeoutMs ?? 12_000
  const depth = Math.floor(Math.random() * ((opts.maxDepth ?? 12) + 1))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const pool: MineSkinEntry[] = []
    let after: string | undefined

    // One page past the random depth, so the pool is a random slice rather than
    // always the newest uploads.
    for (let page = 0; page <= depth; page++) {
      const query = `size=${poolSize}${after ? `&after=${encodeURIComponent(after)}` : ''}`
      const response = await fetch(`https://api.mineskin.org/v2/skins?${query}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!response.ok) break
      const body = (await response.json()) as MineSkinPage
      const skins = body.skins ?? []
      if (skins.length === 0) break
      // Only the final page feeds the pool; earlier ones are just paging cost.
      if (page === depth) pool.push(...skins)
      after = body.pagination?.next?.after
      if (!after) {
        // Ran out of history before reaching the target depth — use what we have.
        if (pool.length === 0) pool.push(...skins)
        break
      }
    }

    return pickRandom(toSkinChoices(pool), count)
  } catch {
    // Offline, rate-limited, or the API changed shape. Not worth failing over.
    return []
  } finally {
    clearTimeout(timer)
  }
}
