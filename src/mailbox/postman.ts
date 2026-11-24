import { randomUUID } from 'node:crypto'
import type { Message, SendMessageResponse, StreamResponse, Task } from '../a2a/types.js'
import { A2A_METHODS, A2A_PROTOCOL_VERSION, SERVICE_PARAMS } from '../a2a/types.js'
import { PaiRpcError } from '../errors.js'
import type { Peer } from '../peer.js'
import type { JsonRpcRequest } from '../protocol/jsonrpc.js'
import { ErrorCodes, request } from '../protocol/jsonrpc.js'
import { endsStream } from '../task/task.js'
import { decodeEnvelope, encodeEnvelope, open, seal } from './seal.js'
import type { Envelope, Letter } from './seal.js'
import { DONE_RETENTION, MAX_ENVELOPE_BYTES, MailboxStore, OutboxStore } from './store.js'
import type { Held, Post } from './store.js'

// The binding's mailbox methods (BINDING.md, Section 7).
export const MAILBOX_METHODS = {
  deposit: 'pai/Deposit',
  collect: 'pai/Collect',
  ack: 'pai/Ack'
} as const

// Methods with this prefix are the binding's own, not A2A's.
export const MAILBOX_PREFIX = 'pai/'

const COLLECT_PAGE = 50
const PRUNE_EVERY = 60 * 60 * 1000

// What the postman needs from Pai.
export interface PostmanHost {
  keyPair: { publicKey: Uint8Array, secretKey: Uint8Array }
  // Mailboxes this agent sends through and collects from (hex ids).
  mailboxes: string[]
  // A live, accepted peer, or one dialled within `timeout` ms.
  reach (id: string, timeout: number): Promise<Peer>
  // This agent's own task engine, as if `peer` had called.
  dispatch (req: JsonRpcRequest, peer?: string): Promise<unknown> | AsyncIterable<unknown>
  // As a mailbox: tell a connected recipient it has mail (a pai/mail frame).
  notify (to: string): void
  // Whether `id` is an identity with devices (mail can't be sealed to it),
  // and the identity a device acts for, if any (hex both).
  isPrincipal? (id: string): boolean
  principalOf? (device: string): string | null
}

// Durable sending and the mailbox role. A post is saved first, then
// delivered directly when the recipient is reachable, or handed to a mailbox
// for it to collect later; retried until one works.
export class Postman {
  readonly #host: PostmanHost
  readonly #outbox: OutboxStore
  readonly #mailbox: MailboxStore | null
  readonly #reachTimeout: number
  #flushing: Promise<void> | null = null
  #again = false
  #lastPrune = 0
  #watching = new Set<string>()
  // One collection per mailbox at a time; a call during one waits for it.
  #collecting = new Map<string, Promise<number>>()
  #closed = false

  constructor (host: PostmanHost, storage: string, opts: { serveMailbox: boolean, reachTimeout: number }) {
    this.#host = host
    this.#outbox = new OutboxStore(storage)
    this.#mailbox = opts.serveMailbox ? new MailboxStore(storage) : null
    this.#reachTimeout = opts.reachTimeout
  }

