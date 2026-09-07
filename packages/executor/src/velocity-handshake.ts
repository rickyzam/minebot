import {
  VELOCITY_PLAYER_INFO_CHANNEL,
  buildForwardingResponse,
  offlineUuid,
  type ProfileProperty,
} from './velocity-forwarding.js'

/**
 * Minimal view of node-minecraft-protocol's client, declared structurally so
 * this module can be tested with a plain fake.
 */
export interface LoginClientLike {
  write(name: string, params: unknown): void
  on(event: 'login_plugin_request', handler: (packet: LoginPluginRequest) => void): void
  /** Existing handlers, captured so they can be preserved — see below. */
  listeners(event: 'login_plugin_request'): Array<(packet: LoginPluginRequest) => void>
  /**
   * Needed to displace node-minecraft-protocol's own handler — see
   * `installVelocityForwarding`.
   */
  removeAllListeners(event: 'login_plugin_request'): void
}

export interface LoginPluginRequest {
  messageId?: number
  channel?: string
  data?: Buffer
}

export interface VelocityForwardingOptions {
  /** Shared secret, matching the proxy's `forwarding-secret-file`. */
  readonly secret: string
  readonly username: string
  /**
   * Identity to claim. Defaults to the offline UUID for `username`, which keeps
   * a bot's player data stable across runs. Pass a random one for a throwaway
   * bot: clients cache skins per identity, so a reused UUID makes a viewer keep
   * showing the skin it saw last time.
   */
  readonly uuid?: Buffer
  /** Address to report as the player's origin. Defaults to loopback. */
  readonly address?: string
  /** Profile properties; a `textures` entry here gives the bot a skin. */
  readonly properties?: readonly ProfileProperty[]
}

export interface VelocityForwarding {
  /** Whether the backend asked for forwarding data and we answered. */
  readonly answered: boolean
  /** Forwarding version the backend advertised, if it asked. */
  readonly requestedVersion: number | null
}

/**
 * Answer a Velocity-backed server's demand for signed forwarding data.
 *
 * Installing this is what lets a bot reach a backend behind a Velocity proxy.
 * Without it the backend disconnects during login with "This server requires you
 * to connect with Velocity."
 *
 * **Why it displaces existing listeners.** node-minecraft-protocol registers its
 * own `login_plugin_request` handler that unconditionally answers "not
 * understood", mimicking the vanilla client. Merely adding a second handler
 * means the server receives *two* responses for one message id and drops the
 * connection with "Unexpected custom data from client" — observed against a live
 * backend.
 *
 * So existing handlers are captured and then removed, and channels we do not
 * recognise are delegated back to them. That keeps any third-party handler
 * working exactly as before, and avoids having to keep a copy of nmp's reply in
 * sync with it. Only one response is ever produced for a Velocity request.
 *
 * A handler registered *after* this one can still double-respond; install this
 * last, as `openConnection` does.
 *
 * Safe to install unconditionally: a server not behind a proxy never sends the
 * request, and every other channel behaves exactly as it did before.
 */
export function installVelocityForwarding(
  client: LoginClientLike,
  opts: VelocityForwardingOptions,
): VelocityForwarding {
  const state = { answered: false, requestedVersion: null as number | null }

  const displaced = client.listeners('login_plugin_request')
  client.removeAllListeners('login_plugin_request')
  client.on('login_plugin_request', (packet: LoginPluginRequest) => {
    if (packet.messageId === undefined) return

    if (packet.channel !== VELOCITY_PLAYER_INFO_CHANNEL) {
      // Not ours: hand it back to whoever was handling it before, so their
      // behaviour — nmp's "not understood" reply, or a third party's — is
      // preserved exactly rather than reimplemented here.
      for (const handler of displaced) handler(packet)
      return
    }

    // One byte: the highest forwarding version the backend supports. Recorded
    // for diagnostics; we always answer with version 1, since later versions
    // only add a Mojang public key that a bot does not have.
    state.requestedVersion = packet.data?.length ? (packet.data[0] ?? null) : null

    // No `successful` field: across every protocol version in minecraft-data,
    // `login_plugin_response` is `{ messageId, data: option(restBuffer) }`. The
    // success flag on the wire is the option's presence byte, which protodef
    // derives from `data` being defined.
    client.write('login_plugin_response', {
      messageId: packet.messageId,
      data: buildForwardingResponse(opts.secret, {
        address: opts.address ?? '127.0.0.1',
        uuid: opts.uuid ?? offlineUuid(opts.username),
        username: opts.username,
        properties: opts.properties,
      }),
    })
    state.answered = true
  })

  return {
    get answered() {
      return state.answered
    },
    get requestedVersion() {
      return state.requestedVersion
    },
  }
}
