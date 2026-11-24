import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet'
import { afterAll, afterEach, beforeAll } from 'vitest'
import type { Message, SendMessageResponse, StreamResponse, Task } from '../src/a2a/types.js'
import type { AgentRecord, HandshakeContext, Identity, SwarmLike } from '../src/identity/types.js'
import { Pai } from '../src/pai.js'
import type { CardInput, PaiOptions, RawRequestHandler } from '../src/pai.js'
import type { MessageHandler } from '../src/server.js'

export const TEST_KEY = 'pai integration test key'

// A test-only identity: every agent with the same key trusts every other.
// It keeps tests of the transport, tasks and cards apart from groups.
export class TestIdentity implements Identity {
  readonly topic: Buffer
  readonly #auth: Buffer
  readonly #peers = new Map<string, AgentRecord>()

  constructor (key: string = TEST_KEY) {
    this.topic = derive(key, 'topic')
    this.#auth = derive(key, 'auth')
  }

  async discover (swarm: SwarmLike): Promise<void> {
    swarm.join(this.topic, { server: true, client: true })
    await swarm.flush()
  }

  proof (ctx: HandshakeContext): Uint8Array {
    return this.#mac(ctx.handshakeHash, ctx.localPublicKey)
  }

  async authenticate (ctx: HandshakeContext, remoteProof: Uint8Array): Promise<boolean> {
    const expected = this.#mac(ctx.handshakeHash, ctx.remotePublicKey)
    return remoteProof.byteLength === expected.byteLength && timingSafeEqual(remoteProof, expected)
  }

  async resolve (id: Uint8Array): Promise<AgentRecord | null> {
    return this.#peers.get(Buffer.from(id).toString('hex')) ?? null
  }

  remember (record: AgentRecord): void {
    this.#peers.set(Buffer.from(record.id).toString('hex'), record)
  }

  #mac (handshakeHash: Uint8Array, publicKey: Uint8Array): Buffer {
    return createHmac('sha256', this.#auth).update(handshakeHash).update(publicKey).digest()
  }
}

function derive (key: string, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(key), Buffer.from('pai/test'), label, 32))
}

export interface AgentOptions {
  // The TestIdentity key (default TEST_KEY), unless `identity` is given.
  key?: string
  identity?: Identity
  storage?: string
  handler?: MessageHandler
  // Leave the agent open after the test; the caller closes it.
  manual?: boolean
  card?: CardInput
  // Takes over incoming requests (see Pai.onRequest).
  onRequest?: RawRequestHandler
  // Extra Pai options.
  options?: Partial<PaiOptions>
}

// Registers a HyperDHT testnet for the current test file and returns a
// factory for agents that are closed after each test.
export function useTestnet () {
  let testnet: Awaited<ReturnType<typeof createTestnet>>
  const cleanup: Array<() => Promise<void>> = []

  beforeAll(async () => { testnet = await createTestnet(3) })
  afterAll(async () => { await testnet.destroy() })
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!()
  })

  async function tempdir (name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `pai-${name}-`))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    return dir
  }

  async function agent (name: string, opts: AgentOptions = {}): Promise<Pai> {
    const pai = new Pai({
      identity: opts.identity ?? new TestIdentity(opts.key),
      storage: opts.storage ?? await tempdir(name),
      card: opts.card ?? card(name),
      bootstrap: testnet.bootstrap,
      timeout: 10_000,
      ...opts.options
    })
    if (opts.handler) pai.onMessage(opts.handler)
    if (opts.onRequest) pai.onRequest(opts.onRequest)
    try {
      await pai.ready()
    } catch (err) {
      await pai.close().catch(() => {})
      throw err
    }
    if (!opts.manual) cleanup.push(() => pai.close())
    return pai
  }

  // The testnet's DHT bootstrap nodes, for code that makes its own swarm.
  const bootstrap = (): Array<{ host: string, port: number }> => testnet.bootstrap

  return { agent, tempdir, bootstrap }
}

export function card (name: string): CardInput {
  return {
    name,
    description: `${name} test agent`,
    version: '1.0.0',
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'echo', name: 'Echo', description: 'Echoes text', tags: ['test'] }]
  }
}

export function text (t: string, extra: Partial<Message> = {}): Message {
  return { role: 'ROLE_USER', messageId: randomUUID(), parts: [{ text: t }], ...extra }
}

export function agentText (t: string): Message {
  return { role: 'ROLE_AGENT', messageId: randomUUID(), parts: [{ text: t }] }
}

export function firstText (m: Message | undefined): string | undefined {
  const part = m?.parts[0]
  return part && 'text' in part ? part.text : undefined
}

export async function collect (events: AsyncIterable<StreamResponse>): Promise<StreamResponse[]> {
  const out: StreamResponse[] = []
  for await (const ev of events) out.push(ev)
  return out
}

// TASK_STATE_INPUT_REQUIRED → input-required.
export function short (state: string): string {
  return state.replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, '-')
}

// Short label per stream item, for readable assertions.
export function describeEvent (ev: StreamResponse): string {
  if ('message' in ev) return 'message'
  if ('task' in ev) return `task:${short(ev.task.status.state)}`
  if ('statusUpdate' in ev) return `status:${short(ev.statusUpdate.status.state)}`
  const a = ev.artifactUpdate
  return `artifact:${a.artifact.artifactId}${a.append ? ':append' : ''}${a.lastChunk ? ':last' : ''}`
}

// The Message of a SendMessage result, or a failure if it was a Task.
export function messageOf (res: SendMessageResponse): Message {
  if (!('message' in res)) throw new Error(`Expected a message, got a task: ${JSON.stringify(res)}`)
  return res.message
}

// The Task of a SendMessage result, or a failure if it was a Message.
export function taskOf (res: SendMessageResponse): Task {
  if (!('task' in res)) throw new Error(`Expected a task, got a message: ${JSON.stringify(res)}`)
  return res.task
}

export function deferred (): { promise: Promise<void>, resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

// Polls until fn returns truthy, or fails after `timeout` ms.
export async function waitFor (fn: () => unknown, timeout = 15_000, label = 'condition'): Promise<void> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

export async function toArray<T> (it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}
