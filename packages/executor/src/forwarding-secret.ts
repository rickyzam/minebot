import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Environment variable checked first. */
export const FORWARDING_SECRET_ENV = 'VELOCITY_FORWARDING_SECRET'

/**
 * Conventional location of the proxy's secret on this project's dev machine.
 * Checked only as a fallback, so nothing breaks if the proxy is not installed.
 */
export const DEFAULT_FORWARDING_SECRET_PATH = join(
  homedir(),
  'minecraft',
  'velocity',
  'forwarding.secret',
)

/**
 * Find the Velocity forwarding secret, or return `null` if there is none.
 *
 * Checked in order: the `VELOCITY_FORWARDING_SECRET` environment variable, then
 * the proxy's secret file. Returning `null` rather than throwing is deliberate —
 * a plain server needs no secret, so its absence is a normal configuration, not
 * an error.
 *
 * The secret is never committed: it lives in the proxy's own directory outside
 * this repository, and `.gitignore` covers the filename in case anyone copies
 * one in.
 */
export function resolveForwardingSecret(
  opts: { env?: NodeJS.ProcessEnv; path?: string } = {},
): string | null {
  const env = opts.env ?? process.env
  const fromEnv = env[FORWARDING_SECRET_ENV]?.trim()
  if (fromEnv) return fromEnv

  const path = opts.path ?? DEFAULT_FORWARDING_SECRET_PATH
  try {
    if (!existsSync(path)) return null
    const fromFile = readFileSync(path, 'utf8').trim()
    return fromFile.length > 0 ? fromFile : null
  } catch {
    // Unreadable is the same as absent: fall back to connecting without
    // forwarding rather than failing to construct an executor.
    return null
  }
}
