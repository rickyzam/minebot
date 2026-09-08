import type { EntityInfo, ItemStack, Vec3, WorldSnapshot } from '@minebot/contract'
import { ACTION_MENU, type ActionRequest } from './actions.js'
import type { ChatMessage } from './llm.js'
import type { Step, StepOutcome } from './step.js'

/**
 * How many past steps reach the prompt. The full log is kept for the outcome;
 * only this tail is rendered, so prompt size stays flat however long a goal
 * runs (design §7.1).
 */
export const HISTORY_WINDOW = 8

const vec = (v: Vec3): string => `(${v.x}, ${v.y}, ${v.z})`
const dist = (d: number): string => d.toFixed(1)

export const renderAction = (a: ActionRequest): string => {
  switch (a.action) {
    case 'find_blocks':
      return `find_blocks(${a.names.join(', ')} within ${a.maxDistance})`
    case 'move_to':
      return `move_to${vec(a)}`
    case 'mine_nearest_block':
      return `mine_nearest_block(${a.name} within ${a.maxDistance})`
    case 'mine_block_at':
      return `mine_block_at${vec(a)}`
    case 'chat':
      return `chat(${JSON.stringify(a.message)})`
    case 'done':
      return `done(${JSON.stringify(a.summary)})`
    case 'give_up':
      return `give_up(${JSON.stringify(a.reason)})`
  }
}

/**
 * `mineBlock` resolves ok with `collected: false` when the block was mined but
 * its drop could not be retrieved. That is a success the contract deliberately
 * refuses to report as a failure, so the model has to see the distinction.
 */
const describeValue = (v: unknown): string => {
  if (v !== null && typeof v === 'object' && 'collected' in v) {
    return ` (drop collected: ${String((v as { collected: unknown }).collected)})`
  }
  return ''
}

export const renderOutcome = (o: StepOutcome): string => {
  switch (o.kind) {
    case 'blocks':
      if (o.blocks.length === 0) return 'none found'
      return `${o.blocks.length} found: ${o.blocks
        .map((b) => `${b.name} at ${vec(b.position)}, ${dist(b.distance)} away`)
        .join('; ')}`
    case 'result':
      return o.result.ok
        ? `OK${describeValue(o.result.value)}`
        : `FAILED (${o.result.reason}): ${o.result.detail || 'no detail given'}`
    case 'undecodable':
      return 'your reply could not be used'
    case 'done':
      return 'goal declared complete'
    case 'gave_up':
      return 'goal declared unreachable'
  }
}

export const renderStep = (s: Step): string => {
  const what = s.action ? renderAction(s.action) : 'invalid reply'
  const why = s.decodeError ? ` [${s.decodeError.kind}: ${s.decodeError.detail}]` : ''
  return `  ${s.n}. ${what} -> ${renderOutcome(s.outcome)}${why}`
}

const renderItem = (i: ItemStack): string => `${i.name} x${i.count}`

const renderEntity = (e: EntityInfo): string =>
  `${e.name} (${e.kind}) at ${vec(e.position)}, ${dist(e.distance)} away`

export const renderSnapshot = (s: WorldSnapshot): string => {
  const { self } = s
  return [
    `Position: ${vec(self.position)}   Dimension: ${self.dimension}   On ground: ${self.onGround ? 'yes' : 'no'}`,
    `Health: ${self.health}/20   Food: ${self.food}/20`,
    `Inventory: ${self.inventory.length === 0 ? '(empty)' : self.inventory.map(renderItem).join(', ')}`,
    `Holding: ${self.heldItem ? renderItem(self.heldItem) : '(nothing)'}`,
    `Nearby entities: ${
      s.nearbyEntities.length === 0 ? 'none' : s.nearbyEntities.map(renderEntity).join('; ')
    }`,
  ].join('\n')
}

const SYSTEM = [
  "You control a Minecraft bot. Each turn you are shown the bot's current state and",
  'what happened recently. Choose exactly ONE action and reply with a single JSON',
  'object and nothing else.',
  '',
  'Rules:',
  '- Blocks are NOT listed in the state. find_blocks is the only way to locate one.',
  '- After find_blocks, mine the exact block you found with mine_block_at.',
  '- If an action failed, read the reason before choosing again. Repeating an action',
  '  that just failed the same way will not help.',
  '- "OK (drop collected: false)" means the block IS broken and its item is lying on',
  '  the ground at that position. Mining it again will fail — there is nothing left to',
  '  mine. Use move_to that position ONCE to walk over the item and pick it up.',
  '- If you have ALREADY moved to that position and the item is still not in your',
  '  inventory, the drop is gone for good and that position is finished. The same is',
  '  true once mining it returns not_found. Do NOT move to or mine that position',
  '  again — it cannot help. Search elsewhere with find_blocks, or give_up.',
  '- Choose done as soon as the goal is met.',
  '- chat does NOT end the run and nobody is guaranteed to answer it. If you cannot',
  '  make progress with the actions above, choose give_up and say why.',
  '',
  'Actions:',
  ACTION_MENU,
].join('\n')

/**
 * Built fresh every turn rather than appended to a transcript. Token cost stays
 * flat, and — more importantly — a transcript would carry stale world state the
 * model can anchor on. After the reflex layer has fled a mob, the bot's old
 * position is a lie (design §3, §8).
 */
export const renderPrompt = (
  goal: string,
  snapshot: WorldSnapshot,
  steps: readonly Step[],
): ChatMessage[] => {
  const window = steps.slice(-HISTORY_WINDOW)
  const history =
    window.length === 0
      ? 'Recent actions: (none yet)'
      : ['Recent actions:', ...window.map(renderStep)].join('\n')

  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [`Goal: ${goal}`, '', renderSnapshot(snapshot), '', history].join('\n'),
    },
  ]
}
