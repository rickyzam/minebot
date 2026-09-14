import { requireBackend } from '../../src/require-backend.js'

/**
 * Runs ONCE before the integration project, and fails the whole run if the dev
 * server is not up.
 *
 * Without it a stopped backend produces 134 separate connection failures, one
 * per test, each looking like a bug in the code under test. The backend is
 * deliberately not autostarted (see `mc.service`), so "it is down" is the normal
 * state after a reboot and deserves a first-class message rather than a cascade.
 *
 * A `globalSetup` and not a `beforeAll`: it has to run before any test file is
 * imported, and it must fail the run rather than each file separately.
 */
export default async function setup(): Promise<void> {
  await requireBackend()
}
