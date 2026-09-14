/**
 * The reflex arbiter: a `BotExecutor` decorator that lets the reflex layer beat
 * the plan (design §3.5, Phase 5 spec §2).
 *
 * It subscribes to the inner executor's events, and when `evaluateReflex` fires
 * it aborts whatever is in flight, runs its own recovery (`attack` or `flee`),
 * and hands the caller back `interrupted`. The planning loop already re-plans
 * on an `interrupted` result that had no outer abort (`packages/agent/src/
 * loop.ts`), so nothing above this layer needs to know it exists.
 *
 * This is concurrency code, and v1 of the plan got it wrong five ways by
 * describing it in prose. The rules, explicitly:
 *
 * **Priority.** Nothing = 0, attack = 1, flee = 2. A trigger acts only when its
 * priority is strictly higher than what currently occupies the reflex: the
 * running recovery, or a caller-issued `attack` (1) / `flee` (2) still in
 * flight. Same-or-lower is ignored and records nothing — so a planner's attack
 * is never aborted to run the reflex's own attack, but a flee still preempts
 * it, and a flee still supersedes an attack recovery already running. A single
 * boolean latch cannot express that escalation, which is how v1's bot died
 * mid-attack.
 *
 * **The latch is set at abort time**, synchronously in the event handler, not
 * when the recovery starts. Three synchronous `damaged` events must produce one
 * recovery, not three.
 *
 * **The recovery starts one microtask later** and checks its own controller
 * before touching the inner executor, so a `stop()` or a supersede in the same
 * synchronous turn cancels it before anything is issued.
 *
 * **A recovery releases the latch only if the latch is still its own.** An
 * attack recovery superseded by a flee must not clear the flee's latch.
 *
 * **A preempted action returns `interrupted` after the recovery finishes**,
 * with a detail naming the reflex and the trigger, even if the inner action
 * managed to resolve `ok` — the recovery moved the bot, and `ok` would let the
 * planner continue from a stale snapshot. The caller's own abort is the
 * exception: it returns at once.
 *
 * **A caller abort never cancels a recovery.** Cancelling a goal is a plan
 * decision, and the recovery may be the flee keeping the bot alive: reflex
 * beats plan. Only `stop()` and `disconnect()` cancel one.
 *
 * **An action that starts while a recovery is running waits for it, then
 * returns `interrupted` without ever running.** It was chosen from a snapshot
 * taken before the recovery moved the bot; run, it could walk straight back to
 * the hostile, and `ok` would stop the planner re-observing. The exception is
 * a caller action that outranks the recovery — in practice a caller `flee`
 * during an attack recovery. It supersedes the recovery and runs, because
 * waiting would hand back a flee that never fled.
 *
 * **`stop()` wins.** It cancels the recovery, halts every action, and
 * suppresses the reflex until the next wrapped action starts.
 *
 * **`disconnect()` cancels the recovery** before delegating. An inner action
 * need not notice the connection going away, and must not run on against it.
 *
 * **Repeated failure disarms that kind, not the reflex.** Failures are counted
 * per trigger kind: after `maxConsecutiveFailures` attack recoveries fail in a
 * row, attack triggers are ignored until an attack succeeds or nothing
 * triggers, and likewise for flee. A string of failed attacks never stops a
 * flee — the cap stops futile repetition, it does not veto a different safety
 * action. A recovery cancelled by a supersede, `stop()` or `disconnect()` is
 * neither a success nor a failure and does not count.
 */
import {
  fail,
  type ActionOptions,
  type BlockInfo,
  type BlockQuery,
  type BotEvents,
  type BotExecutor,
  type ExplorationReport,
  type ExploreOptions,
  type Result,
  type Unsubscribe,
  type Vec3,
  type WorldSnapshot,
} from '@minebot/contract'
import { evaluateReflex, type ReflexThresholds, type ReflexTrigger } from './reflex.js'

export interface ReflexPreemption {
  readonly trigger: ReflexTrigger
  /** `Date.now()` when the trigger fired. */
  readonly at: number
  /** The caller action preempted, or `'idle'` when nothing was in flight. */
  readonly action: string
  /**
   * What the recovery actually returned. `null` while it is still running —
   * the record is live, and this field is filled in on the same object when
   * the recovery settles.
   */
  readonly recovery: Result<unknown> | null
}

