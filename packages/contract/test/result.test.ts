import { describe, it, expect } from 'vitest'
import { ok, fail, type Result } from '@minebot/contract'

describe('Result helpers', () => {
  it('ok() wraps a value and narrows to the success branch', () => {
    const r: Result<number> = ok(42)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(42)
  })

  it('ok() supports void results', () => {
    const r: Result = ok(undefined)
    expect(r.ok).toBe(true)
  })

  it('fail() carries a reason and a detail string', () => {
    const r = fail('not_found', 'no coal within 32 blocks')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('not_found')
      expect(r.detail).toBe('no coal within 32 blocks')
    }
  })

  it('fail() defaults detail to an empty string', () => {
    const r = fail('timeout')
    if (!r.ok) expect(r.detail).toBe('')
  })

  it('a failure is assignable to Result<T> for any T', () => {
    const r: Result<{ position: { x: number; y: number; z: number } }> = fail('unreachable')
    expect(r.ok).toBe(false)
  })
})
