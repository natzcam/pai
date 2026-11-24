import { randomUUID } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentCard as SdkAgentCard, Role, Task as SdkTask, TaskArtifactUpdateEvent, TaskState, TaskStatusUpdateEvent } from '@a2a-js/sdk'
import type { StreamResponse as SdkStreamResponse } from '@a2a-js/sdk'
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory, createAuthenticatingFetchWithRetry } from '@a2a-js/sdk/client'
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import type { AgentExecutor } from '@a2a-js/sdk/server'
import { UserBuilder, agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { startGateway } from '../src/daemon/gateway.js'
import type { Gateway } from '../src/daemon/gateway.js'
import { CALLER_HEADER, proxyHandler, upstreamCard } from '../src/daemon/proxy.js'
import { PaiRpcError } from '../src/errors.js'
import { collect, describeEvent, taskOf, text, useTestnet } from './helpers.js'

const { agent } = useTestnet()
const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { while (closers.length) await closers.pop()!() })

// An ordinary A2A agent built with the official SDK: it streams three
// words and completes, and records who pai said was calling.
async function sdkUpstream (): Promise<{ url: string, callers: string[] }> {
  const callers: string[] = []
  const card = SdkAgentCard.fromJSON({
    name: 'upstream-bot',
    description: 'An A2A agent built with the official SDK',
    version: '2.0.0',
    supportedInterfaces: [{ url: 'http://127.0.0.1:1/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'words', name: 'Words', description: 'Says three words', tags: ['demo'] }]
  })
  const executor: AgentExecutor = {
    async execute (ctx, bus) {
      const { taskId, contextId } = ctx
      const said = ctx.userMessage.parts[0]?.content?.$case === 'text' ? ctx.userMessage.parts[0].content.value : ''
      bus.publish({ kind: 'task', data: SdkTask.fromJSON({ id: taskId, contextId, status: { state: 'TASK_STATE_WORKING' } }) })
      const words = ['upstream ', 'says ', said]
      for (const [i, word] of words.entries()) {
        bus.publish({ kind: 'artifactUpdate', data: TaskArtifactUpdateEvent.fromJSON({ taskId, contextId, artifact: { artifactId: 'out', parts: [{ text: word }] }, append: i > 0, lastChunk: i === words.length - 1 }) })
      }
      bus.publish({ kind: 'statusUpdate', data: TaskStatusUpdateEvent.fromJSON({ taskId, contextId, status: { state: 'TASK_STATE_COMPLETED' } }) })
      bus.finished()
    },
    async cancelTask () {}
  }
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor)
  const app = express()
  app.use((req, _res, next) => {
    const caller = req.headers[CALLER_HEADER.toLowerCase()]
    if (typeof caller === 'string') callers.push(caller)
    next()
  })
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }))
  app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }))
  const server: HttpServer = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, callers }
}

// bob fronts the upstream over pai, publishing its card.
async function proxied (upstream: string) {
  return await agent('bob', { card: await upstreamCard(upstream), onRequest: proxyHandler(upstream) })
}

describe('--proxy in front of an SDK-built A2A agent', () => {
  it('forwards sends, streams and task reads, and names the caller', async () => {
    const upstream = await sdkUpstream()
    const bob = await proxied(upstream.url)
    const alice = await agent('alice')
    const peer = await alice.connect(bob.id)

    // The upstream's card, published over pai with only pai's interface.
    const card = await peer.card()
    expect(card?.name).toBe('upstream-bot')
    expect(card?.supportedInterfaces.map((i) => i.url)).toEqual([`pai://${hex(bob.id)}`])

    const task = taskOf(await peer.send(text('hello')))
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')

    const events = await collect(peer.stream(text('streamed')))
    expect(events.map(describeEvent)).toEqual(['task:working', 'artifact:out', 'artifact:out:append', 'artifact:out:append:last', 'status:completed'])

    // The upstream owns tasks: GetTask is answered from its store.
    expect((await peer.getTask(task.id)).id).toBe(task.id)
    expect(new Set(upstream.callers)).toEqual(new Set([hex(alice.id)]))
  })

  it('passes upstream errors through, and reports an upstream that is down', async () => {
    const upstream = await sdkUpstream()
    const bob = await proxied(upstream.url)
    const peer = await (await agent('alice')).connect(bob.id)
    await expect(peer.getTask('missing')).rejects.toMatchObject({ code: -32001 })

    const dead = await agent('carol', { onRequest: proxyHandler('http://127.0.0.1:1/') })
    const toDead = await (await agent('dave')).connect(dead.id)
    const err = await toDead.getTask('x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PaiRpcError)
    expect((err as PaiRpcError).reason).toBe('UPSTREAM_UNAVAILABLE')
    await expect(collect(toDead.stream(text('x')))).rejects.toMatchObject({ reason: 'UPSTREAM_UNAVAILABLE' })
  })
})

describe('end to end: SDK client → gateway → pai → --proxy → SDK agent', () => {
  it('works with stock SDK code on both ends', async () => {
    const upstream = await sdkUpstream()
    const bob = await proxied(upstream.url)
    const alice = await agent('alice')
    const token = 'e2e-token-0123456789abcdef'
    const gateway: Gateway = await startGateway(alice, { token, port: 0 })
    closers.push(() => gateway.close())

    const fetchImpl = createAuthenticatingFetchWithRetry(fetch, {
      headers: async () => ({ Authorization: `Bearer ${token}` }),
      shouldRetryWithHeaders: async () => undefined
    })
    const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl })
    }))
    const client = await factory.createFromUrl(`${gateway.url}/agents/${hex(bob.id)}/`)
    expect((await client.getAgentCard()).name).toBe('upstream-bot')

    let said = ''
    let state = TaskState.TASK_STATE_UNSPECIFIED
    const message = {
      messageId: randomUUID(),
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text' as const, value: 'hi there' }, metadata: undefined, filename: '', mediaType: '' }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: []
    }
    for await (const item of client.sendMessageStream({ tenant: '', message, configuration: undefined, metadata: undefined }) as AsyncIterable<SdkStreamResponse>) {
      const p = item.payload
      if (p?.$case === 'artifactUpdate') said += p.value.artifact?.parts.map((x) => x.content?.$case === 'text' ? x.content.value : '').join('') ?? ''
      if (p?.$case === 'statusUpdate') state = p.value.status?.state ?? state
    }
    expect(said).toBe('upstream says hi there')
    expect(state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(upstream.callers).toEqual([hex(alice.id)])
  })
})

function hex (key: Uint8Array): string {
  return Buffer.from(key).toString('hex')
}
