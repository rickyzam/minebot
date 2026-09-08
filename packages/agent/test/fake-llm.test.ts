import { describe, it, expect } from 'vitest'
import { FakeLlmClient } from '../src/fake-llm.js'
import { isAbortError } from '../src/llm.js'

const msg = (content: string) => [{ role: 'user' as const, content }]

describe('FakeLlmClient', () => {
  it('returns queued replies in order', async () => {
    const llm = new FakeLlmClient(['first', 'second'])
    expect(await llm.chat({ messages: msg('a') })).toBe('first')
    expect(await llm.chat({ messages: msg('b') })).toBe('second')
  })

  it('records every request it received', async () => {
    const llm = new FakeLlmClient(['x'])
    await llm.chat({ messages: msg('the prompt'), schema: { oneOf: [] } })
    expect(llm.requests).toHaveLength(1)
    expect(llm.requests[0]?.schema).toEqual({ oneOf: [] })
    expect(llm.lastPromptText()).toContain('the prompt')
  })

  // CLAUDE.md: "A fixture that can no-op without shouting is worse than no
  // fixture." An exhausted script must not look like an empty reply — that is
  // a legitimate decode case, and returning '' would turn a script that ran
  // out into a passing test.
  it('throws loudly when the script runs out, rather than returning empty', async () => {
    const llm = new FakeLlmClient(['only one'])
    await llm.chat({ messages: msg('a') })
    await expect(llm.chat({ messages: msg('b') })).rejects.toThrow(/script exhausted after 2/)
  })

  it('repeats the last reply forever when asked, for budget and stuck tests', async () => {
    const llm = new FakeLlmClient(['again'], { repeatLast: true })
    for (let i = 0; i < 5; i++) {
      expect(await llm.chat({ messages: msg('a') })).toBe('again')
    }
  })

  it('rejects with an AbortError when handed an aborted signal', async () => {
    const llm = new FakeLlmClient(['never reached'])
    const ac = new AbortController()
    ac.abort()
    const err = await llm.chat({ messages: msg('a'), signal: ac.signal }).catch((e) => e)
    expect(isAbortError(err)).toBe(true)
    expect(llm.requests).toHaveLength(1)
  })
})