export interface ReflexExecutorOptions {
  readonly thresholds?: Partial<ReflexThresholds>
  /**
   * Called synchronously when a trigger fires, before the recovery has run
   * (so `recovery` is `null`). Exceptions are swallowed.
   */
  readonly onPreempt?: (p: ReflexPreemption) => void
  /** Bounds a recovery so it cannot inherit an action's 30s default. */
  readonly recoveryTimeoutMs?: number
  /**
   * After this many consecutive failed recoveries of one kind, ignore triggers
   * of that kind. Counted per kind, so failed attacks never disarm flee.
   */
  readonly maxConsecutiveFailures?: number
}

/**
 * Chosen here, not agreed anywhere: neither the plan nor the spec gives a
 * value. An attack is one swing; flee's distance and timeout are still open
 * (Phase 5 spec §7), so this is deliberately generous.
 */
const DEFAULT_RECOVERY_TIMEOUT_MS = 10_000
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3

/** 0 is an ordinary action or nothing at all; 1 and 2 are attack and flee. */
type Priority = 0 | 1 | 2
const priorityOf = (t: ReflexTrigger): 1 | 2 => (t.kind === 'flee' ? 2 : 1)

type LivePreemption = { -readonly [K in keyof ReflexPreemption]: ReflexPreemption[K] }

interface Recovery {
  readonly controller: AbortController
  readonly priority: 1 | 2
  readonly preemption: LivePreemption
  /** Resolves (never rejects) once the recovery has finished and released the latch. */
  readonly done: Promise<void>
}

interface Action {
  readonly name: string
  readonly priority: Priority
  /** Passed to the inner action. Aborted by a preemption, the caller, or `stop()`. */
  readonly controller: AbortController
  /**
   * Aborted only by the caller or `stop()`, never by a preemption: it ends the
   * wait for a recovery early. The inner controller cannot serve, because a
   * preempted action's is already aborted when that wait begins.
   */
  readonly halt: AbortController
  /** False while waiting for a running recovery; nothing to preempt yet. */
  started: boolean
  halted: 'caller' | 'stop' | null
  /** The most recent trigger that preempted this action, if any. */
  preemptedBy: ReflexTrigger | null
}

export class ReflexExecutor implements BotExecutor {
  private readonly inner: BotExecutor
  private readonly thresholds: Partial<ReflexThresholds>
  private readonly onPreempt: ((p: ReflexPreemption) => void) | undefined
  private readonly recoveryTimeoutMs: number
  private readonly maxConsecutiveFailures: number

  /** A Map, not a slot: nothing in the contract says a `BotExecutor` is single-flight. */
  private readonly inFlight = new Map<symbol, Action>()
  /** The latch. */
  private recovery: Recovery | null = null
  private suppressed = false
  /** Per trigger kind, so a run of failed attacks cannot disarm flee. */
  private readonly consecutiveFailures: Record<ReflexTrigger['kind'], number> = { attack: 0, flee: 0 }
  private readonly records: LivePreemption[] = []

  constructor(inner: BotExecutor, opts: ReflexExecutorOptions = {}) {
    this.inner = inner
    this.thresholds = opts.thresholds ?? {}
    this.onPreempt = opts.onPreempt
    this.recoveryTimeoutMs = opts.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES
    // Safe before connect(), and survives reconnects (contract suite,
    // "subscription lifetime"). `entityNearby` is not optional: the attack rule
    // is about proximity, and without it nothing fires until after the first hit.
    inner.on('damaged', this.onEvent)
    inner.on('health', this.onEvent)
    inner.on('entityNearby', this.onEvent)
  }

  /** Every preemption so far, oldest first. Records are live; see {@link ReflexPreemption.recovery}. */
  get preemptions(): readonly ReflexPreemption[] {
    return this.records
  }

  // ---------- pass-through ----------

  connect(): Promise<Result> {
    return this.inner.connect()
  }

  /** Not pure pass-through: cancels a running recovery first (see the header). */
  disconnect(): Promise<void> {
    this.recovery?.controller.abort()
    return this.inner.disconnect()
  }

  getState(): WorldSnapshot {
    return this.inner.getState()
  }

  findBlocks(query: BlockQuery): readonly BlockInfo[] {
    return this.inner.findBlocks(query)
  }

  on<K extends keyof BotEvents>(event: K, handler: (payload: BotEvents[K]) => void): Unsubscribe {
    return this.inner.on(event, handler)
  }

  chat(message: string): void {
    this.inner.chat(message)
  }

  // ---------- guarded actions ----------

  moveTo(target: Vec3, opts?: ActionOptions): Promise<Result> {
    return this.guard('moveTo', 0, opts, (signal) => this.inner.moveTo(target, { ...opts, signal }))
  }

  /** Imposes no timeout of its own: follow's "until aborted" passes straight through. */
  followPlayer(playerName: string, opts?: ActionOptions): Promise<Result> {
    return this.guard('followPlayer', 0, opts, (signal) =>
      this.inner.followPlayer(playerName, { ...opts, signal }),
    )
  }

