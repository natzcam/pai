import { randomUUID } from 'node:crypto'
import { Role, TaskState } from '@a2a-js/sdk'
import type { Message as SdkMessage, StreamResponse as SdkStreamResponse } from '@a2a-js/sdk'
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory, createAuthenticatingFetchWithRetry } from '@a2a-js/sdk/client'
import { afterEach, describe, expect, it } from 'vitest'
import { GATEWAY_SECURITY_SCHEME, startGateway } from '../src/daemon/gateway.js'
import type { Gateway } from '../src/daemon/gateway.js'
import type { MessageHandler } from '../src/server.js'
import { DaemonClient } from '../src/daemon/client.js'
import { agentText, card, collect, firstText, taskOf, text, useTestnet } from './helpers.js'

const { agent } = useTestnet()
const TOKEN = 'gateway-test-token-0123456789abcdef'

// Streams three chunks, then completes.
const chunky: MessageHandler = async (message, task) => {
  await task.update('TASK_STATE_WORKING')
  for (const word of ['one ', 'two ', 'three']) await task.artifact({ artifactId: 'out', parts: [{ text: word }] }, { append: true })
  await task.update('TASK_STATE_COMPLETED', agentText(`done: ${firstText(message)}`))
}

// alice runs the gateway; bob is the remote agent.
async function setup (handler: MessageHandler = chunky): Promise<{ gateway: Gateway, bobId: string, aliceId: string }> {
  const bob = await agent('bob', { handler })
  const alice = await agent('alice')
  const gateway = await startGateway(alice, { token: TOKEN, port: 0 })
  return { gateway: track(gateway), bobId: hex(bob.id), aliceId: hex(alice.id) }
}

const open: Gateway[] = []
function track (g: Gateway): Gateway {
  open.push(g)
  return g
}
// Gateways close before the agents (cleanup runs in reverse).
afterEach(async () => { while (open.length) await open.pop()!.close() })

function sdkClient (url: string, token = TOKEN) {
  const fetchImpl = createAuthenticatingFetchWithRetry(fetch, {
    headers: async () => ({ Authorization: `Bearer ${token}` }),
    shouldRetryWithHeaders: async () => undefined
  })
  const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl })
  }))
  return factory.createFromUrl(url)
}

function sdkText (text: string): SdkMessage {
  return {
    messageId: randomUUID(),
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: '' }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: []
  }
}

