import { ACTION_NAMES, ACTION_SCHEMA, type ActionName, type ActionRequest } from './actions.js'
import type { ChatMessage, LlmClient } from './llm.js'

/**
 * Why this is not a `FailureReason`: that union is a closed vocabulary about
 * things going wrong in the game world. `invalid_target` means "no such block
 * name", not "the model returned broken JSON". Reusing it would make the two
 * indistinguishable downstream and would quietly widen what the shared
 * contract means (design §6.1).
 */
export interface DecodeError {
  readonly kind: 'empty_reply' | 'not_json' | 'not_an_object' | 'unknown_action' | 'bad_arguments'
  readonly detail: string
}

export type DecodeResult =
  | { readonly ok: true; readonly action: ActionRequest }
  | { readonly ok: false; readonly error: DecodeError }

const MAX_DISTANCE = 128
const MAX_LIMIT = 16
const MAX_CHAT = 256
const MAX_SUMMARY = 512
const Y_MIN = -64
const Y_MAX = 320
const XZ_MAX = 30_000_000
const BARE_NAME = /^[a-z0-9_]+$/

const bad = (kind: DecodeError['kind'], detail: string): DecodeResult => ({
  ok: false,
  error: { kind, detail },
})

const clip = (s: string, n = 120): string =>
  s.length <= n ? s : `${s.slice(0, n)}… (${s.length} chars)`

/** Bare, lowercase, no namespace — the form Mineflayer and `BlockQuery` use. */
const blockName = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const n = v.trim().toLowerCase().replace(/^minecraft:/, '')
  return BARE_NAME.test(n) ? n : null
}

const distance = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_DISTANCE ? v : null

const coord = (v: unknown, lo: number, hi: number): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const n = Math.floor(v)
  return n >= lo && n <= hi ? n : null
}

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 && t.length <= max ? t : null
}

