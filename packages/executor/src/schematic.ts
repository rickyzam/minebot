/**
 * Schematic loading and placement ordering — pure, no I/O, no mineflayer.
 *
 * A schematic is a developer-supplied JSON description of a small structure:
 * a name and a list of blocks, each at an integer offset from an origin that
 * `buildSchematic` (Task 5b) supplies later. This module only decides *what*
 * the structure is and *in what order* its blocks must be placed — it never
 * touches a world.
 *
 * `parseSchematic` throws rather than returning a `Result`, deliberately:
 * unlike model output, a schematic file is developer-supplied. A `Result`
 * here would only be unwrapped and thrown by its caller anyway, so the
 * indirection buys nothing and costs a call site.
 */

/** One block in a schematic, positioned relative to the structure's origin. */
export interface SchematicBlock {
  readonly dx: number
  readonly dy: number
  readonly dz: number
  readonly block: string
}

/** A small structure: a name for diagnostics, and its blocks. */
export interface Schematic {
  readonly name: string
  readonly blocks: readonly SchematicBlock[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function parseBlock(entry: unknown, index: number): SchematicBlock {
  const label = `blocks[${index}]`
  if (!isPlainObject(entry)) {
    throw new Error(`invalid schematic: ${label} must be an object, got ${describe(entry)}`)
  }
  for (const field of ['dx', 'dy', 'dz'] as const) {
    if (!isFiniteInteger(entry[field])) {
      throw new Error(
        `invalid schematic: ${label}.${field} must be an integer, got ${describe(entry[field])}`,
      )
    }
  }
  if (typeof entry.block !== 'string' || entry.block.length === 0) {
    throw new Error(
      `invalid schematic: ${label}.block must be a non-empty string, got ${describe(entry.block)}`,
    )
  }
  return {
    dx: entry.dx as number,
    dy: entry.dy as number,
    dz: entry.dz as number,
    block: entry.block,
  }
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN'
  return JSON.stringify(value)
}

/**
 * Parse untrusted JSON into a trusted `Schematic`, throwing with a message
 * naming the offending entry (`name`, `blocks`, or `blocks[i]` / `blocks[i].field`)
 * on any shape error.
 */
export function parseSchematic(json: unknown): Schematic {
  if (!isPlainObject(json)) {
    throw new Error(`invalid schematic: expected an object, got ${describe(json)}`)
  }
  if (typeof json.name !== 'string' || json.name.length === 0) {
    throw new Error(`invalid schematic: name must be a non-empty string, got ${describe(json.name)}`)
  }
  if (!Array.isArray(json.blocks)) {
    throw new Error(`invalid schematic: blocks must be an array, got ${describe(json.blocks)}`)
  }
  const blocks = json.blocks.map((entry, index) => parseBlock(entry, index))
  return { name: json.name, blocks }
}

/**
 * Order a schematic's blocks so each has support when placed: ascending by
 * `dy` (bottom layer first), then `dx`, then `dz` within a layer so the
 * order is deterministic rather than merely "some valid sort". Pure — returns
 * a new array and never mutates `s` or `s.blocks`.
 */
export function placementOrder(s: Schematic): readonly SchematicBlock[] {
  return [...s.blocks].sort((a, b) => a.dy - b.dy || a.dx - b.dx || a.dz - b.dz)
}
