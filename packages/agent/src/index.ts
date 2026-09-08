export { ACTION_MENU, ACTION_NAMES, ACTION_SCHEMA, positionOf } from './actions.js'
export type { ActionName, ActionRequest } from './actions.js'

export { abortError, isAbortError } from './llm.js'
export type { ChatMessage, ChatRequest, LlmClient } from './llm.js'

export { FakeLlmClient } from './fake-llm.js'
export type { FakeLlmOptions } from './fake-llm.js'

export { OllamaClient, DEFAULT_HOST, DEFAULT_MODEL } from './ollama.js'
export type { OllamaOptions } from './ollama.js'

export { decode, SchemaDecider } from './decide.js'
export type { DecodeError, DecodeResult, DecideResult, Decider } from './decide.js'

export {
  HISTORY_WINDOW,
  renderAction,
  renderOutcome,
  renderPrompt,
  renderSnapshot,
  renderStep,
} from './prompt.js'
export type { GoalOutcome, GoalStatus, Step, StepOutcome } from './step.js'

export { dispatch } from './dispatch.js'
export {
  runGoal,
  DEFAULT_MAX_STEPS,
  DEFAULT_STUCK_THRESHOLD,
  DEFAULT_MAX_UNDECODABLE,
} from './loop.js'
export type { RunGoalOptions } from './loop.js'