/** Direct parse, then a first-brace-to-last-brace rescue for prose-wrapped JSON. */
const parseLoose = (raw: string): unknown | undefined => {
  try {
    return JSON.parse(raw)
  } catch {
    // fall through to the rescue
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
}

export function decode(raw: string): DecodeResult {
  if (raw.trim().length === 0) return bad('empty_reply', 'the model returned nothing')

  const parsed = parseLoose(raw)
  if (parsed === undefined) return bad('not_json', `could not parse JSON from: ${clip(raw)}`)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const got = Array.isArray(parsed) ? 'an array' : typeof parsed
    return bad('not_an_object', `expected a JSON object, got ${got}`)
  }

  const o = parsed as Record<string, unknown>
  const name = o['action']
  if (typeof name !== 'string' || !(ACTION_NAMES as readonly string[]).includes(name)) {
    return bad('unknown_action', `"${String(name)}" is not one of: ${ACTION_NAMES.join(', ')}`)
  }

  switch (name as ActionName) {
    case 'find_blocks': {
      const rawNames = o['names']
      if (!Array.isArray(rawNames) || rawNames.length === 0) {
        return bad('bad_arguments', 'find_blocks needs a non-empty "names" array')
      }
      const names: string[] = []
      for (const candidate of rawNames) {
        const clean = blockName(candidate)
        if (clean === null) {
          return bad('bad_arguments', `"${String(candidate)}" is not a valid block name`)
        }
        names.push(clean)
      }
      const maxDistance = distance(o['maxDistance'])
      if (maxDistance === null) {
        return bad('bad_arguments', `maxDistance must be a number in (0, ${MAX_DISTANCE}]`)
      }
      const limit = o['limit']
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return bad('bad_arguments', `limit must be an integer in [1, ${MAX_LIMIT}]`)
      }
      return { ok: true, action: { action: 'find_blocks', names, maxDistance, limit } }
    }

    case 'move_to': {
      const x = coord(o['x'], -XZ_MAX, XZ_MAX)
      const y = coord(o['y'], Y_MIN, Y_MAX)
      const z = coord(o['z'], -XZ_MAX, XZ_MAX)
      if (x === null || y === null || z === null) {
        return bad(
          'bad_arguments',
          `move_to needs finite x/z within ±${XZ_MAX} and y in [${Y_MIN}, ${Y_MAX}]`,
        )
      }
      return { ok: true, action: { action: 'move_to', x, y, z } }
    }

    case 'mine_nearest_block': {
      const blockTarget = blockName(o['name'])
      if (blockTarget === null) {
        return bad('bad_arguments', `"${String(o['name'])}" is not a valid block name`)
      }
      const maxDistance = distance(o['maxDistance'])
      if (maxDistance === null) {
        return bad('bad_arguments', `maxDistance must be a number in (0, ${MAX_DISTANCE}]`)
      }
      return { ok: true, action: { action: 'mine_nearest_block', name: blockTarget, maxDistance } }
    }

    case 'mine_block_at': {
      const x = coord(o['x'], -XZ_MAX, XZ_MAX)
      const y = coord(o['y'], Y_MIN, Y_MAX)
      const z = coord(o['z'], -XZ_MAX, XZ_MAX)
      if (x === null || y === null || z === null) {
        return bad(
          'bad_arguments',
          `mine_block_at needs finite x/z within ±${XZ_MAX} and y in [${Y_MIN}, ${Y_MAX}]`,
        )
      }
      const maxDistance = distance(o['maxDistance'])
      if (maxDistance === null) {
        return bad('bad_arguments', `maxDistance must be a number in (0, ${MAX_DISTANCE}]`)
      }
      return { ok: true, action: { action: 'mine_block_at', x, y, z, maxDistance } }
    }

    case 'chat': {
      const message = text(o['message'], MAX_CHAT)
      if (message === null) {
        return bad('bad_arguments', `message must be non-empty and at most ${MAX_CHAT} characters`)
      }
      return { ok: true, action: { action: 'chat', message } }
    }

    case 'done': {
      const summary = text(o['summary'], MAX_SUMMARY)
      if (summary === null) return bad('bad_arguments', 'summary must be a non-empty string')
      return { ok: true, action: { action: 'done', summary } }
    }

    case 'give_up': {
      const reason = text(o['reason'], MAX_SUMMARY)
      if (reason === null) return bad('bad_arguments', 'reason must be a non-empty string')
      return { ok: true, action: { action: 'give_up', reason } }
    }
  }
}

// ---------- The mechanism seam ----------

export type DecideResult =
  | { readonly ok: true; readonly action: ActionRequest; readonly raw: string }
  | { readonly ok: false; readonly error: DecodeError; readonly raw: string }

/**
 * How one action is obtained from the model. `SchemaDecider` is the only
 * implementation, and design §5 records the measurement that closed the
 * alternative. This stays an interface because `runGoal` needs something
 * injectable — the `llm_error` test hands it a decider that throws, which a
 * concrete class cannot express.
 */
export interface Decider {
  decide(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<DecideResult>
}

export class SchemaDecider implements Decider {
  private readonly llm: LlmClient

  constructor(llm: LlmClient) {
    this.llm = llm
  }

  async decide(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<DecideResult> {
    const first = await this.llm.chat({ messages, schema: ACTION_SCHEMA, signal })
    const decoded = decode(first)
    if (decoded.ok) return { ok: true, action: decoded.action, raw: first }

    // Exactly one repair. The two extra messages are scoped to this retry and
    // discarded with it — the next turn rebuilds the prompt from a fresh
    // snapshot, so no transcript accumulates (design §3, §6.2).
    const repaired = await this.llm.chat({
      messages: [
        ...messages,
        { role: 'assistant', content: first },
        {
          role: 'user',
          content:
            `That reply was rejected (${decoded.error.kind}): ${decoded.error.detail}\n` +
            'Reply with one valid action object and nothing else.',
        },
      ],
      schema: ACTION_SCHEMA,
      signal,
    })
    const second = decode(repaired)
    return second.ok
      ? { ok: true, action: second.action, raw: repaired }
      : { ok: false, error: second.error, raw: repaired }
  }
}
