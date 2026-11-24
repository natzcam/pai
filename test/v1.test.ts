import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ListTasksResponse, SendMessageResponse, StreamResponse, Task } from '../src/a2a/types.js'
import { PaiRpcError } from '../src/errors.js'
import { ErrorCodes, SERVICE_PARAMETERS, request } from '../src/protocol/jsonrpc.js'
import type { JsonRpcMessage, JsonRpcRequest, StreamEnd } from '../src/protocol/jsonrpc.js'
import { RpcConnection } from '../src/protocol/rpc.js'
import type { MessageHandler } from '../src/server.js'
import { Server } from '../src/server.js'
import { TaskStore } from '../src/store/task-store.js'
import { agentText, deferred, text } from './helpers.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

const V1 = { 'A2A-Version': '1.0' }

async function server (handler: MessageHandler = async (_m, task) => {
  await task.update('TASK_STATE_WORKING')
  await task.artifact({ artifactId: 'out', parts: [{ text: 'done' }] })
  await task.update('TASK_STATE_COMPLETED')
}): Promise<Server> {
  const dir = await mkdtemp(join(tmpdir(), 'pai-v1-'))
  const tasks = new TaskStore(dir)
  await tasks.ready()
  cleanup.push(async () => { await tasks.close(); await rm(dir, { recursive: true, force: true }) })
  return new Server(tasks, () => handler)
}

// null sends no service parameters at all.
function req (method: string, params?: unknown, serviceParameters: Record<string, string> | null = V1): JsonRpcRequest {
  return request(1, method, params, serviceParameters ?? undefined)
}

async function call<T> (s: Server, method: string, params?: unknown, peer = 'a'.repeat(64)): Promise<T> {
  return await (s.dispatch(req(method, params), { peer }) as Promise<T>)
}

async function rejection (p: Promise<unknown> | AsyncIterable<unknown>): Promise<PaiRpcError> {
  const run = Symbol.asyncIterator in p
    ? (async () => { for await (const _ of p as AsyncIterable<unknown>) { /* drain */ } })()
    : p as Promise<unknown>
  const err = await run.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(PaiRpcError)
  return err as PaiRpcError
}

describe('A2A-Version', () => {
  it('rejects a missing version (0.3) and other versions, and accepts any 1.0 patch', async () => {
    const s = await server()
    const missing = await rejection(s.dispatch(req('GetTask', { id: 'x' }, null)))
    expect(missing.code).toBe(ErrorCodes.VersionNotSupported)
    expect(missing.data).toEqual([{
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'VERSION_NOT_SUPPORTED',
      domain: 'a2a-protocol.org',
      metadata: { version: '0.3', supported: '1.0' }
    }])
    expect((await rejection(s.dispatch(req('GetTask', { id: 'x' }, { 'A2A-Version': '0.3' })))).reason).toBe('VERSION_NOT_SUPPORTED')
    // Keys are case-insensitive; patch versions don't count.
    expect((await rejection(s.dispatch(req('GetTask', { id: 'x' }, { 'a2a-version': '1.0.1' })))).reason).toBe('TASK_NOT_FOUND')
  })
})

describe('errors', () => {
  it('maps unsupported features and bad input to the v1.0 codes', async () => {
    const s = await server()
    for (const method of ['CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig']) {
      expect((await rejection(call(s, method, {}))).code).toBe(ErrorCodes.PushNotificationNotSupported)
    }
    expect((await rejection(call(s, 'GetExtendedAgentCard'))).reason).toBe('EXTENDED_AGENT_CARD_NOT_CONFIGURED')
    expect((await rejection(call(s, 'message/send', {}))).code).toBe(ErrorCodes.MethodNotFound)

    const noParts = await rejection(call(s, 'SendMessage', { message: { ...text('x'), parts: [] } }))
    expect(noParts.code).toBe(ErrorCodes.InvalidParams)
    expect(noParts.data).toEqual([{
      '@type': 'type.googleapis.com/google.rpc.BadRequest',
      fieldViolations: [{ field: 'message.parts', description: 'At least one part is required' }]
    }])
    const twoContents = await rejection(call(s, 'SendMessage', { message: { ...text('x'), parts: [{ text: 'a', url: 'https://x' }] } }))
    expect(twoContents.message).toMatch(/exactly one of text, raw, url or data/)
    const oldShape = await rejection(call(s, 'SendMessage', { message: { kind: 'message', role: 'user', messageId: 'm', parts: [{ kind: 'text', text: 'x' }] } }))
    expect(oldShape.code).toBe(ErrorCodes.InvalidParams)
  })
})

