import { describe, it, expect } from 'vitest'
import { decode, SchemaDecider } from '../src/decide.js'
import { FakeLlmClient } from '../src/fake-llm.js'
import { ACTION_SCHEMA } from '../src/actions.js'

const expectOk = (raw: string) => {
  const r = decode(raw)
  if (!r.ok) throw new Error(`expected ok, got ${r.error.kind}: ${r.error.detail}`)
  return r.action
}
const expectBad = (raw: string) => {
  const r = decode(raw)
  if (r.ok) throw new Error(`expected failure, got ${JSON.stringify(r.action)}`)
  return r.error
}

describe('decode — accepted replies', () => {
  it('reads a find_blocks action', () => {
    expect(
      expectOk('{"action":"find_blocks","names":["coal_ore"],"maxDistance":32,"limit":5}'),
    ).toEqual({ action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 })
  })

  it('reads each of the other six actions', () => {
    expect(expectOk('{"action":"move_to","x":1,"y":64,"z":-3}')).toEqual({
      action: 'move_to', x: 1, y: 64, z: -3,
    })
    expect(
      expectOk('{"action":"mine_nearest_block","name":"coal_ore","maxDistance":16}'),
    ).toEqual({ action: 'mine_nearest_block', name: 'coal_ore', maxDistance: 16 })
    expect(
      expectOk('{"action":"mine_block_at","x":18,"y":60,"z":-34,"maxDistance":32}'),
    ).toEqual({ action: 'mine_block_at', x: 18, y: 60, z: -34, maxDistance: 32 })
    expect(expectOk('{"action":"chat","message":"hi"}')).toEqual({
      action: 'chat', message: 'hi',
    })
    expect(expectOk('{"action":"done","summary":"got the coal"}')).toEqual({
      action: 'done', summary: 'got the coal',
    })
    expect(expectOk('{"action":"give_up","reason":"no pickaxe available"}')).toEqual({
      action: 'give_up', reason: 'no pickaxe available',
    })
  })

  // Constrained decoding should prevent this, but a model that ignores the
  // constraint must not take the run down with it.
  it('digs the object out of surrounding prose', () => {
    expect(
      expectOk('Sure! Here you go:\n{"action":"done","summary":"ok"}\nHope that helps.'),
    ).toEqual({ action: 'done', summary: 'ok' })
  })

  // Mineflayer block names are bare; a model trained on Minecraft data emits
  // the namespaced form constantly. Normalising costs two lines; rejecting
  // costs a turn (design §6).
  it('strips a minecraft: namespace and lowercases', () => {
    expect(
      expectOk('{"action":"mine_nearest_block","name":"Minecraft:Coal_Ore","maxDistance":8}'),
    ).toEqual({ action: 'mine_nearest_block', name: 'coal_ore', maxDistance: 8 })
  })

  it('floors fractional coordinates rather than rejecting them', () => {
    expect(expectOk('{"action":"move_to","x":1.7,"y":64.2,"z":-3.9}')).toEqual({
      action: 'move_to', x: 1, y: 64, z: -4,
    })
  })
})

describe('decode — rejected replies', () => {
  it('reports an empty reply distinctly', () => {
    expect(expectBad('   ').kind).toBe('empty_reply')
  })

  it('reports unparseable text', () => {
    expect(expectBad('I think I should mine some coal.').kind).toBe('not_json')
  })

  it('reports a non-object', () => {
    expect(expectBad('[1, 2, 3]').kind).toBe('not_an_object')
  })

  it('reports an action name outside the menu', () => {
    const e = expectBad('{"action":"craft","item":"torch"}')
    expect(e.kind).toBe('unknown_action')
    expect(e.detail).toContain('find_blocks')
  })

  it('rejects the Phase 5 stubs by name', () => {
    expect(expectBad('{"action":"attack","entityId":7}').kind).toBe('unknown_action')
  })

  it.each([
    ['missing field', '{"action":"move_to","x":1,"y":64}'],
    ['wrong type', '{"action":"chat","message":42}'],
    ['empty message', '{"action":"chat","message":"   "}'],
    ['over-long message', `{"action":"chat","message":"${'x'.repeat(300)}"}`],
    ['zero distance', '{"action":"mine_nearest_block","name":"coal_ore","maxDistance":0}'],
    ['negative distance', '{"action":"find_blocks","names":["coal_ore"],"maxDistance":-5,"limit":3}'],
    ['distance past the cap', '{"action":"find_blocks","names":["coal_ore"],"maxDistance":999,"limit":3}'],
    ['limit past the cap', '{"action":"find_blocks","names":["coal_ore"],"maxDistance":32,"limit":900}'],
    ['empty names', '{"action":"find_blocks","names":[],"maxDistance":32,"limit":3}'],
    ['punctuated block name', '{"action":"mine_nearest_block","name":"coal ore!","maxDistance":8}'],
    ['y below the world', '{"action":"move_to","x":0,"y":-500,"z":0}'],
    ['non-finite coordinate', '{"action":"move_to","x":0,"y":null,"z":0}'],
    ['empty summary', '{"action":"done","summary":""}'],
    ['empty give_up reason', '{"action":"give_up","reason":"  "}'],
  ])('rejects %s', (_label, raw) => {
    expect(expectBad(raw).kind).toBe('bad_arguments')
  })

  it('says specifically what was wrong, so the repair prompt can quote it', () => {
    expect(expectBad('{"action":"find_blocks","names":["coal_ore"],"maxDistance":999,"limit":3}').detail)
      .toContain('maxDistance')
  })
})

describe('SchemaDecider', () => {
  const messages = [{ role: 'user' as const, content: 'go' }]

  it('constrains the request with the action schema', async () => {
    const llm = new FakeLlmClient(['{"action":"done","summary":"ok"}'])
    await new SchemaDecider(llm).decide(messages)
    expect(llm.requests[0]?.schema).toBe(ACTION_SCHEMA)
  })

  it('returns the decoded action and the raw reply', async () => {
    const llm = new FakeLlmClient(['{"action":"done","summary":"ok"}'])
    const r = await new SchemaDecider(llm).decide(messages)
    expect(r.ok && r.action).toEqual({ action: 'done', summary: 'ok' })
    expect(r.raw).toContain('summary')
  })

  it('repairs once, quoting what was wrong', async () => {
    const llm = new FakeLlmClient(['not json at all', '{"action":"done","summary":"second try"}'])
    const r = await new SchemaDecider(llm).decide(messages)
    expect(r.ok && r.action).toEqual({ action: 'done', summary: 'second try' })
    expect(llm.requests).toHaveLength(2)
    expect(llm.lastPromptText()).toContain('not_json')
  })

  // Design §3/§6.2: the repair message is scoped to the retry. Nothing about
  // it may survive into the next turn, because the loop rebuilds the prompt
  // from a fresh snapshot each time.
  it('does not repair more than once', async () => {
    const llm = new FakeLlmClient(['nope', 'still nope'])
    const r = await new SchemaDecider(llm).decide(messages)
    expect(r.ok).toBe(false)
    expect(llm.requests).toHaveLength(2)
  })

  it('passes the abort signal through to the model call', async () => {
    const llm = new FakeLlmClient(['unused'])
    const ac = new AbortController()
    ac.abort()
    await expect(new SchemaDecider(llm).decide(messages, ac.signal)).rejects.toThrow()
    expect(llm.requests[0]?.signal).toBe(ac.signal)
  })
})
