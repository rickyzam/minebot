import { describe, it, expect } from 'vitest'
import { OllamaClient } from '../src/ollama.js'
import { ACTION_SCHEMA } from '../src/actions.js'

const messages = [{ role: 'user' as const, content: 'hello' }]

const recordingFetch = (body: unknown, status = 200) => {
  const seen: { url: string; init: RequestInit }[] = []
  const impl = (async (url: unknown, init: unknown) => {
    seen.push({ url: String(url), init: init as RequestInit })
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'Test',
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }) as unknown as typeof fetch
  return { impl, seen }
}

const parseBody = (init: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init.body)) as Record<string, unknown>

describe('OllamaClient request shape', () => {
  it('posts to /api/chat on the configured host', async () => {
    const { impl, seen } = recordingFetch({ message: { content: '{}' } })
    await new OllamaClient({ host: 'http://box:11434/', fetchImpl: impl }).chat({ messages })
    expect(seen[0]?.url).toBe('http://box:11434/api/chat')
    expect(seen[0]?.init.method).toBe('POST')
  })

  // Design §5.1 and design spec §8.1: measured, thinking mode costs 20x the
  // latency and makes decisions worse. Temperature 0 because this is
  // classification over a fixed menu, not generation.
  it('disables thinking, streaming and sampling', async () => {
    const { impl, seen } = recordingFetch({ message: { content: '{}' } })
    await new OllamaClient({ model: 'qwen3:14b', fetchImpl: impl }).chat({ messages })
    const body = parseBody(seen[0]!.init)
    expect(body['model']).toBe('qwen3:14b')
    expect(body['stream']).toBe(false)
    expect(body['think']).toBe(false)
    expect(body['options']).toEqual({ temperature: 0 })
  })

  it('sends the schema as `format` when one is given, and omits it otherwise', async () => {
    const withSchema = recordingFetch({ message: { content: '{}' } })
    await new OllamaClient({ fetchImpl: withSchema.impl }).chat({ messages, schema: ACTION_SCHEMA })
    expect(parseBody(withSchema.seen[0]!.init)['format']).toEqual(ACTION_SCHEMA)

    const without = recordingFetch({ message: { content: '{}' } })
    await new OllamaClient({ fetchImpl: without.impl }).chat({ messages })
    expect(parseBody(without.seen[0]!.init)).not.toHaveProperty('format')
  })

  it('forwards the abort signal to fetch', async () => {
    const { impl, seen } = recordingFetch({ message: { content: '{}' } })
    const ac = new AbortController()
    await new OllamaClient({ fetchImpl: impl }).chat({ messages, signal: ac.signal })
    expect(seen[0]?.init.signal).toBe(ac.signal)
  })

  it('returns the reply content', async () => {
    const { impl } = recordingFetch({ message: { content: '{"action":"done","summary":"ok"}' } })
    expect(await new OllamaClient({ fetchImpl: impl }).chat({ messages })).toBe(
      '{"action":"done","summary":"ok"}',
    )
  })

  it('returns an empty string when the server sends no content', async () => {
    const { impl } = recordingFetch({ message: {} })
    expect(await new OllamaClient({ fetchImpl: impl }).chat({ messages })).toBe('')
  })

  it('throws with the status and body on a non-2xx response', async () => {
    const { impl } = recordingFetch({ error: 'model not found' }, 404)
    await expect(new OllamaClient({ fetchImpl: impl }).chat({ messages })).rejects.toThrow(
      /404.*model not found/s,
    )
  })
})
