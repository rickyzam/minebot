import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { resolveForwardingSecret, FORWARDING_SECRET_ENV } from '../src/forwarding-secret.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'minebot-secret-'))

describe('resolveForwardingSecret', () => {
  it('prefers the environment variable', () => {
    const dir = tmp()
    const path = join(dir, 'forwarding.secret')
    writeFileSync(path, 'from-file')
    expect(resolveForwardingSecret({ env: { [FORWARDING_SECRET_ENV]: 'from-env' }, path })).toBe('from-env')
  })

  it('falls back to the secret file', () => {
    const dir = tmp()
    const path = join(dir, 'forwarding.secret')
    writeFileSync(path, 'from-file\n')
    expect(resolveForwardingSecret({ env: {}, path })).toBe('from-file')
  })

  it('trims surrounding whitespace, which a generated file carries', () => {
    const dir = tmp()
    const path = join(dir, 'forwarding.secret')
    writeFileSync(path, '  spaced  \n')
    expect(resolveForwardingSecret({ env: {}, path })).toBe('spaced')
  })

  it('returns null when there is no secret anywhere', () => {
    // A plain server needs none, so absence is a normal configuration and must
    // not throw — otherwise constructing an executor would fail off-proxy.
    expect(resolveForwardingSecret({ env: {}, path: join(tmp(), 'missing') })).toBeNull()
  })

  it('treats an empty env value as absent and falls through to the file', () => {
    const dir = tmp()
    const path = join(dir, 'forwarding.secret')
    writeFileSync(path, 'from-file')
    expect(resolveForwardingSecret({ env: { [FORWARDING_SECRET_ENV]: '   ' }, path })).toBe('from-file')
  })

  it('treats an empty file as absent rather than signing with nothing', () => {
    const dir = tmp()
    const path = join(dir, 'forwarding.secret')
    writeFileSync(path, '\n')
    expect(resolveForwardingSecret({ env: {}, path })).toBeNull()
  })

  it('returns null rather than throwing when the file cannot be read', () => {
    const dir = tmp()
    const path = join(dir, 'forwarding.secret')
    writeFileSync(path, 'secret')
    chmodSync(path, 0o000)
    expect(resolveForwardingSecret({ env: {}, path })).toBeNull()
  })
})