async function post (gateway: Gateway, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await fetch(`${gateway.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'A2A-Version': '1.0', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

describe('gateway with the official A2A JS SDK', () => {
  it('reads the card, sends, streams, gets and lists through the gateway', async () => {
    const { gateway, bobId } = await setup()
    // A trailing slash: the SDK resolves the card path relative to it.
    const client = await sdkClient(`${gateway.url}/agents/${bobId}/`)

    const card = await client.getAgentCard()
    expect(card.name).toBe('bob')
    expect(card.supportedInterfaces[0]).toMatchObject({ url: `${gateway.url}/agents/${bobId}`, protocolBinding: 'JSONRPC' })

    const sent = await client.sendMessage({ tenant: '', message: sdkText('hi'), configuration: undefined, metadata: undefined })
    if (!('status' in sent)) throw new Error('expected a task')
    expect(sent.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(sent.artifacts[0]?.parts.map((p) => p.content?.$case === 'text' ? p.content.value : '').join('')).toBe('one two three')

    const kinds: string[] = []
    let text = ''
    for await (const item of client.sendMessageStream({ tenant: '', message: sdkText('stream'), configuration: undefined, metadata: undefined }) as AsyncIterable<SdkStreamResponse>) {
      const payload = item.payload
      if (!payload) continue
      kinds.push(payload.$case)
      if (payload.$case === 'artifactUpdate') text += payload.value.artifact?.parts.map((p) => p.content?.$case === 'text' ? p.content.value : '').join('') ?? ''
    }
    expect(kinds).toEqual(['task', 'artifactUpdate', 'artifactUpdate', 'artifactUpdate', 'statusUpdate'])
    expect(text).toBe('one two three')

    const got = await client.getTask({ tenant: '', id: sent.id, historyLength: undefined })
    expect(got.id).toBe(sent.id)
    const listed = await client.listTasks({ tenant: '', contextId: '', status: TaskState.TASK_STATE_UNSPECIFIED, pageSize: undefined, pageToken: '', historyLength: undefined, statusTimestampAfter: undefined, includeArtifacts: undefined })
    expect(listed.totalSize).toBe(2)
  })
})

describe('gateway protocol handling', () => {
  it('passes remote errors through, and reports unknown methods, bad JSON and bad envelopes', async () => {
    const { gateway, bobId } = await setup()
    const notFound = await (await post(gateway, `/agents/${bobId}`, { jsonrpc: '2.0', id: 'x1', method: 'GetTask', params: { id: 'missing' } })).json()
    expect(notFound).toMatchObject({ jsonrpc: '2.0', id: 'x1', error: { code: -32001, data: [{ reason: 'TASK_NOT_FOUND' }] } })

    expect(await (await post(gateway, `/agents/${bobId}`, '{nope')).json()).toMatchObject({ id: null, error: { code: -32700 } })
    expect(await (await post(gateway, `/agents/${bobId}`, { jsonrpc: '2.0', id: 3 })).json()).toMatchObject({ id: 3, error: { code: -32600 } })
    expect(await (await post(gateway, `/agents/${bobId}`, { jsonrpc: '2.0', id: 4, method: 'Nope' })).json()).toMatchObject({ id: 4, error: { code: -32601 } })
  })

  it('refuses a missing or old A2A-Version', async () => {
    const { gateway, bobId } = await setup()
    const body = { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }
    const missing = await fetch(`${gateway.url}/agents/${bobId}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) })
    expect(await missing.json()).toMatchObject({ error: { code: -32009, data: [{ reason: 'VERSION_NOT_SUPPORTED' }] } })
    expect(await (await post(gateway, `/agents/${bobId}`, body, { 'A2A-Version': '0.3' })).json()).toMatchObject({ error: { code: -32009 } })
  })

  it('streams as SSE with the client\'s request id, and closes at the end', async () => {
    const { gateway, bobId } = await setup()
    const res = await post(gateway, `/agents/${bobId}`, {
      jsonrpc: '2.0', id: 'client-7', method: 'SendStreamingMessage', params: { message: { role: 'ROLE_USER', messageId: 'm1', parts: [{ text: 'go' }] } }
    })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const events = (await res.text()).trim().split('\n\n').map((e) => JSON.parse(e.replace(/^data: /, '')))
    expect(events.every((e) => e.id === 'client-7')).toBe(true)
    expect(Object.keys(events[0].result)).toEqual(['task'])
    expect(events.at(-1).result.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('reports an unreachable agent and a call to itself', async () => {
    const alice = await agent('alice', { options: { timeout: 500 } })
    const gateway = track(await startGateway(alice, { token: TOKEN, port: 0 }))
    const body = { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }
    expect(await (await post(gateway, `/agents/${hex(alice.id)}`, body)).json()).toMatchObject({ error: { data: [{ reason: 'SELF_CALL' }] } })
    const nobody = 'f'.repeat(64)
    expect(await (await post(gateway, `/agents/${nobody}`, body)).json()).toMatchObject({ id: 1, error: { code: -32603, data: [{ reason: 'AGENT_UNREACHABLE', domain: 'pai' }] } })
  })

  it('serves the remote card with the gateway first and its bearer scheme', async () => {
    const { gateway, bobId } = await setup()
    const card = await (await fetch(`${gateway.url}/agents/${bobId}/.well-known/agent-card.json`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as any
    expect(card.supportedInterfaces[0]).toEqual({ url: `${gateway.url}/agents/${bobId}`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' })
    expect(card.supportedInterfaces[1].url).toBe(`pai://${bobId}`)
    expect(card.securitySchemes[GATEWAY_SECURITY_SCHEME]).toEqual({ httpAuthSecurityScheme: { scheme: 'Bearer', description: expect.any(String) } })
    expect(card.securityRequirements).toEqual([{ schemes: { [GATEWAY_SECURITY_SCHEME]: { list: [] } } }])

    const info = await (await fetch(`${gateway.url}/`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as any
    expect(info.card.name).toBe('alice')
  })
})

describe('gateway security', () => {
  it('needs the token, a loopback Host, and no other site\'s Origin', async () => {
    const { gateway, bobId } = await setup()
    const url = `${gateway.url}/agents/${bobId}/.well-known/agent-card.json`
    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' } })).status).toBe(403)
    // A rebinding page's requests carry its own hostname.
    const port = new URL(gateway.url).port
    const rebound = await rawStatus(port, { Host: `evil.example:${port}`, Authorization: `Bearer ${TOKEN}` })
    expect(rebound).toBe(403)
    expect(await rawStatus(port, { Host: `localhost:${port}`, Authorization: `Bearer ${TOKEN}` })).toBe(200)
  })

  it('serves its web page without the token, locked down, and takes calls from that page only', async () => {
    const { gateway, bobId } = await setup()
    const page = await fetch(`${gateway.url}/ui`)
    expect(page.status).toBe(200)
    const csp = page.headers.get('content-security-policy') ?? ''
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
    expect(nonce).toBeTruthy()
    expect(csp).toMatch(/default-src 'none'/)
    expect(csp).toMatch(/frame-ancestors 'none'/)
    const html = await page.text()
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html).not.toContain('__NONCE__')
    // With a query string, and for HEAD, too.
    expect((await fetch(`${gateway.url}/ui?from=bookmark`)).status).toBe(200)
    const head = await fetch(`${gateway.url}/ui`, { method: 'HEAD' })
    expect([head.status, head.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8'])
    // A fresh nonce each time.
    expect((await fetch(`${gateway.url}/ui`)).headers.get('content-security-policy')).not.toBe(csp)
    // The page's own origin may call, with the token; another may not.
    const url = `${gateway.url}/agents/${bobId}/.well-known/agent-card.json`
    expect((await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: gateway.url } })).status).toBe(200)
    expect((await fetch(url, { headers: { Origin: gateway.url } })).status).toBe(401)
    expect((await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://127.0.0.1:1' } })).status).toBe(403)
  })

  it('refuses to listen on a non-loopback address', async () => {
    const alice = await agent('alice')
    await expect(startGateway(alice, { token: TOKEN, host: '0.0.0.0', port: 0 })).rejects.toThrow(/loopback/)
  })
})

// fetch() won't let a caller set Host, so use node:http.
async function rawStatus (port: string, headers: Record<string, string>): Promise<number> {
  const { request } = await import('node:http')
  return await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: Number(port), path: '/', headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end()
  })
}

function hex (key: Uint8Array): string {
  return Buffer.from(key).toString('hex')
}

describe('DaemonClient: what pai send, card and task use', () => {
  it('calls through the gateway as the daemon\'s agent, and follows card changes', async () => {
    const bob = await agent('bob', { handler: chunky })
    const alice = await agent('alice')
    const gateway = track(await startGateway(alice, { token: TOKEN, port: 0 }))
    const daemon = new DaemonClient({ url: gateway.url, token: TOKEN })
    expect((await daemon.info()).id).toBe(hex(alice.id))

    const remote = daemon.agent(hex(bob.id))
    // The card as bob publishes it: no gateway interface added.
    expect((await remote.card())?.supportedInterfaces.map((i) => i.url)).toEqual([`pai://${hex(bob.id)}`])

    const task = taskOf(await remote.send(text('hi')))
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    const events = await collect(remote.stream(text('streamed')))
    expect(events.at(-1)).toMatchObject({ statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } } })
    // The tasks belong to alice, the daemon's agent.
    expect((await remote.listTasks()).tasks.map((t) => t.id)).toContain(task.id)
    expect((await bob.connect(alice.id).then((p) => p.listTasks())).tasks).toEqual([])
    await expect(remote.getTask('missing')).rejects.toMatchObject({ code: -32001 })

    const stop = new AbortController()
    const seen: string[] = []
    const watching = (async () => {
      for await (const c of remote.watchCard({ signal: stop.signal })) {
        seen.push(c.version)
        if (seen.length === 1) await bob.updateCard({ ...card('bob'), version: '2.0.0' })
        else stop.abort()
      }
    })()
    await watching
    expect(seen).toEqual(['1.0.0', '2.0.0'])
  })

  it('says when no daemon is listening or the token is wrong', async () => {
    await expect(new DaemonClient({ url: 'http://127.0.0.1:1', token: TOKEN }).info()).rejects.toThrow(/No pai daemon at http:\/\/127.0.0.1:1/)
    const gateway = track(await startGateway(await agent('alice'), { token: TOKEN, port: 0 }))
    await expect(new DaemonClient({ url: gateway.url, token: 'wrong-token-0123456789abcdef' }).info()).rejects.toThrow(/refused the token/)
  })
})