describe('wire shapes', () => {
  it('wraps results, uses enum names and millisecond UTC timestamps, and has no kind fields', async () => {
    const s = await server()
    const res = await call<SendMessageResponse>(s, 'SendMessage', { message: text('hi') })
    expect(Object.keys(res)).toEqual(['task'])
    const task = (res as { task: Task }).task
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.status.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(task.history?.[0]?.role).toBe('ROLE_USER')
    expect(JSON.stringify(res)).not.toContain('"kind"')

    const stateless = await server(async () => agentText('hello'))
    const reply = await call<SendMessageResponse>(stateless, 'SendMessage', { message: text('hi') })
    expect(reply).toEqual({ message: expect.objectContaining({ role: 'ROLE_AGENT', parts: [{ text: 'hello' }] }) })

    const items: StreamResponse[] = []
    for await (const item of s.dispatch(req('SendStreamingMessage', { message: text('go') }), { peer: 'b'.repeat(64) }) as AsyncIterable<StreamResponse>) items.push(item)
    expect(items.map((i) => Object.keys(i)[0])).toEqual(['task', 'artifactUpdate', 'statusUpdate'])
    expect(JSON.stringify(items)).not.toMatch(/"kind"|"final"/)
  })

  it('historyLength 0 omits the history', async () => {
    const s = await server()
    const res = await call<{ task: Task }>(s, 'SendMessage', { message: text('hi'), configuration: { historyLength: 0 } })
    expect('history' in res.task).toBe(false)
    expect('history' in await call<Task>(s, 'GetTask', { id: res.task.id, historyLength: 0 })).toBe(false)
    expect((await call<Task>(s, 'GetTask', { id: res.task.id, historyLength: 1 })).history).toHaveLength(1)
  })
})