  async ready (): Promise<void> {
    await this.#outbox.ready()
    await this.#mailbox?.ready()
    await this.#prune()
    // Tasks that came by mail before a restart still owe their sender a reply.
    for (const { from, taskId } of await this.#outbox.repliesOwed()) void this.#replyWhenSettled(from, taskId)
  }

  close (): void {
    this.#closed = true
  }

  // ---- sending ----

  async post (to: string, message: Message): Promise<Post> {
    const now = Date.now()
    const post: Post = { id: randomUUID(), to, kind: 'message', body: message, state: 'queued', createdAt: now, updatedAt: now }
    await this.#outbox.put(post)
    void this.flush()
    return post
  }

  async posts (): Promise<Post[]> {
    return await this.#outbox.all()
  }

  // Tries every queued post once. Concurrent calls share one run, and a call
  // during a run schedules one more.
  async flush (): Promise<void> {
    if (this.#flushing) {
      this.#again = true
      return await this.#flushing
    }
    this.#flushing = (async () => {
      if (Date.now() - this.#lastPrune > PRUNE_EVERY) await this.#prune()
      do {
        this.#again = false
        // Agents found unreachable in this pass aren't dialled again in it.
        const unreachable = new Set<string>()
        for (const post of await this.#outbox.queued()) {
          if (this.#closed) return
          await this.#deliver(post, unreachable)
        }
      } while (this.#again && !this.#closed)
    })().finally(() => { this.#flushing = null })
    return await this.#flushing
  }

  async #prune (): Promise<void> {
    this.#lastPrune = Date.now()
    await this.#outbox.prune(Date.now() - DONE_RETENTION).catch(() => {})
  }

  async #deliver (post: Post, unreachable: Set<string>): Promise<void> {
    const errors: string[] = []
    // Messages go straight to the recipient when it's there. Replies always
    // go by mail: the sender has no method that takes a Task.
    if (post.kind === 'message' && !unreachable.has(post.to)) {
      try {
        const peer = await this.#reach(post.to, unreachable)
        const res = await peer.send(post.body as Message, { returnImmediately: true }) as SendMessageResponse
        await this.#update(post, { state: 'delivered', ...('task' in res ? { taskId: res.task.id } : {}) })
        return
      } catch (err) {
        if (rejected(err)) return await this.#update(post, { state: 'failed', lastError: errorText(err) })
        errors.push(`direct: ${errorText(err)}`)
      }
    }
    // Mail is sealed to one device's key; an identity has none of its own,
    // so a post to one waits for one of its devices to be reachable.
    if (this.#host.isPrincipal?.(post.to)) {
      errors.push('an identity: delivered directly once one of its devices is reachable (mailboxes hold mail for one device)')
      return await this.#update(post, { lastError: errors.join('; ') })
    }
    const letter: Letter = post.kind === 'message' ? { kind: 'message', message: post.body as Message } : { kind: 'task', task: post.body as Task }
    const envelope = Buffer.from(encodeEnvelope(seal(this.#host.keyPair, Buffer.from(post.to, 'hex'), letter))).toString('base64url')
    for (const mailbox of this.#host.mailboxes) {
      if (mailbox === post.to || unreachable.has(mailbox)) continue
      try {
        const peer = await this.#reach(mailbox, unreachable)
        await peer.rpc.request(MAILBOX_METHODS.deposit, { to: post.to, envelope })
        await this.#update(post, { state: 'deposited', mailbox })
        return
      } catch (err) {
        errors.push(`mailbox ${mailbox.slice(0, 8)}: ${errorText(err)}`)
      }
    }
    if (!this.#host.mailboxes.length) errors.push('no mailbox configured')
    await this.#update(post, { lastError: errors.join('; ') })
  }

  async #reach (id: string, unreachable: Set<string>): Promise<Peer> {
    try {
      return await this.#host.reach(id, this.#reachTimeout)
    } catch (err) {
      unreachable.add(id)
      throw err
    }
  }

  async #update (post: Post, changes: Partial<Post>): Promise<void> {
    Object.assign(post, changes, { updatedAt: Date.now() })
    await this.#outbox.put(post)
  }

  // ---- collecting ----

  // Takes everything waiting for this agent at a connected mailbox.
  async collect (mailbox: Peer): Promise<number> {
    const key = Buffer.from(mailbox.id).toString('hex')
    const running = this.#collecting.get(key)
    if (running) await running.catch(() => {})
    const run = this.#collect(mailbox).finally(() => { if (this.#collecting.get(key) === run) this.#collecting.delete(key) })
    this.#collecting.set(key, run)
    return await run
  }

  async #collect (mailbox: Peer): Promise<number> {
    let taken = 0
    for (;;) {
      if (this.#closed) return taken
      const { envelopes } = await mailbox.rpc.request<{ envelopes: Held[] }>(MAILBOX_METHODS.collect, { limit: COLLECT_PAGE })
      if (!envelopes.length) return taken
      for (const held of envelopes) {
        await this.#receive(held).catch(() => {})
        taken++
      }
      // Acked once handled: a crash before this means seeing them again,
      // which the retry rule makes harmless.
      await mailbox.rpc.request(MAILBOX_METHODS.ack, { ids: envelopes.map((h) => h.id) })
    }
  }

  async #receive (held: Held): Promise<void> {
    const envelope = decodeEnvelope(Buffer.from(held.envelope, 'base64url'))
    const from = Buffer.from(envelope.from).toString('hex')
    // The mailbox saw who deposited it; the seal proves who wrote it.
    if (from !== held.from) throw new Error('Envelope sender differs from depositor')
    const letter = open(this.#host.keyPair, envelope)
    if (letter.kind === 'message') return await this.#run(from, letter.message)
    await this.#replied(from, letter.task)
  }

  // A message that came by mail runs like any other, as if its sender had
  // called; the result goes back by mail once the task settles.
  async #run (from: string, message: Message): Promise<void> {
    const res = await this.#host.dispatch(rpcRequest(A2A_METHODS.sendMessage, { message, configuration: { returnImmediately: true } }), from) as SendMessageResponse
    if (!('task' in res)) return
    await this.#outbox.oweReply(from, res.task.id)
    void this.#replyWhenSettled(from, res.task.id)
  }

  async #replyWhenSettled (from: string, taskId: string): Promise<void> {
    const key = `${from}/${taskId}`
    if (this.#watching.has(key)) return
    this.#watching.add(key)
    try {
      let task = await this.#host.dispatch(rpcRequest(A2A_METHODS.getTask, { id: taskId })) as Task
      if (!endsStream(task.status.state)) {
        try {
          for await (const _ of this.#host.dispatch(rpcRequest(A2A_METHODS.subscribeToTask, { id: taskId })) as AsyncIterable<StreamResponse>) {
            if (this.#closed) return
          }
        } catch {
          // It ended between the read and the subscribe: read it again below.
        }
        task = await this.#host.dispatch(rpcRequest(A2A_METHODS.getTask, { id: taskId })) as Task
      }
      if (this.#closed) return
      const now = Date.now()
      await this.#outbox.put({ id: randomUUID(), to: from, kind: 'task', body: task, state: 'queued', createdAt: now, updatedAt: now, taskId })
      await this.#outbox.settleReply(from, taskId)
      void this.flush()
    } catch {
      // Gone (a stateless reply, say): nothing to send back.
      await this.#outbox.settleReply(from, taskId).catch(() => {})
    } finally {
      this.#watching.delete(key)
    }
  }

  // A task the recipient sent back: attached to the post whose message it ran.
  async #replied (from: string, task: Task): Promise<void> {
    const ids = new Set((task.history ?? []).map((m) => m.messageId))
    // Only posts already handed over can have a reply.
    for (const post of await this.#outbox.done()) {
      // A reply comes from a device; the post may name its identity.
      if (post.kind !== 'message' || (post.to !== from && post.to !== this.#host.principalOf?.(from))) continue
      if (post.taskId === task.id || ids.has((post.body as Message).messageId)) {
        await this.#update(post, { taskId: task.id, task })
      }
    }
  }

  // ---- the mailbox role ----

  get servesMailbox (): boolean {
    return this.#mailbox !== null
  }

  // Answers pai/Deposit, pai/Collect and pai/Ack from `caller`.
  async handle (req: JsonRpcRequest, caller: string): Promise<unknown> {
    const mailbox = this.#mailbox
    if (!mailbox) throw new PaiRpcError(ErrorCodes.MethodNotFound, `Method not found: ${req.method} (this agent is not a mailbox)`)
    const params = (req.params ?? {}) as Record<string, unknown>
    switch (req.method) {
      case MAILBOX_METHODS.deposit: {
        const { to, envelope } = params
        if (typeof to !== 'string' || !/^[0-9a-f]{64}$/.test(to)) throw PaiRpcError.invalidParams('to must be an agent id', 'to')
        if (typeof envelope !== 'string') throw PaiRpcError.invalidParams('envelope must be a base64url string', 'envelope')
        const bytes = Buffer.from(envelope, 'base64url')
        if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw PaiRpcError.invalidParams(`envelope is over ${MAX_ENVELOPE_BYTES} bytes`, 'envelope')
        let decoded: Envelope
        try {
          decoded = decodeEnvelope(bytes)
        } catch (err) {
          throw PaiRpcError.invalidParams(`envelope: ${(err as Error).message}`, 'envelope')
        }
        // A depositor can only send as itself, to the recipient it names.
        if (Buffer.from(decoded.from).toString('hex') !== caller) throw PaiRpcError.invalidParams('envelope is not from this agent', 'envelope')
        if (Buffer.from(decoded.to).toString('hex') !== to) throw PaiRpcError.invalidParams('envelope is not for that agent', 'envelope')
        try {
          const held = await mailbox.deposit(to, caller, envelope)
          this.#host.notify(to)
          return { id: held.id }
        } catch (err) {
          throw PaiRpcError.unsupported((err as Error).message)
        }
      }
      case MAILBOX_METHODS.collect: {
        const limit = params.limit === undefined ? COLLECT_PAGE : params.limit
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > COLLECT_PAGE) throw PaiRpcError.invalidParams(`limit must be between 1 and ${COLLECT_PAGE}`, 'limit')
        return { envelopes: await mailbox.collect(caller, limit as number) }
      }
      case MAILBOX_METHODS.ack: {
        const { ids } = params
        if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) throw PaiRpcError.invalidParams('ids must be an array of strings', 'ids')
        await mailbox.ack(caller, ids as string[])
        return {}
      }
      default:
        throw new PaiRpcError(ErrorCodes.MethodNotFound, `Method not found: ${req.method}`)
    }
  }
}

function rpcRequest (method: string, params: unknown): JsonRpcRequest {
  return request(randomUUID(), method, params, { [SERVICE_PARAMS.version]: A2A_PROTOCOL_VERSION })
}

// The recipient got the message and said no (invalid, unsupported...):
// retrying won't change that, so the post is done.
function rejected (err: unknown): boolean {
  return err instanceof PaiRpcError
}

function errorText (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