  mineBlock(
    target: string | Vec3,
    maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>> {
    return this.guard('mineBlock', 0, opts, (signal) =>
      this.inner.mineBlock(target, maxDistance, { ...opts, signal }),
    )
  }

  placeBlock(blockName: string, position: Vec3, opts?: ActionOptions): Promise<Result> {
    return this.guard('placeBlock', 0, opts, (signal) =>
      this.inner.placeBlock(blockName, position, { ...opts, signal }),
    )
  }

  exploreFor(
    names: readonly string[],
    maxDistance: number,
    opts?: ExploreOptions,
  ): Promise<Result<ExplorationReport>> {
    return this.guard('exploreFor', 0, opts, (signal) =>
      this.inner.exploreFor(names, maxDistance, { ...opts, signal }),
    )
  }

  /** Occupies the reflex at attack priority: an attack trigger will not abort it; a flee will. */
  attack(entityId: number, opts?: ActionOptions): Promise<Result> {
    return this.guard('attack', 1, opts, (signal) => this.inner.attack(entityId, { ...opts, signal }))
  }

  /**
   * Occupies the reflex at flee priority: nothing preempts it. Called during an
   * attack recovery, it supersedes that recovery instead of waiting behind it.
   */
  flee(opts?: ActionOptions): Promise<Result<{ fled: boolean }>> {
    return this.guard('flee', 2, opts, (signal) => this.inner.flee({ ...opts, signal }))
  }

  /**
   * The emergency brake, overridden rather than delegated: delegating let a
   * pending recovery start walking after the brake was pulled.
   */
  stop(): void {
    // Suppress first, so anything the aborts below cause to be emitted cannot
    // trigger a fresh recovery.
    this.suppressed = true
    const recovery = this.recovery
    this.recovery = null
    recovery?.controller.abort()
    for (const action of [...this.inFlight.values()]) this.halt(action, 'stop')
    this.inner.stop()
  }

  // ---------- the arbiter ----------

  /** Synchronous, and must never throw: a real emitter may not swallow it. */
  private readonly onEvent = (): void => {
    if (this.suppressed) return
    let snapshot: WorldSnapshot
    try {
      snapshot = this.inner.getState()
    } catch {
      return // disconnected: nothing to react to
    }
    const trigger = evaluateReflex(snapshot, this.thresholds)
    if (trigger === null) {
      this.consecutiveFailures.attack = 0
      this.consecutiveFailures.flee = 0
      return
    }
    if (this.consecutiveFailures[trigger.kind] >= this.maxConsecutiveFailures) return
    const priority = priorityOf(trigger)
    if (priority <= this.occupiedPriority()) return
    this.preempt(trigger, priority)
  }

  /**
   * What a trigger has to beat. Cancelled work — an aborted recovery winding
   * down, an action already preempted — occupies nothing.
   */
  private occupiedPriority(): Priority {
    let occupied: Priority =
      this.recovery !== null && !this.recovery.controller.signal.aborted ? this.recovery.priority : 0
    for (const action of this.inFlight.values()) {
      if (action.started && !action.controller.signal.aborted && action.priority > occupied) {
        occupied = action.priority
      }
    }
    return occupied
  }

  private preempt(trigger: ReflexTrigger, priority: 1 | 2): void {
    // Includes actions an earlier, lower-priority preemption already aborted:
    // they are still waiting, and should report the trigger that superseded it.
    const preempted = [...this.inFlight.values()].filter((a) => a.started && a.halted === null)
    const preemption: LivePreemption = {
      trigger,
      at: Date.now(),
      action: preempted.length > 0 ? preempted.map((a) => a.name).join(', ') : 'idle',
      recovery: null,
    }
    this.records.push(preemption)

    // The latch, set BEFORE anything is aborted: an abort listener that
    // re-enters this handler synchronously must already see it.
    const superseded = this.recovery
    let release!: () => void
    const recovery: Recovery = {
      controller: new AbortController(),
      priority,
      preemption,
      done: new Promise<void>((resolve) => {
        release = resolve
      }),
    }
    this.recovery = recovery
    void this.runRecovery(recovery, release)

    superseded?.controller.abort()
    for (const action of preempted) {
      action.preemptedBy = trigger
      action.controller.abort()
    }

    try {
      this.onPreempt?.(preemption)
    } catch {
      // An observer's bug must not break the arbiter.
    }
  }

  private async runRecovery(recovery: Recovery, release: () => void): Promise<void> {
    const { controller, preemption } = recovery
    const { trigger } = preemption
    let result: Result<unknown> = fail('internal', 'recovery did not settle')
    try {
      // Yield before touching the inner executor, so a stop() or a supersede
      // in the same synchronous turn as the trigger cancels this outright.
      // Checking the signal is not enough on its own: an executor may record
      // or begin work before it looks at the signal (MockExecutor does).
      await Promise.resolve()
      if (controller.signal.aborted) {
        result = fail('interrupted', 'recovery cancelled before it started')
      } else {
        const opts = { signal: controller.signal, timeoutMs: this.recoveryTimeoutMs }
        result =
          trigger.kind === 'attack'
            ? await this.inner.attack(trigger.entityId, opts)
            : await this.inner.flee(opts)
      }
    } catch (e) {
      result = fail('internal', e instanceof Error ? e.message : String(e))
    } finally {
      preemption.recovery = result
      // `flee` resolving ok with `fled: false` — the hostile went away between
      // trigger and call — is a race, not a failure, and resets flee's count.
      if (result.ok) this.consecutiveFailures[trigger.kind] = 0
      else if (!controller.signal.aborted) this.consecutiveFailures[trigger.kind] += 1
      // Only if still ours: a superseding flee owns the latch now.
      if (this.recovery === recovery) this.recovery = null
      release()
    }
  }

  private async guard<T>(
    name: string,
    priority: Priority,
    opts: ActionOptions | undefined,
    run: (signal: AbortSignal) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    // Checked synchronously: addEventListener never fires for a signal that
    // is already aborted.
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    this.suppressed = false

    const key = Symbol(name)
    const action: Action = {
      name,
      priority,
      controller: new AbortController(),
      halt: new AbortController(),
      started: false,
      halted: null,
      preemptedBy: null,
    }
    this.inFlight.set(key, action)
    const onCallerAbort = (): void => this.halt(action, 'caller')
    opts?.signal?.addEventListener('abort', onCallerAbort, { once: true })

    try {
      const running = this.recovery
      if (running !== null && priority > running.priority) {
        // Outranks the recovery: supersede it, as a higher trigger would.
        // Aborted, it occupies nothing and releases its own latch.
        running.controller.abort()
      } else if (running !== null) {
        // Chosen from a snapshot the recovery has since made stale: wait it
        // out, then hand back `interrupted` without running.
        const by = await this.untilRecovered(action)
        if (action.halted !== null) return haltedResult(action.halted)
        return preemptedResult(by ?? running.preemption.trigger)
      }

      // No await between here and the inner call, so an event emitted right
      // after this method returns already sees the action as started.
      action.started = true
      let result: Result<T>
      try {
        result = await run(action.controller.signal)
      } catch (e) {
        result = fail('internal', e instanceof Error ? e.message : String(e))
      }
      if (action.halted !== null) return haltedResult(action.halted)

      if (action.preemptedBy !== null) {
        await this.untilRecovered(action)
        if (action.halted !== null) return haltedResult(action.halted)
        return preemptedResult(action.preemptedBy)
      }
      return result
    } finally {
      opts?.signal?.removeEventListener('abort', onCallerAbort)
      this.inFlight.delete(key)
    }
  }

  private halt(action: Action, cause: 'caller' | 'stop'): void {
    if (action.halted !== null) return
    action.halted = cause
    // Ends any wait for a recovery, so the caller hears back at once. It does
    // NOT cancel the recovery: that is for stop() and disconnect(), never for
    // a caller's abort (see the header).
    action.halt.abort()
    action.controller.abort()
  }

  /**
   * Wait until no recovery is running — including any that supersedes the one
   * running when the wait began — or until the action is halted. Resolves to
   * the trigger of the last recovery waited on, or `null` if there was none.
   */
  private async untilRecovered(action: Action): Promise<ReflexTrigger | null> {
    const halted = new Promise<void>((resolve) => {
      if (action.halt.signal.aborted) resolve()
      else action.halt.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    let last: ReflexTrigger | null = null
    while (this.recovery !== null && !action.halt.signal.aborted) {
      last = this.recovery.preemption.trigger
      await Promise.race([this.recovery.done, halted])
    }
    return last
  }
}

const haltedResult = (cause: 'caller' | 'stop'): Result<never> =>
  fail('interrupted', cause === 'stop' ? 'stopped via stop()' : 'aborted by the caller')

/** Names the reflex and its trigger, so the planner can read why. */
const preemptedResult = (by: ReflexTrigger): Result<never> =>
  fail('interrupted', `preempted by reflex: ${by.kind} — ${by.reason}`)