describe('contexts', () => {
  const asks: MessageHandler = async (message, task) => {
    await task.update('TASK_STATE_WORKING')
    if ((task.task.history?.length ?? 0) > 1) await task.update('TASK_STATE_COMPLETED', agentText('thanks'))
    else await task.update('TASK_STATE_INPUT_REQUIRED', agentText('more?'))
  }

  it('a follow-up inherits the task\'s context, and one naming another context is rejected', async () => {
    const s = await server(asks)
    const first = await call<SendMessageResponse>(s, 'SendMessage', { message: text('start') })
    if (!('task' in first)) throw new Error('expected a task')
    const { id: taskId, contextId } = first.task

    const mismatch = await rejection(s.dispatch(req('SendMessage', { message: text('more', { taskId, contextId: 'another' }) }), { peer: 'a'.repeat(64) }))
    expect(mismatch.code).toBe(ErrorCodes.InvalidParams)
    expect(mismatch.message).toMatch(/is not task .* context/)
    expect(((await call<Task>(s, 'GetTask', { id: taskId })).status.state)).toBe('TASK_STATE_INPUT_REQUIRED')

    const inherited = await call<SendMessageResponse>(s, 'SendMessage', { message: text('more', { taskId }) })
    expect('task' in inherited && inherited.task.contextId).toBe(contextId)
    expect('task' in inherited && inherited.task.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('a follow-up naming the task\'s own context is fine', async () => {
    const s = await server(asks)
    const first = await call<SendMessageResponse>(s, 'SendMessage', { message: text('start') })
    if (!('task' in first)) throw new Error('expected a task')
    const again = await call<SendMessageResponse>(s, 'SendMessage', { message: text('more', { taskId: first.task.id, contextId: first.task.contextId }) })
    expect('task' in again && again.task.status.state).toBe('TASK_STATE_COMPLETED')
  })
})

describe('retries', () => {
  async function collectStream (s: Server, params: unknown, peer = 'a'.repeat(64)): Promise<StreamResponse[]> {
    const out: StreamResponse[] = []
    for await (const item of s.dispatch(req('SendStreamingMessage', params), { peer }) as AsyncIterable<StreamResponse>) out.push(item)
    return out
  }

  it('a message sent again gets the same task, and the handler runs once per caller', async () => {
    let runs = 0
    const s = await server(async (_m, task) => { runs++; await task.update('TASK_STATE_COMPLETED', agentText('done')) })
    const message = text('once')
    const first = await call<SendMessageResponse>(s, 'SendMessage', { message })
    const again = await call<SendMessageResponse>(s, 'SendMessage', { message })
    expect('task' in again && 'task' in first && again.task.id === first.task.id).toBe(true)
    const streamed = await collectStream(s, { message })
    expect(streamed).toHaveLength(1)
    expect('task' in streamed[0]! && streamed[0].task.id).toBe('task' in first && first.task.id)
    expect(runs).toBe(1)

    // Message ids are only unique per sender.
    const other = await call<SendMessageResponse>(s, 'SendMessage', { message }, 'b'.repeat(64))
    expect('task' in other && 'task' in first && other.task.id !== first.task.id).toBe(true)
    expect(runs).toBe(2)
  })

  it('copies of a message arriving at once still run once', async () => {
    let runs = 0
    const s = await server(async (_m, task) => { runs++; await task.update('TASK_STATE_COMPLETED', agentText('done')) })
    const message = text('twice at once')
    const [a, b] = await Promise.all([
      call<SendMessageResponse>(s, 'SendMessage', { message }),
      call<SendMessageResponse>(s, 'SendMessage', { message })
    ])
    expect('task' in a && 'task' in b && a.task.id === b.task.id).toBe(true)
    expect(runs).toBe(1)
  })

  it('a streaming retry of a running task follows it', async () => {
    const gate = deferred()
    const s = await server(async (_m, task) => {
      await task.update('TASK_STATE_WORKING')
      await gate.promise
      await task.update('TASK_STATE_COMPLETED')
    })
    const message = text('slow')
    const first = await call<SendMessageResponse>(s, 'SendMessage', { message, configuration: { returnImmediately: true } })
    const retry = collectStream(s, { message })
    gate.resolve()
    const items = await retry
    expect('task' in items[0]! && 'task' in first && items[0].task.id === first.task.id).toBe(true)
    expect(items.at(-1)).toMatchObject({ statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } } })
  })

  it('a stateless reply keeps no task, so a retry runs again', async () => {
    let runs = 0
    const s = await server(async () => { runs++; return agentText('pong') })
    const message = text('ping')
    expect(await call<SendMessageResponse>(s, 'SendMessage', { message })).toHaveProperty('message')
    expect(await call<SendMessageResponse>(s, 'SendMessage', { message })).toHaveProperty('message')
    expect(runs).toBe(2)
  })
})

describe('ListTasks', () => {
  const alice = 'a'.repeat(64)
  const bob = 'b'.repeat(64)

  it('lists only the caller\'s tasks, newest first, in cursor pages', async () => {
    const s = await server()
    const mine: string[] = []
    for (let i = 0; i < 5; i++) mine.push((await call<{ task: Task }>(s, 'SendMessage', { message: text(`a${i}`) }, alice)).task.id)
    for (let i = 0; i < 2; i++) await call(s, 'SendMessage', { message: text(`b${i}`) }, bob)

    const seen: Task[] = []
    let pageToken: string | undefined
    do {
      const page: ListTasksResponse = await call(s, 'ListTasks', { pageSize: 2, ...(pageToken ? { pageToken } : {}) }, alice)
      expect(page.totalSize).toBe(5)
      expect(page.pageSize).toBe(2)
      expect(page.tasks.length).toBeLessThanOrEqual(2)
      seen.push(...page.tasks)
      pageToken = page.nextPageToken || undefined
    } while (pageToken)
    expect(seen.map((t) => t.id).sort()).toEqual([...mine].sort())
    const times = seen.map((t) => Date.parse(t.status.timestamp!))
    expect(times).toEqual([...times].sort((x, y) => y - x))
    // Artifacts are left out unless asked for.
    expect(seen.every((t) => !('artifacts' in t))).toBe(true)

    const withArtifacts: ListTasksResponse = await call(s, 'ListTasks', { includeArtifacts: true, pageSize: 1 }, alice)
    expect(withArtifacts.tasks[0]?.artifacts).toHaveLength(1)

    const bobs: ListTasksResponse = await call(s, 'ListTasks', {}, bob)
    expect(bobs.totalSize).toBe(2)
    expect(bobs.nextPageToken).toBe('')
  })

  it('filters by context and status, and checks its parameters', async () => {
    const s = await server(async (message, task) => {
      await task.update('TASK_STATE_WORKING')
      await task.update(message.parts.some((p) => 'text' in p && p.text === 'ask') ? 'TASK_STATE_INPUT_REQUIRED' : 'TASK_STATE_COMPLETED')
    })
    await call(s, 'SendMessage', { message: text('ask', { contextId: 'c1' }) }, alice)
    await call(s, 'SendMessage', { message: text('done', { contextId: 'c1' }) }, alice)
    await call(s, 'SendMessage', { message: text('done', { contextId: 'c2' }) }, alice)

    expect((await call<ListTasksResponse>(s, 'ListTasks', { contextId: 'c1' }, alice)).totalSize).toBe(2)
    expect((await call<ListTasksResponse>(s, 'ListTasks', { status: 'TASK_STATE_INPUT_REQUIRED' }, alice)).totalSize).toBe(1)
    expect((await call<ListTasksResponse>(s, 'ListTasks', { statusTimestampAfter: new Date(Date.now() + 60_000).toISOString() }, alice)).totalSize).toBe(0)

    expect((await rejection(call(s, 'ListTasks', { pageSize: 0 }, alice))).code).toBe(ErrorCodes.InvalidParams)
    expect((await rejection(call(s, 'ListTasks', { pageSize: 101 }, alice))).code).toBe(ErrorCodes.InvalidParams)
    expect((await rejection(call(s, 'ListTasks', { pageToken: 'garbage' }, alice))).code).toBe(ErrorCodes.InvalidParams)
    expect((await rejection(call(s, 'ListTasks', { status: 'completed' }, alice))).code).toBe(ErrorCodes.InvalidParams)
  })
})

describe('the binding\'s framing', () => {
  // Two endpoints wired back to back, recording what crosses the wire.
  function pair (onRequest: ConstructorParameters<typeof RpcConnection>[1]) {
    const wire: Array<JsonRpcMessage | StreamEnd> = []
    let client: RpcConnection | null = null
    const server = new RpcConnection({ send: (m) => { wire.push(m); client?.receive(m) } }, onRequest)
    client = new RpcConnection({ send: (m) => { wire.push(m); server.receive(m) } }, async () => null, { serviceParameters: V1 })
    return { client, wire }
  }

  it('sends service parameters on every request, and ends streams with an end frame', async () => {
    const { client, wire } = pair(async function * () {
      // Nothing here says "last": only the end frame ends the stream.
      yield { statusUpdate: { taskId: 't', contextId: 'c', status: { state: 'TASK_STATE_WORKING' } } }
      yield { statusUpdate: { taskId: 't', contextId: 'c', status: { state: 'TASK_STATE_WORKING' } } }
    })
    const items: unknown[] = []
    for await (const item of client.stream('SubscribeToTask', { id: 't' })) items.push(item)
    expect(items).toHaveLength(2)
    const [sent] = wire
    expect((sent as JsonRpcRequest)[SERVICE_PARAMETERS]).toEqual({ 'A2A-Version': '1.0' })
    expect(wire.at(-1)).toEqual({ type: 'pai/end', id: (sent as JsonRpcRequest).id })
  })

  it('an error ends a stream without an end frame', async () => {
    const { client, wire } = pair(async function * () {
      yield { task: { id: 't' } }
      throw PaiRpcError.unsupported('nope')
    })
    const items: unknown[] = []
    await expect((async () => { for await (const item of client.stream('SubscribeToTask', { id: 't' })) items.push(item) })())
      .rejects.toMatchObject({ code: ErrorCodes.UnsupportedOperation })
    expect(items).toHaveLength(1)
    expect(wire.some((m) => 'type' in m && m.type === 'pai/end')).toBe(false)
  })
})
