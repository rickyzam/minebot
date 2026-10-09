/**
 * The reflex layer's decision, kept pure so every rule is testable without a
 * server, a model, or a mob. Design §3.5: reflex beats plan, always — but only
 * when there is something to react to.
 */
import type { EntityInfo, WorldSnapshot } from '@minebot/contract'

export interface ReflexThresholds {
  /** At or below this health, disengage rather than fight. */
  readonly fleeBelowHealth: number
  /** How close a hostile must be to matter, in blocks. */
  readonly hostileRadius: number
}

/**
 * 6 of 20 is three hearts — two hits from most early hostiles. The radius is a
 * little beyond a zombie's reach so the trigger can fire before contact, which
 * requires the arbiter to subscribe to `entityNearby` and not only `damaged`.
 */
export const DEFAULT_REFLEX_THRESHOLDS: ReflexThresholds = Object.freeze({
  fleeBelowHealth: 6,
  hostileRadius: 8,
})

export type ReflexTrigger =
  | { readonly kind: 'flee'; readonly reason: string }
  | { readonly kind: 'attack'; readonly entityId: number; readonly reason: string }

export function evaluateReflex(
  snapshot: WorldSnapshot,
  thresholds: Partial<ReflexThresholds> = {},
): ReflexTrigger | null {
  const { fleeBelowHealth, hostileRadius } = { ...DEFAULT_REFLEX_THRESHOLDS, ...thresholds }
  const hostiles = snapshot.nearbyEntities.filter(
    (e: EntityInfo) => e.kind === 'hostile' && e.distance <= hostileRadius,
  )
  if (hostiles.length === 0) return null
  const nearest = hostiles.reduce((a, b) => (b.distance < a.distance ? b : a))
  const where = `${nearest.name} ${nearest.distance.toFixed(1)} away`

  if (snapshot.self.health <= fleeBelowHealth) {
    return { kind: 'flee', reason: `health ${snapshot.self.health} at or below ${fleeBelowHealth} with ${where}` }
  }
  return { kind: 'attack', entityId: nearest.id, reason: where }
}
