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
 * **Why it removes existing listeners.** node-minecraft-protocol registers its
 * own `login_plugin_request` handler that unconditionally answers "not
 * understood", mimicking the vanilla client. Merely adding a second handler
 * means the server receives *two* responses for one message id and drops the
 * connection with "Unexpected custom data from client". So this displaces that
 * handler and re-implements the same default for every channel it does not
 * recognise, leaving non-Velocity behaviour unchanged.
 *
 * Safe to install unconditionally: a server not behind a proxy never sends the
 * request, and the fallback path behaves exactly as the stock client does.
 */
export function installVelocityForwarding(
  client: LoginClientLike,
  opts: VelocityForwardingOptions,
): VelocityForwarding {
  const state = { answered: false, requestedVersion: null as number | null }

  client.removeAllListeners('login_plugin_request')
  client.on('login_plugin_request', (packet: LoginPluginRequest) => {
    if (packet.messageId === undefined) return

    if (packet.channel !== VELOCITY_PLAYER_INFO_CHANNEL) {
      // The stock behaviour we displaced: answer "not understood".
      client.write('login_plugin_response', { messageId: packet.messageId })
      return
    }

    // One byte: the highest forwarding version the backend supports. Recorded
    // for diagnostics; we always answer with version 1, since later versions
    // only add a Mojang public key that a bot does not have.
    state.requestedVersion = packet.data?.length ? (packet.data[0] ?? null) : null

    client.write('login_plugin_response', {
      messageId: packet.messageId,
      successful: true,
      data: buildForwardingResponse(opts.secret, {
        address: opts.address ?? '127.0.0.1',
        uuid: offlineUuid(opts.username),
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
