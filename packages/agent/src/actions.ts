import type { Vec3 } from '@minebot/contract'

/**
 * What the model is allowed to choose. Deliberately NOT a mirror of
 * `BotExecutor` — see design §4:
 *
 * - `find_blocks` exists because `WorldSnapshot` carries no blocks at all
 *   (a 16-chunk radius is ~10^5 of them), so the only way to learn where a
 *   block is, is to ask.
 * - Mining is two actions rather than one `string | Vec3` target, so every
 *   schema branch stays a flat object and the schema has exactly one union.
 *   `dispatch.ts` collapses them back onto the single contract method.
 * - `done` has no executor counterpart. Without it a run could only ever end
 *   by exhausting its step budget.
 */
export type ActionRequest =
  | {
      readonly action: 'find_blocks'
      readonly names: readonly string[]
      readonly maxDistance: number
      readonly limit: number
    }
  | { readonly action: 'move_to'; readonly x: number; readonly y: number; readonly z: number }
  | { readonly action: 'mine_nearest_block'; readonly name: string; readonly maxDistance: number }
  | {
      readonly action: 'mine_block_at'
      readonly x: number
      readonly y: number
      readonly z: number
      readonly maxDistance: number
    }
  | { readonly action: 'chat'; readonly message: string }
  | { readonly action: 'done'; readonly summary: string }
  /**
   * The model's way of saying the goal cannot be reached. Probing showed it
   * otherwise chatting "I need a pickaxe" and then grinding to the step
   * budget, an outcome indistinguishable from the loop malfunctioning
   * (design §4.0). Kept separate from `done` rather than folded in with a
   * flag: `done` is chosen reliably, and muddying it risks that.
   */
  | { readonly action: 'give_up'; readonly reason: string }

export type ActionName = ActionRequest['action']

export const ACTION_NAMES = [
  'find_blocks',
  'move_to',
  'mine_nearest_block',
  'mine_block_at',
  'chat',
  'done',
  'give_up',
] as const satisfies readonly ActionName[]

export const positionOf = (a: {
  readonly x: number
  readonly y: number
  readonly z: number
}): Vec3 => ({ x: a.x, y: a.y, z: a.z })

// A single-valued `enum` rather than `const`: both are legal JSON Schema, but
// `enum` is the form every schema-to-grammar converter supports, and this
// schema's whole job is to be converted into a decoding grammar.
const named = (name: ActionName) => ({ enum: [name] as const })
const coordinate = { type: 'number' } as const

export const ACTION_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        action: named('find_blocks'),
        names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
        maxDistance: { type: 'number' },
        limit: { type: 'integer' },
      },
      required: ['action', 'names', 'maxDistance', 'limit'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { action: named('move_to'), x: coordinate, y: coordinate, z: coordinate },
      required: ['action', 'x', 'y', 'z'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        action: named('mine_nearest_block'),
        name: { type: 'string' },
        maxDistance: { type: 'number' },
      },
      required: ['action', 'name', 'maxDistance'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        action: named('mine_block_at'),
        x: coordinate,
        y: coordinate,
        z: coordinate,
        maxDistance: { type: 'number' },
      },
      required: ['action', 'x', 'y', 'z', 'maxDistance'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { action: named('chat'), message: { type: 'string' } },
      required: ['action', 'message'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { action: named('done'), summary: { type: 'string' } },
      required: ['action', 'summary'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { action: named('give_up'), reason: { type: 'string' } },
      required: ['action', 'reason'],
      additionalProperties: false,
    },
  ],
} as const

/** The human-readable menu, rendered into the system prompt. */
export const ACTION_MENU = [
  'find_blocks         {"action":"find_blocks","names":["coal_ore","deepslate_coal_ore"],"maxDistance":32,"limit":5}',
  '                    Search for blocks by name, nearest first. This is the ONLY way',
  '                    to learn where blocks are — they are not in the state above.',
  'move_to             {"action":"move_to","x":18,"y":60,"z":-34}',
  '                    Walk to a coordinate.',
  'mine_nearest_block  {"action":"mine_nearest_block","name":"coal_ore","maxDistance":32}',
  '                    Mine the nearest matching block. Use only when you have not searched.',
  'mine_block_at       {"action":"mine_block_at","x":18,"y":60,"z":-34,"maxDistance":32}',
  '                    Mine one exact block. Prefer this after find_blocks.',
  'chat                {"action":"chat","message":"hello"}',
  '                    Say something in game chat.',
  'done                {"action":"done","summary":"mined one coal ore"}',
  '                    The goal is achieved. This ends the run.',
  'give_up             {"action":"give_up","reason":"no pickaxe and no way to get one"}',
  '                    The goal cannot be reached. Say why. This ends the run.',
].join('\n')
