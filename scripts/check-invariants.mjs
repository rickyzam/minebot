// Enforces the two structural guarantees the design spec (§4) claims but that
// nothing else checks. Both are about keeping the two development tracks
// genuinely independent, so a violation is a real architectural regression
// rather than a style nit.
//
// Run by CI and available locally: `node scripts/check-invariants.mjs`

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const failures = []

const manifest = (pkg) => {
  const path = join('packages', pkg, 'package.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

// 1. `contract` is types plus two helper functions. If it ever gains a runtime
//    dependency, every consumer inherits it — including the planning track,
//    which is supposed to be buildable with no game libraries at all.
const contract = manifest('contract')
if (!contract) {
  failures.push('packages/contract/package.json is missing')
} else {
  const deps = Object.keys(contract.dependencies ?? {})
  if (deps.length > 0) {
    failures.push(
      `packages/contract must have zero runtime dependencies, found: ${deps.join(', ')}`,
    )
  }
}

// 2. The planning track talks to the contract, never to Mineflayer. npm
//    workspaces make this structural rather than a matter of discipline: if the
//    dependency is not declared, the import cannot resolve. This check exists so
//    the guarantee cannot be quietly undone by adding it.
const agent = manifest('agent')
if (agent) {
  const all = {
    ...(agent.dependencies ?? {}),
    ...(agent.devDependencies ?? {}),
    ...(agent.peerDependencies ?? {}),
  }
  const gameLibs = Object.keys(all).filter(
    (d) => d === 'mineflayer' || d.startsWith('mineflayer-') || d.startsWith('prismarine-'),
  )
  if (gameLibs.length > 0) {
    failures.push(
      `packages/agent must not depend on game libraries, found: ${gameLibs.join(', ')}. ` +
        'It talks to @minebot/contract and is tested against @minebot/mock-executor.',
    )
  }
}

if (failures.length > 0) {
  console.error('Structural invariant violations:\n')
  for (const f of failures) console.error(`  - ${f}`)
  console.error('\nSee docs/superpowers/specs/2026-09-07-minecraft-agent-design.md §4')
  process.exit(1)
}

console.log(`Structural invariants OK (checked ${agent ? 2 : 1} of 2; agent package ${agent ? 'present' : 'not yet created'})`)
