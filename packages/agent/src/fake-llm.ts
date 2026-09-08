import { abortError, type ChatRequest, type LlmClient } from './llm.js'

export interface FakeLlmOptions {
  /**
   * Keep returning the final queued reply instead of throwing once the script
   * runs out. For the budget-exhaustion and stuck-guard tests, which need an
   * endless supply of the same answer.
   */
  readonly repeatLast?: boolean
}

/**
 * A scripted stand-in for a model. The only `LlmClient` any test uses, which
 * is what keeps `npm test` free of sockets.
 */
export class FakeLlmClient implements LlmClient {
  readonly requests: ChatRequest[] = []

  private readonly queue: string[]
  private readonly repeatLast: boolean
  private last: string | null = null

  constructor(replies: readonly string[], opts: FakeLlmOptions = {}) {
    this.queue = [...replies]
    this.repeatLast = opts.repeatLast ?? false
  }

  async chat(req: ChatRequest): Promise<string> {
    this.requests.push(req)
    if (req.signal?.aborted) throw abortError()

    const next = this.queue.shift()
    if (next !== undefined) {
      this.last = next
      return next
    }
    if (this.repeatLast && this.last !== null) return this.last

    // Loud on purpose — see the test.
    throw new Error(
      `FakeLlmClient: script exhausted after ${this.requests.length} request(s). ` +
        'Queue more replies, or pass { repeatLast: true } if the test needs an endless supply.',
    )
  }

  /** Every message of the most recent request, joined. For prompt assertions. */
  lastPromptText(): string {
    const req = this.requests[this.requests.length - 1]
    return req ? req.messages.map((m) => m.content).join('\n') : ''
  }
}
