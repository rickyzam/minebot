import type { ChatRequest, LlmClient } from './llm.js'

export const DEFAULT_HOST = 'http://127.0.0.1:11434'
export const DEFAULT_MODEL = 'qwen3:14b'

export interface OllamaOptions {
  /** Defaults to `$OLLAMA_HOST`, then {@link DEFAULT_HOST}. */
  readonly host?: string
  /** Defaults to `$MINEBOT_MODEL`, then {@link DEFAULT_MODEL}. */
  readonly model?: string
  readonly temperature?: number
  readonly think?: boolean
  /** Injected so the request shape can be asserted without a socket. */
  readonly fetchImpl?: typeof fetch
}

interface OllamaChatResponse {
  message?: { content?: string }
}

/**
 * The only module in this package that opens a socket, and the only one no
 * test exercises end to end. `probe.ts` is where it meets a real model, and
 * design §2.1 records what that measured.
 */
export class OllamaClient implements LlmClient {
  readonly host: string
  readonly model: string

  private readonly temperature: number
  private readonly think: boolean
  private readonly fetchImpl: typeof fetch

  constructor(opts: OllamaOptions = {}) {
    this.host = (opts.host ?? process.env['OLLAMA_HOST'] ?? DEFAULT_HOST).replace(/\/+$/, '')
    this.model = opts.model ?? process.env['MINEBOT_MODEL'] ?? DEFAULT_MODEL
    this.temperature = opts.temperature ?? 0
    // Thinking off. Measured at 20x the latency (7641ms vs 370ms) and worse
    // decisions — it chose a redundant move_to in 4 of 5 samples on a turn
    // think:false got right every time (design §2.1, §5.1).
    this.think = opts.think ?? false
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  buildBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      think: this.think,
      options: { temperature: this.temperature },
    }
    if (req.schema !== undefined) body['format'] = req.schema
    return body
  }

  async chat(req: ChatRequest): Promise<string> {
    const res = await this.fetchImpl(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.buildBody(req)),
      signal: req.signal,
    })

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300)
      throw new Error(`Ollama ${res.status} ${res.statusText}: ${detail}`)
    }

    const parsed = (await res.json()) as OllamaChatResponse
    return parsed.message?.content ?? ''
  }
}
