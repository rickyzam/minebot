/** One message in a prompt. */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[]
  /** JSON Schema the reply must satisfy. Ollama's `format` field. */
  readonly schema?: unknown
  readonly signal?: AbortSignal
}

/**
 * Returns the reply text. A bare string, because design §5 resolved the
 * mechanism question by measurement — schema-constrained output beat native
 * tool-calling 25/25 to 20/25 — so there is no structured tool-call payload
 * to carry, and no reason to shape the type around one.
 */
export interface LlmClient {
  chat(req: ChatRequest): Promise<string>
}

/**
 * The rejection an aborted model call produces. `fetch` rejects with an error
 * whose `.name` is `'AbortError'`; the fake matches it so the loop's
 * cancellation path is exercised by tests rather than only in production.
 * Discriminating on `.name` is the same technique Track A uses for
 * pathfinder errors.
 */
export const abortError = (): Error => {
  const e = new Error('the model call was aborted')
  e.name = 'AbortError'
  return e
}

export const isAbortError = (e: unknown): boolean =>
  e instanceof Error && e.name === 'AbortError'
