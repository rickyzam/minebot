import { describe, it, expect } from 'vitest'
import { installVelocityForwarding, type LoginPluginRequest } from '../src/velocity-handshake.js'
import { buildForwardingResponse, offlineUuid } from '../src/velocity-forwarding.js'

interface Written {
  name: string
  params: { messageId?: number; successful?: boolean; data?: Buffer }
}

/**
 * Fake client that mimics the part of node-minecraft-protocol that matters here:
 * it already has a `login_plugin_request` listener which answers "not
 * understood", exactly as nmp installs.
 */
function fakeClient() {
  const written: Written[] = []
  let handlers: Array<(p: LoginPluginRequest) => void> = []

  const stockHandler = (packet: LoginPluginRequest): void => {
    written.push({ name: 'login_plugin_response', params: { messageId: packet.messageId } })
  }
  handlers.push(stockHandler)

  const client = {
    write(name: string, params: unknown) {
      written.push({ name, params: params as Written['params'] })
    },
    on(_event: string, handler: (p: LoginPluginRequest) => void) {
      handlers.push(handler)
    },
    listeners(_event: string) {
      return [...handlers]
    },
    removeAllListeners(_event: string) {
      handlers = []
    },
  }

  return {
    client: client as unknown as Parameters<typeof installVelocityForwarding>[0],
    written,
    handlerCount: () => handlers.length,
    request: (packet: LoginPluginRequest) => handlers.forEach((h) => h(packet)),
    responses: () => written.filter((w) => w.name === 'login_plugin_response'),
  }
}

const velocityRequest = (messageId = 0, version = 4): LoginPluginRequest => ({
  messageId,
  channel: 'velocity:player_info',
  data: Buffer.from([version]),
})

describe('installVelocityForwarding', () => {
  it('answers a forwarding request with a signed payload', () => {
    const f = fakeClient()
    const fwd = installVelocityForwarding(f.client, { secret: 'k', username: 'MineBot' })
    f.request(velocityRequest())

    expect(fwd.answered).toBe(true)
    const responses = f.responses()
    expect(responses).toHaveLength(1)
    expect(responses[0]!.params.data).toEqual(
      buildForwardingResponse('k', {
        address: '127.0.0.1',
        uuid: offlineUuid('MineBot'),
        username: 'MineBot',
      }),
    )
  })

  it('sends exactly ONE response — the bug that broke the first attempt', () => {
    // nmp registers its own handler answering "not understood". Adding a second
    // handler means two responses for one message id, and the server drops the
    // connection with "Unexpected custom data from client". Verified against a
    // live backend before this was fixed.
    const f = fakeClient()
    installVelocityForwarding(f.client, { secret: 'k', username: 'MineBot' })
    f.request(velocityRequest())
    expect(f.responses()).toHaveLength(1)
  })

  it('displaces the stock handler rather than stacking on it', () => {
    const f = fakeClient()
    expect(f.handlerCount()).toBe(1)
    installVelocityForwarding(f.client, { secret: 'k', username: 'MineBot' })
    expect(f.handlerCount()).toBe(1)
  })

  it('preserves the stock "not understood" reply for other channels', () => {
    const f = fakeClient()
    const fwd = installVelocityForwarding(f.client, { secret: 'k', username: 'MineBot' })
    f.request({ messageId: 7, channel: 'somemod:hello', data: Buffer.alloc(0) })

    const responses = f.responses()
    expect(responses).toHaveLength(1)
    expect(responses[0]!.params.messageId).toBe(7)
    expect(responses[0]!.params.data).toBeUndefined()
    expect(fwd.answered).toBe(false)
  })

  it('records the forwarding version the backend advertised', () => {
    const f = fakeClient()
    const fwd = installVelocityForwarding(f.client, { secret: 'k', username: 'MineBot' })
    expect(fwd.requestedVersion).toBeNull()
    f.request(velocityRequest(0, 4))
    expect(fwd.requestedVersion).toBe(4)
  })

  it('echoes the message id it was asked about', () => {
    const f = fakeClient()
    installVelocityForwarding(f.client, { secret: 'k', username: 'MineBot' })
    f.request(velocityRequest(42))
    expect(f.responses()[0]!.params.messageId).toBe(42)
  })

  it('forwards profile properties, which is how a bot gets a skin', () => {
    const f = fakeClient()
    installVelocityForwarding(f.client, {
      secret: 'k',
      username: 'MineBot',
      properties: [{ name: 'textures', value: 'BASE64' }],
    })
    f.request(velocityRequest())
    expect(f.responses()[0]!.params.data!.toString('utf8')).toContain('textures')
  })

  it('uses a custom address when given one', () => {
    const f = fakeClient()
    installVelocityForwarding(f.client, { secret: 'k', username: 'MineBot', address: '10.0.0.5' })
    f.request(velocityRequest())
    expect(f.responses()[0]!.params.data!.toString('utf8')).toContain('10.0.0.5')
  })

  it('delegates an unknown channel to the handler it displaced', () => {
    // Rather than reimplementing nmp's reply, the displaced handler is called,
    // so a third-party handler keeps working exactly as before.
    const f = fakeClient()
    let sawDelegated: number | null = null
    f.client.on('login_plugin_request', (p) => {
      sawDelegated = p.messageId ?? null
    })
    installVelocityForwarding(f.client, { secret: 'k', username: 'MineBot' })
    f.request({ messageId: 9, channel: 'somemod:hello' })
    expect(sawDelegated).toBe(9)
  })

  it('stays quiet for a request with no message id', () => {
    const f = fakeClient()
    const fwd = installVelocityForwarding(f.client, { secret: 'k', username: 'MineBot' })
    f.request({ channel: 'velocity:player_info', data: Buffer.from([4]) })
    expect(f.responses()).toHaveLength(0)
    expect(fwd.answered).toBe(false)
  })
})
