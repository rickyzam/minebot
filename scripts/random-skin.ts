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

/** Turn a raw MineSkin listing into usable choices, dropping malformed entries. */
export function toSkinChoices(entries: readonly MineSkinEntry[]): SkinChoice[] {
  return entries
    .filter((e): e is { texture: string } => typeof e.texture === 'string' && /^[0-9a-f]{16,}$/.test(e.texture))
    .map((e) => ({ texture: e.texture, url: `${TEXTURE_CDN}/${e.texture}` }))
}

/**
 * Fetch a batch of skins and return `count` of them at random.
 *
 * Returns fewer — or none — rather than throwing: the caller treats skins as
 * decoration and carries on without them.
 */
export async function fetchRandomSkins(
  count: number,
  opts: { poolSize?: number; timeoutMs?: number } = {},
): Promise<SkinChoice[]> {
  const poolSize = opts.poolSize ?? 48
  const timeoutMs = opts.timeoutMs ?? 8_000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`https://api.mineskin.org/v2/skins?size=${poolSize}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return []
    const body = (await response.json()) as { skins?: MineSkinEntry[] }
    return pickRandom(toSkinChoices(body.skins ?? []), count)
  } catch {
    // Offline, rate-limited, or the API changed shape. Not worth failing over.
    return []
  } finally {
    clearTimeout(timer)
  }
}
