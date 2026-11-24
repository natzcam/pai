import HyperDHT from 'hyperdht'
import type { BootstrapNode } from 'hyperdht'
import Hyperswarm from 'hyperswarm'
import { validateCard } from './a2a/card.js'
import type { AgentCard, AgentInterface } from './a2a/types.js'
import { A2A_PROTOCOL_VERSION, PAI_BINDING, SERVICE_PARAMS } from './a2a/types.js'
import { PaiAuthError, PaiCardError, PaiConnectionError, PaiRpcError } from './errors.js'
import type { AgentRecord, HandshakeContext, Identity } from './identity/types.js'
import { Peer } from './peer.js'
import type { CardSource } from './peer.js'
import { PAI_VERSION, createChannel } from './protocol/channel.js'
import type { JsonRpcMessage, JsonRpcRequest } from './protocol/jsonrpc.js'
import { ErrorCodes, request } from './protocol/jsonrpc.js'
import type { ChannelHandshake } from './protocol/channel.js'
import { RpcConnection } from './protocol/rpc.js'
import type { DispatchContext, MessageHandler } from './server.js'
import { Server, encodeCursor, listPage, newestFirst, withHistory } from './server.js'
import type { CallOptions } from './protocol/rpc.js'
import { MAILBOX_PREFIX, Postman } from './mailbox/postman.js'
import type { Post } from './mailbox/store.js'
import type { ListTasksRequest, ListTasksResponse, Message, SendMessageConfiguration, SendMessageResponse, StreamResponse, Task } from './a2a/types.js'
import { A2A_METHODS } from './a2a/types.js'
import { endsStream } from './task/task.js'
import type { CardOptions } from './peer.js'
import { TaskStore } from './store/task-store.js'
import { SharedTaskStore } from './store/shared-store.js'
import { EventQueue } from './util/queue.js'
import { loadKeyPair } from './store/key-file.js'
import { lockStorage } from './util/lock.js'

export interface PaiOptions {
  identity: Identity
  // The agent's folder: its key pair (agent.key), tasks and mail, as files.
  // One agent at a time (pai.lock). Nothing in it is replicated to peers.
  storage: string
  // The key pair, when it's kept elsewhere (the phone keeps it in the
  // OS's key store): then agent.key isn't read or written.
  keyPair?: { publicKey: Uint8Array, secretKey: Uint8Array }
  // Sent to each peer once connected, and again on updateCard(), with this
  // agent's pai interface in supportedInterfaces (see CardInput).
  card: CardInput
  // The pai protocol version to speak: tests only (default PAI_VERSION).
  protocolVersion?: number
  // Replaces the whole DHT bootstrap list, mainly for tests. Otherwise
  // Holepunch's default nodes are used, plus any from identity.bootstrap().
  bootstrap?: BootstrapNode[]
  // How long connect() and peer.card() wait before giving up. Default 30s.
  timeout?: number
  // Mailboxes (agent ids) this agent posts through when a recipient is
  // offline, and collects its own mail from. See post().
  mailboxes?: Uint8Array[]
  // Act as a mailbox: hold sealed mail for other agents until they collect it.
  serveMailbox?: boolean
  // How often queued posts are retried and mailboxes checked. Default 20s.
  mailInterval?: number
}

interface Waiter {
  resolve (peer: Peer): void
  reject (err: Error): void
}

const DEFAULT_TIMEOUT = 30_000
const MAIL_INTERVAL = 20_000

// A card as the agent supplies it. pai fills in its own interface
// ({ url: pai://<hex id>, protocolBinding: PAI_BINDING }): an entry with
// that binding is corrected in place, otherwise it's added first. Other
// interfaces (an HTTPS bridge, say) are kept in their order.
export type CardInput = Omit<AgentCard, 'supportedInterfaces'> & { supportedInterfaces?: AgentInterface[] }

// Handles a raw JSON-RPC request from a peer instead of pai's task engine:
// return a value for one response, or an async iterable to stream.
export type RawRequestHandler = (req: JsonRpcRequest, ctx: DispatchContext) => Promise<unknown> | AsyncIterable<unknown>

export class Pai {
  #handler: MessageHandler | null = null
  #rawHandler: RawRequestHandler | null = null
  // Why the last connection to each agent closed before it was usable, for
  // connect()'s timeout message.
  #lastClose = new Map<string, string>()
  #unlock: (() => Promise<void>) | null = null
  #swarm: Hyperswarm | null = null
  #tasks: TaskStore | null = null
  #server: Server | null = null
  // Peers with a live, authenticated connection right now.
  #peers = new Map<string, Peer>()
  #waiters = new Map<string, Waiter[]>()
  // The latest card each remote agent pushed, kept across reconnects.
  #remoteCards = new Map<string, CardBox>()
  // Connections this agent has accepted, by remote id, which get its card on
  // each change.
  #accepted = new Map<string, { send (msg: unknown): void }>()
  #card: AgentCard | null = null
  #postman: Postman | null = null
  #mailTimer: NodeJS.Timeout | null = null
  // Authenticated connections by remote id, re-checked when the identity's
  // admissions change.
  #links = new Map<string, Set<Link>>()
  // The principal each admitted device acts for, when it isn't itself.
  #principals = new Map<string, string>()
  // connect-by-principal calls waiting for a matching device.
  #routeWaiters = new Set<RouteWaiter>()
  // Agents that last refused this one (pai/refused), until one accepts
  // it, and why, when they said.
  #refusedBy = new Map<string, string>()
  // Agents that last spoke another pai protocol version, and what that means.
  #versionGap = new Map<string, string>()
  get #version (): number { return this.options.protocolVersion ?? PAI_VERSION }
  #unwatch: (() => void) | null = null

  constructor (readonly options: PaiOptions) {}

  // Locks the storage folder, loads the key pair, recovers tasks, starts
  // Hyperswarm and runs discover().
  async ready (): Promise<void> {
    const { identity, bootstrap } = this.options
    // The id isn't known yet; check everything else before opening storage.
    assertCard(withPaiInterface(this.options.card, 'pending'))
    const keyPair = this.options.keyPair ?? await loadKeyPair(this.options.storage)
    this.#unlock = await lockStorage(this.options.storage)

    // A group agent's tasks are shared in its groups (Identity.tasks).
    const sharing = (): ReturnType<NonNullable<Identity['tasks']>> => identity.tasks?.() ?? null
    const tasks = identity.tasks ? new SharedTaskStore(this.options.storage, sharing) : new TaskStore(this.options.storage)
    await tasks.ready()
    this.#tasks = tasks
    // Task ids name their device, so calls to an identity with several
    // devices can follow a task to the one that has it.
    const server = new Server(tasks, () => this.#handler, `${hex(keyPair.publicKey).slice(0, TASK_PREFIX)}.`, sharing)
    this.#server = server
    await server.recover()

    const nodes = await bootstrapNodes(bootstrap, identity)
    const swarm = new Hyperswarm(nodes ? { keyPair, bootstrap: nodes } : { keyPair })
    swarm.on('connection', (conn) => { void this.#onConnection(conn) })
    this.#swarm = swarm

    this.#card = withPaiInterface(this.options.card, hex(this.id))
    // Before discover(): peers can connect, and admissions change, while it runs.
    this.#unwatch = identity.onAdmissionChange?.(() => {
      for (const set of this.#links.values()) for (const link of set) link.check()
    }) ?? null
    await identity.discover(swarm, this.#self())
    // What changed before the groups opened (recovery's failed tasks, say)
    // goes out now.
    if (tasks instanceof SharedTaskStore) await tasks.publishNewer().catch(noop)

    const mailboxes = (this.options.mailboxes ?? []).map(hex)
    const postman = new Postman({
      keyPair: swarm.keyPair,
      mailboxes,
      reach: async (id, timeout) => await this.#reach(id, timeout),
      dispatch: (req, peer) => {
        if (peer === undefined) return server.dispatch(req)
        const caller = this.#principal(peer)
        this.#checkPolicy(caller)
        return server.dispatch(req, { peer: caller })
      },
      notify: (to) => { this.#accepted.get(to)?.send(MAIL_FRAME) },
      isPrincipal: (id) => this.options.identity.isPrincipal?.(Buffer.from(id, 'hex')) ?? false,
      principalOf: (device) => this.#principals.get(device) ?? null
    }, this.options.storage, { serveMailbox: this.options.serveMailbox === true, reachTimeout: Math.min(5000, this.options.timeout ?? DEFAULT_TIMEOUT) })
    await postman.ready()
    this.#postman = postman
    for (const id of mailboxes) swarm.joinPeer(Buffer.from(id, 'hex'))
    this.#mailTimer = setInterval(() => { void this.#checkMail() }, this.options.mailInterval ?? MAIL_INTERVAL)
    this.#mailTimer.unref()
    void this.#checkMail()
  }

  // Sends a message that survives this agent or the recipient being offline:
  // saved first, then delivered directly if the recipient is reachable, or
  // left at a mailbox for it to collect. Retried until one works. The post's
  // `task` fills in when the recipient's result comes back by mail.
  async post (to: Uint8Array, message: Message): Promise<Post> {
    return await this.#mail().post(hex(to), message)
  }

  // Every post this agent has made, oldest first, and replies it owes.
  async posts (): Promise<Post[]> {
    return await this.#mail().posts()
  }

  // Retries queued posts, and collects from connected mailboxes.
  async #checkMail (key?: string): Promise<void> {
    const postman = this.#postman
    if (!postman) return
    const mailboxes = (this.options.mailboxes ?? []).map(hex)
    for (const id of key === undefined ? mailboxes : mailboxes.filter((m) => m === key)) {
      const peer = this.#peers.get(id)
      if (peer && !peer.closed) await postman.collect(peer).catch(noop)
    }
    await postman.flush().catch(noop)
  }

  // A connected peer, or one dialled within `timeout` ms.
  async #reach (id: string, timeout: number): Promise<Peer> {
    const existing = this.#peers.get(id)
    if (existing && !existing.closed) return existing
    // An identity is reached through any of its devices.
    return await withTimeout(this.route(Buffer.from(id, 'hex')), timeout, `Timed out reaching ${id.slice(0, 8)}…`)
  }

  // For an app the OS pauses (a phone's): suspend before it does, so the
  // swarm's connections and DHT state wind down cleanly, and resume after,
  // so it announces and reconnects at once instead of on stale state.
  async suspend (): Promise<void> {
    await this.#swarm?.suspend()
  }

  async resume (): Promise<void> {
    await this.#swarm?.resume()
  }

  // Agent id (Noise public key). Available after ready().
  get id (): Uint8Array {
    if (!this.#swarm) throw new Error('Pai is not ready')
    return this.#swarm.keyPair.publicKey
  }

  // Peers with a live, authenticated connection right now.
  get peers (): Peer[] {
    return [...this.#peers.values()]
  }

  async card (): Promise<AgentCard | null> {
    this.#ready()
    return this.#card
  }

  // Replaces the card and pushes it to connected peers; peers watching it
  // see the new version. Throws PaiCardError if the card doesn't match the
  // A2A schema.
  async updateCard (card: CardInput): Promise<void> {
    const full = withPaiInterface(card, hex(this.id))
    assertCard(full)
    this.#card = full
    for (const channel of this.#accepted.values()) channel.send(cardFrame(full))
    await this.options.identity.refresh?.(this.#self())
  }

  onMessage (handler: MessageHandler): void {
    this.#handler = handler
  }

  // Takes over every incoming request: pai's task engine and onMessage are
  // bypassed, and the handler answers the A2A methods itself (to forward
  // them to another A2A server, say). Checking A2A-Version is up to it.
  onRequest (handler: RawRequestHandler): void {
    this.#rawHandler = handler
  }

  // Dials the agent by id and resolves once the a2a/v1 channel is open and
  // both sides have authenticated.
  async connect (id: Uint8Array): Promise<Peer> {
    const { swarm } = this.#ready()
    const key = hex(id)
    const existing = this.#peers.get(key)
    if (existing && !existing.closed) return existing

    const timeout = this.options.timeout ?? DEFAULT_TIMEOUT
    const connected = new Promise<Peer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#dropWaiter(key, waiter)
        const last = this.#refusedBy.get(key) ?? this.#lastClose.get(key)
        reject(new PaiConnectionError(`Timed out connecting to ${key}${last ? ` (${last})` : ''}`))
      }, timeout)
      const waiter: Waiter = {
        resolve: (peer) => { clearTimeout(timer); resolve(peer) },
        reject: (err) => { clearTimeout(timer); reject(err) }
      }
      const list = this.#waiters.get(key) ?? []
      list.push(waiter)
      this.#waiters.set(key, list)
    })

    swarm.joinPeer(id)
    try {
      return await connected
    } catch (err) {
      swarm.leavePeer(id)
      throw err
    }
  }

  // A peer for a call to `id`: `id` itself if it's a device, or, if the
  // identity says `id` is a principal (a group member's identity), one of
  // its devices: the one a task-addressed call's task id names, else any
  // that's connected, else the first to connect. `method` and `params` are
  // the JSON-RPC call's, to find a task id.
  async route (id: Uint8Array, method?: string, params?: unknown): Promise<Peer> {
    const { identity } = this.options
    if (!identity.isPrincipal) return await this.connect(id)
    if (!identity.isPrincipal(id)) {
      // Not known as a principal here (yet: a roster still syncing, say):
      // whichever answers first, `id` as a device or a device acting for it.
      // A refusal from `id` itself settles it at once.
      const via = new AbortController()
      try {
        return await new Promise<Peer>((resolve, reject) => {
          let failures = 0
          const fail = (err: unknown): void => { if (++failures === 2) reject(err) }
          this.connect(id).then(resolve, (err: unknown) => { if (err instanceof PaiAuthError) reject(err); else fail(err) })
          this.#viaDevice(id, method, params, via.signal).then(resolve, fail)
        })
      } finally {
        via.abort()
      }
    }
    return await this.#viaDevice(id, method, params)
  }

  async #viaDevice (id: Uint8Array, method?: string, params?: unknown, signal?: AbortSignal): Promise<Peer> {
    const target = hex(id)
    const { prefix, taskId } = taskDevice(method, params)
    const ofTarget = (device: string): boolean => this.#principals.get(device) === target
    // When tasks are shared in groups, any device of the identity can take up a
    // task its sibling ran, but not one still running there (its device
    // has the runner): only waiting or finished ones. The task's own device
    // is still preferred.
    const sharedTasks = this.options.identity.tasks?.() ?? null
    const copy = sharedTasks && taskId ? await sharedTasks.getOf(target, taskId) : null
    const running = copy !== null && (copy.task.status.state === 'TASK_STATE_WORKING' || copy.task.status.state === 'TASK_STATE_SUBMITTED')
    const anyDevice = sharedTasks !== null && !running
    const match = (device: string): boolean => ofTarget(device) && (prefix === null || anyDevice || device.startsWith(prefix))
    const connected = [...this.#peers].filter(([device, peer]) => !peer.closed && match(device))
    const preferred = connected.find(([device]) => prefix !== null && device.startsWith(prefix)) ?? connected[0]
    if (preferred) return preferred[1]
    const timeout = this.options.timeout ?? DEFAULT_TIMEOUT
    return await new Promise<Peer>((resolve, reject) => {
      const waiter: RouteWaiter = {
        match,
        resolve: (peer) => { done(); resolve(peer) },
        reject: (err) => { done(); reject(err) }
      }
      const timer = setTimeout(() => {
        waiter.reject(new PaiConnectionError(prefix
          ? `Timed out reaching the device of ${target.slice(0, 8)}… that has task ${(params as { id?: string, message?: { taskId?: string } })?.id ?? (params as { message?: { taskId?: string } })?.message?.taskId}`
          : `Timed out reaching any device of ${target.slice(0, 8)}…`))
      }, timeout)
      const stop = (): void => { waiter.reject(new PaiConnectionError('Canceled')) }
      const done = (): void => { clearTimeout(timer); this.#routeWaiters.delete(waiter); signal?.removeEventListener('abort', stop) }
      this.#routeWaiters.add(waiter)
      signal?.addEventListener('abort', stop, { once: true })
    })
  }

  // The connected devices acting for principal `id`.
  devicesOf (id: Uint8Array): Peer[] {
    const target = hex(id)
    return [...this.#peers].filter(([device, peer]) => !peer.closed && this.#principals.get(device) === target).map(([, peer]) => peer)
  }

  // ListTasks on `id`: just its own when it's a device. For an identity,
  // every connected device of it is asked, and, when tasks are shared in
  // groups, the groups' replicas too (so devices that are offline count),
  // merged newest first. Pages stay consistent because the page token is a
  // cursor (time, task id) that orders every source's tasks. Devices that
  // fail to answer are left out, and totalSize counts what answered.
  async listTasksOf (id: Uint8Array, params: ListTasksRequest = {}): Promise<ListTasksResponse> {
    const { identity } = this.options
    if (!identity.isPrincipal?.(id)) return await (await this.connect(id)).listTasks(params)
    const shared = identity.tasks?.() ?? null
    let devices = this.devicesOf(id)
    if (devices.length === 0 && !shared) devices = [await this.route(id)]
    const pageSize = params.pageSize ?? 50
    // With the groups' copies, live devices are asked for their newest tasks
    // from the top (not after the cursor): their fresh copies must replace
    // the copy's older ones, or a task could show up on two pages.
    const live = shared ? { ...params, pageToken: undefined, pageSize: 100 } : { ...params, pageSize }
    const pages = await Promise.allSettled(devices.map(async (peer) => await peer.listTasks(live)))
    const answered = pages.filter((p): p is PromiseFulfilledResult<ListTasksResponse> => p.status === 'fulfilled').map((p) => p.value)
    if (!shared && answered.length === 0) throw (pages[0] as PromiseRejectedResult).reason
    if (!shared) {
      // Each device's page goes on where the merged one stops: the token is
      // a cursor that every device reads the same way.
      const all = answered.flatMap((p) => p.tasks).sort(newestFirst)
      const page = all.slice(0, pageSize)
      const last = page.at(-1)
      const more = all.length > pageSize || answered.some((p) => p.nextPageToken)
      return {
        tasks: page,
        nextPageToken: more && last ? encodeCursor(last) : '',
        pageSize,
        totalSize: answered.reduce((n, p) => n + (p.totalSize ?? p.tasks.length), 0)
      }
    }
    const target = hex(id)
    // Live answers first: they're fresher than the replica's copies, which
    // hold every task (so the merged page needs no device continuations).
    async function * source (): AsyncGenerator<Task> {
      for (const page of answered) yield * page.tasks
      for await (const { task } of shared!.listOf(target)) yield task
    }
    return await listPage(source(), { ...params, pageSize })
  }

  // GetTask on `id`: from a device of it, or, when none is connected and
  // tasks are shared in groups, from the groups' replicas (also when the
  // device can't be reached).
  async getTaskOf (id: Uint8Array, taskId: string, historyLength?: number, opts: CallOptions = {}): Promise<Task> {
    const { identity } = this.options
    const shared = identity.isPrincipal?.(id) ? identity.tasks?.() ?? null : null
    const copy = shared ? await shared.getOf(hex(id), taskId) : null
    if (copy && this.devicesOf(id).length === 0) return withHistory(copy.task, historyLength)
    try {
      const params = historyLength === undefined ? { id: taskId } : { id: taskId, historyLength }
      return await (await this.route(id, A2A_METHODS.getTask, params)).rpc.request(A2A_METHODS.getTask, params, opts) as Task
    } catch (err) {
      if (copy && err instanceof PaiConnectionError) return withHistory(copy.task, historyLength)
      throw err
    }
  }

  // The agent `id` (a device, or a principal with devices) as one handle:
  // each call goes where route() sends it.
  agent (id: Uint8Array): RoutedAgent {
    return new RoutedAgent(this, id)
  }

  // Who a request from `device` comes from: its identity if the identity
  // admits it now, else the device itself.
  #principal (device: string): string {
    return this.options.identity.principalOf?.(Buffer.from(device, 'hex')) ?? device
  }

  async close (): Promise<void> {
    for (const w of this.#routeWaiters) w.reject(new PaiConnectionError('Pai closed'))
    this.#unwatch?.()
    this.#unwatch = null
    this.#links.clear()
    if (this.#mailTimer) clearInterval(this.#mailTimer)
    this.#postman?.close()
    for (const waiters of this.#waiters.values()) {
      for (const w of waiters) w.reject(new PaiConnectionError('Pai closed'))
    }
    this.#waiters.clear()
    await this.options.identity.close?.().catch(noop)
    await this.#swarm?.destroy()
    for (const box of this.#remoteCards.values()) box.end()
    this.#remoteCards.clear()
    this.#accepted.clear()
    this.#peers.clear()
    await this.#tasks?.close()
    await this.#unlock?.()
    this.#unlock = null
  }

  async #onConnection (conn: any): Promise<void> {
    const { server } = this.#ready()
    const { identity } = this.options
    conn.on('error', noop)
    if ((await conn.opened) === false) return

    const remoteKey: Uint8Array = conn.remotePublicKey
    const key = hex(remoteKey)
    const ctx: HandshakeContext = {
      handshakeHash: conn.handshakeHash,
      localPublicKey: conn.publicKey,
      remotePublicKey: remoteKey
    }

    // Where this side is with the remote: checking its proof, holding it
    // (identity says 'pending'), admitted, or done (refused or closed).
    let state: 'checking' | 'pending' | 'admitted' | 'done' = 'checking'
    // Messages that arrive while the proof is being checked (briefly).
    let held: unknown[] = []
    // The remote's latest card while it's pending, applied on admission.
    let heldCard: AgentCard | null = null
    // The remote's verdict on us. Identities can disagree (one side may have
    // revoked the other), so a connection only counts once both sides accept.
    let isAccepted = false
    let markAccepted: () => void = noop
    const accepted = new Promise<void>((resolve) => { markAccepted = () => { isAccepted = true; resolve() } })
    let peer: Peer | null = null
    let acceptedChannel: { send (msg: unknown): void } | null = null
    // Registered in #links once the proof checks out, for admission changes.
    let link: Link | null = null

    const unlink = (): void => {
      if (!link) return
      const set = this.#links.get(key)
      set?.delete(link)
      if (set?.size === 0) this.#links.delete(key)
      link = null
    }
    // `speaks`: this side's protocol version, when the remote spoke another
    // (so it can say so).
    const refuse = (err: Error, speaks?: number): void => {
      if (state === 'done') return
      state = 'done'
      held = []
      heldCard = null
      unlink()
      this.#rejectWaiters(key, err)
      // Say so before closing: a plain close could be a dropped duplicate,
      // which the other side waits out.
      channel?.send((speaks === undefined ? REFUSED_FRAME : { ...REFUSED_FRAME, version: speaks }) as unknown as JsonRpcMessage)
      conn.end()
      setTimeout(() => conn.destroy(), REFUSE_GRACE).unref()
    }
    const admit = (): void => {
      if (state !== 'checking' && state !== 'pending') return
      state = 'admitted'
      const record: AgentRecord = { id: remoteKey }
      identity.remember?.(record)
      peer = new Peer(record, rpc, this.#cardSource(key))
      channel?.send(READY_FRAME as unknown as JsonRpcMessage)
      if (channel && this.#card) {
        const accepted = { send: (msg: unknown) => { channel.send(msg as JsonRpcMessage) } }
        this.#accepted.set(key, accepted)
        acceptedChannel = accepted
        accepted.send(cardFrame(this.#card))
      }
      if (heldCard) this.#cardBox(key).set(heldCard)
      heldCard = null
      const queued = held
      held = []
      for (const msg of queued) receive(msg)
      const ready = peer
      void accepted.then(() => {
        if (conn.destroyed) return
        // Recorded with the peer, and dropped with it (see onclose).
        const principal = identity.principalOf?.(remoteKey)
        if (principal && principal !== key) this.#principals.set(key, principal)
        else this.#principals.delete(key)
        this.#peers.set(key, ready)
        this.#lastClose.delete(key)
        identity.connected?.({ id: remoteKey, get closed () { return rpc.closed }, request: async (method, params) => await rpc.request(method, params) })
        this.#resolveWaiters(key, ready)
        for (const w of this.#routeWaiters) {
          if (w.match(key)) w.resolve(ready)
        }
        // A mailbox may hold mail, and a recipient may now be reachable.
        void this.#checkMail(key)
      })
    }
    // A message from the remote. Nothing is processed before this side
    // admits it: held while its proof is checked, dropped while it's
    // pending (all but its latest card) or refused.
    const receive = (msg: unknown): void => {
      if (state === 'checking') {
        // A remote shouldn't send before it's accepted; one that floods is cut off.
        if (held.length >= MAX_HELD) refuse(new PaiAuthError('Too many messages before authenticating'))
        else held.push(msg)
        return
      }
      if (isFrame(msg, 'pai/card')) {
        const card = (msg as { card?: unknown }).card
        if (typeof card !== 'object' || card === null) return
        if (state === 'admitted') this.#cardBox(key).set(card as AgentCard)
        else if (state === 'pending') heldCard = card as AgentCard
        return
      }
      if (state !== 'admitted') return
      if (isFrame(msg, 'pai/mail')) {
        void this.#checkMail(key)
        return
      }
      rpc.receive(msg as JsonRpcMessage)
    }

    const channel = createChannel(conn, {
      onopen: async (remote) => {
        // Another protocol version: say so, here and to the remote.
        if (remote.version !== this.#version) {
          const why = versionGap(remote.version, this.#version)
          this.#lastClose.set(key, why)
          this.#versionGap.set(key, why)
          refuse(new PaiAuthError(`Peer failed authentication: ${why}`), this.#version)
          return
        }
        this.#versionGap.delete(key)
        const ok = await this.#verify(ctx, remote).catch(() => false)
        if (!ok) {
          refuse(new PaiAuthError())
          return
        }
        if (state !== 'checking') return // closed meanwhile
        // A peer the identity already refuses gets nothing, not even a sync.
        if (identity.admits?.(remoteKey) === false) {
          refuse(new PaiAuthError())
          return
        }
        identity.attach?.(conn, remoteKey)
        // Calls wait until the identity admits the peer; until then the
        // connection only carries what attach() put on it.
        link = {
          check: () => {
            if (conn.destroyed || state === 'done') return
            const admits = identity.admits?.(remoteKey) ?? true
            // 'pending' never drops a peer already admitted: it only means the
            // signed state hasn't caught up (a renewal still being signed, say).
            if (admits === true) admit()
            else if (admits === false) refuse(new PaiAuthError(state === 'admitted' ? 'No longer admitted' : undefined))
          }
        }
        const set = this.#links.get(key) ?? new Set<Link>()
        set.add(link)
        this.#links.set(key, set)
        const admits = identity.admits?.(remoteKey) ?? true
        if (admits === true) {
          admit()
        } else if (admits === false) {
          refuse(new PaiAuthError())
        } else {
          state = 'pending'
          // Of what arrived during the check, only its latest card is kept.
          const queued = held
          held = []
          for (const msg of queued) receive(msg)
          channel?.send(WAITING_FRAME as unknown as JsonRpcMessage)
        }
      },
      onmessage: (msg) => {
        if (isFrame(msg, 'pai/ready')) {
          this.#refusedBy.delete(key)
          markAccepted()
          return
        }
        if (isFrame(msg, 'pai/refused')) {
          // Remembered: a later connect() that times out says why.
          // A version only means something if it's another one.
          const speaks = (msg as { version?: unknown }).version
          const why = Number.isInteger(speaks) && (speaks as number) >= 1 && speaks !== this.#version ? versionGap(speaks as number, this.#version) : 'the peer refused this agent'
          // Our own reading of its handshake says the same, when it had one.
          const reason = this.#versionGap.get(key) ?? why
          this.#refusedBy.set(key, reason)
          this.#rejectWaiters(key, new PaiAuthError(`Peer refused this agent${reason === 'the peer refused this agent' ? '' : `: ${reason}`}`))
          return
        }
        if (isFrame(msg, 'pai/waiting')) {
          this.#lastClose.set(key, 'the peer has not admitted this agent yet: are both in a group, and synced?')
          return
        }
        receive(msg)
      },
      onclose: () => {
        const was = state
        state = 'done'
        held = []
        heldCard = null
        unlink()
        if (acceptedChannel && this.#accepted.get(key) === acceptedChannel) this.#accepted.delete(key)
        rpc.close()
        if (peer && this.#peers.get(key) === peer) {
          this.#peers.delete(key)
          this.#principals.delete(key)
        }
        // Not fatal: when both sides dial at once, Hyperswarm keeps one
        // connection and closes the other. Waiters hold on for another
        // connection until connect() times out; a refusal comes as a frame.
        if (was === 'checking') this.#lastClose.set(key, 'the peer closed the connection before authenticating')
        else if (!isAccepted && was !== 'pending') this.#lastClose.set(key, 'the peer closed the connection before accepting this agent')
      }
    })
    if (channel === null) return

    const rpc = new RpcConnection(
      { send: (msg) => { channel.send(msg as JsonRpcMessage) } },
      (req) => {
        if (identity.serves?.(req.method) && identity.serve) return identity.serve(req.method, req.params, key)
        if (req.method.startsWith(MAILBOX_PREFIX) && this.#postman) return this.#postman.handle(req, key)
        // Tasks belong to the caller's principal (its identity, when it has
        // one), so any of its devices can continue or cancel them.
        const caller = this.#principal(key)
        this.#checkPolicy(caller)
        return this.#rawHandler ? this.#rawHandler(req, { peer: caller }) : server.dispatch(req, { peer: caller })
      },
      { serviceParameters: { [SERVICE_PARAMS.version]: A2A_PROTOCOL_VERSION } }
    )
    channel.open({ version: this.#version, proof: identity.proof(ctx) })
  }

  // Runs `message` through this agent's own handler, as if `as` (an
  // identity or device, hex) had sent it: the task is `as`'s, to read and
  // cancel. Resolves with the task once it ends or stops for input;
  // `onTask` hears it as soon as it exists. A message id seen before from
  // `as` gets the task it went to, run or not.
  // (Through the raw request handler when there is one, as `--proxy` sets:
  // then the task is the upstream's, and a stateless reply comes back as a
  // Message.)
  async runLocal (message: Message, as: string, onTask?: (task: Task) => void): Promise<Task | Message> {
    const res = await this.#local(A2A_METHODS.sendMessage, { message, configuration: { returnImmediately: true } }, as) as SendMessageResponse
    if (!('task' in res)) return res.message
    onTask?.(res.task)
    if (endsStream(res.task.status.state)) return res.task
    try {
      for await (const _ of this.#local(A2A_METHODS.subscribeToTask, { id: res.task.id }, as) as AsyncIterable<StreamResponse>) {}
    } catch {} // it ended between the send and the subscribe
    return await this.#local(A2A_METHODS.getTask, { id: res.task.id }, as) as Task
  }

  // Cancels a task runLocal started for `as`.
  async cancelLocal (taskId: string, as?: string): Promise<Task> {
    return await this.#local(A2A_METHODS.cancelTask, { id: taskId }, as) as Task
  }

  #local (method: string, params: unknown, as?: string): Promise<unknown> | AsyncIterable<unknown> {
    const { server } = this.#ready()
    const req = localRequest(method, params)
    if (this.#rawHandler) return this.#rawHandler(req, { peer: as ?? hex(this.id) })
    return method === A2A_METHODS.sendMessage ? server.dispatch(req, { peer: as! }) : server.dispatch(req)
  }

  // Throws unless the identity's policy lets `caller` (a principal or
  // device, hex) call this agent.
  #checkPolicy (caller: string): void {
    if (this.options.identity.mayCall?.(caller) === false) {
      throw PaiRpcError.a2a(ErrorCodes.InvalidRequest, 'NOT_ALLOWED_BY_POLICY', 'The group\'s policy doesn\'t let this agent call that one')
    }
  }

  async #verify (ctx: HandshakeContext, remote: ChannelHandshake): Promise<boolean> {
    return await this.options.identity.authenticate(ctx, remote.proof)
  }

  // A peer's card is what it last pushed (see #onConnection).
  #cardSource (key: string): CardSource {
    const box = this.#cardBox(key)
    const timeout = this.options.timeout ?? DEFAULT_TIMEOUT
    return {
      read: async () => await withTimeout(box.first(), timeout, 'Timed out waiting for the remote card'),
      watch: (signal) => box.watch(signal)
    }
  }

  #cardBox (key: string): CardBox {
    let box = this.#remoteCards.get(key)
    if (!box) {
      box = new CardBox()
      this.#remoteCards.set(key, box)
    }
    return box
  }

  #self (): AgentRecord {
    const record: AgentRecord = { id: this.id, name: this.#card?.name ?? this.options.card.name }
    if (this.#card) record.card = this.#card
    return record
  }

  #resolveWaiters (key: string, peer: Peer): void {
    const list = this.#waiters.get(key)
    this.#waiters.delete(key)
    for (const w of list ?? []) w.resolve(peer)
  }

  #rejectWaiters (key: string, err: Error): void {
    const list = this.#waiters.get(key)
    this.#waiters.delete(key)
    for (const w of list ?? []) w.reject(err)
  }

  #dropWaiter (key: string, waiter: Waiter): void {
    const list = this.#waiters.get(key)?.filter((w) => w !== waiter)
    if (list?.length) this.#waiters.set(key, list)
    else this.#waiters.delete(key)
  }

  #ready (): { swarm: Hyperswarm, tasks: TaskStore, server: Server } {
    if (!this.#swarm || !this.#tasks || !this.#server) throw new Error('Pai is not ready')
    return { swarm: this.#swarm, tasks: this.#tasks, server: this.#server }
  }

  // Set last in ready(), after connections may already have arrived.
  #mail (): Postman {
    if (!this.#postman) throw new Error('Pai is not ready')
    return this.#postman
  }
}

function hex (key: Uint8Array): string {
  return Buffer.from(key).toString('hex')
}

function noop (): void {}

// Sent on the a2a/v1 channel once this side has verified the other.
const READY_FRAME = { type: 'pai/ready' }
// Sent instead when this side doesn't accept the other, just before closing.
const REFUSED_FRAME = { type: 'pai/refused' }

// What a protocol version mismatch means, from this side.
function versionGap (theirs: number, ours: number): string {
  const which = theirs < ours ? 'an older' : 'a newer'
  return `the peer runs ${which} pai (protocol v${theirs}; this agent speaks v${ours}): run releases with the same protocol on both`
}
// Sent when this side's identity hasn't admitted the other yet (a group
// member still syncing): the connection stays open, and pai/ready follows
// if it does.
const WAITING_FRAME = { type: 'pai/waiting' }

interface Link { check (): void }

interface RouteWaiter {
  match (device: string): boolean
  resolve (peer: Peer): void
  reject (err: Error): void
}

// How many hex characters of the device key start a task id.
const TASK_PREFIX = 16

// The task id a JSON-RPC call names, if any, and the device prefix in it.
function taskDevice (method: string | undefined, params: unknown): { prefix: string | null, taskId: string | null } {
  const p = params as { id?: unknown, message?: { taskId?: unknown } } | undefined
  const taskId = method === A2A_METHODS.getTask || method === A2A_METHODS.cancelTask || method === A2A_METHODS.subscribeToTask
    ? p?.id
    : method === A2A_METHODS.sendMessage || method === A2A_METHODS.sendStreamingMessage ? p?.message?.taskId : undefined
  if (typeof taskId !== 'string') return { prefix: null, taskId: null }
  const dot = taskId.indexOf('.')
  const prefix = dot === TASK_PREFIX ? taskId.slice(0, dot) : null
  return { prefix: prefix !== null && /^[0-9a-f]+$/.test(prefix) ? prefix : null, taskId }
}

// An agent addressed by id, device or principal: Peer's calls, routed.
export class RoutedAgent {
  constructor (private readonly pai: Pai, readonly id: Uint8Array) {}

  async send (message: Message, configuration?: SendMessageConfiguration): Promise<SendMessageResponse> {
    return await (await this.pai.route(this.id, A2A_METHODS.sendMessage, { message })).send(message, configuration)
  }

  async * stream (message: Message, configuration?: SendMessageConfiguration): AsyncGenerator<StreamResponse> {
    yield * (await this.pai.route(this.id, A2A_METHODS.sendStreamingMessage, { message })).stream(message, configuration)
  }

  async getTask (id: string, historyLength?: number): Promise<Task> {
    return await this.pai.getTaskOf(this.id, id, historyLength)
  }

  async cancelTask (id: string): Promise<Task> {
    return await (await this.pai.route(this.id, A2A_METHODS.cancelTask, { id })).cancelTask(id)
  }

  async * subscribe (id: string): AsyncGenerator<StreamResponse> {
    yield * (await this.pai.route(this.id, A2A_METHODS.subscribeToTask, { id })).subscribe(id)
  }

  async listTasks (params: ListTasksRequest = {}): Promise<ListTasksResponse> {
    return await this.pai.listTasksOf(this.id, params)
  }

  async card (opts?: CardOptions): Promise<AgentCard | null> {
    return await (await this.pai.route(this.id)).card(opts)
  }
}

function localRequest (method: string, params: unknown): JsonRpcRequest {
  return request(`local-${++localIds}`, method, params, { [SERVICE_PARAMS.version]: A2A_PROTOCOL_VERSION })
}
let localIds = 0

// Messages kept from a remote while its proof is being checked.
const MAX_HELD = 256
// How long a refused connection gets to deliver that frame.
const REFUSE_GRACE = 1000

// From a mailbox: mail has just arrived for this agent.
const MAIL_FRAME = { type: 'pai/mail' } as unknown as JsonRpcMessage

// Sent once this side has accepted the other, and again on each card change.
function cardFrame (card: AgentCard): JsonRpcMessage {
  return { type: 'pai/card', card } as unknown as JsonRpcMessage
}

// The latest card one remote agent pushed, for card() and watchCard().
class CardBox {
  card: AgentCard | null = null
  #queues = new Set<EventQueue<AgentCard>>()
  #first: Array<() => void> = []

  set (card: AgentCard): void {
    this.card = card
    for (const q of this.#queues) q.push(card)
    for (const wake of this.#first.splice(0)) wake()
  }

  async first (): Promise<AgentCard> {
    if (this.card === null) await new Promise<void>((resolve) => { this.#first.push(resolve) })
    return this.card!
  }

  // The current card (once there is one), then each new one. Ends when
  // `signal` aborts or the agent closes.
  async * watch (signal?: AbortSignal): AsyncGenerator<AgentCard> {
    if (signal?.aborted) return
    const queue = new EventQueue<AgentCard>()
    const stop = () => { queue.end() }
    signal?.addEventListener('abort', stop, { once: true })
    this.#queues.add(queue)
    if (this.card !== null) queue.push(this.card)
    try {
      yield * queue
    } finally {
      this.#queues.delete(queue)
      signal?.removeEventListener('abort', stop)
    }
  }

  end (): void {
    for (const q of this.#queues) q.end()
    this.#queues.clear()
  }
}

function isFrame (msg: unknown, type: string): boolean {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === type
}

// PaiOptions.bootstrap replaces the list; otherwise an identity's extra
// nodes are added to Holepunch's defaults. Undefined means
// Hyperswarm's own default.
export async function bootstrapNodes (override: BootstrapNode[] | undefined, identity: Identity): Promise<BootstrapNode[] | undefined> {
  if (override) return override
  const extra = await identity.bootstrap?.() ?? []
  return extra.length ? [...HyperDHT.BOOTSTRAP, ...extra] : undefined
}

export function withPaiInterface (card: CardInput, id: string): AgentCard {
  const own: AgentInterface = { url: `pai://${id}`, protocolBinding: PAI_BINDING, protocolVersion: A2A_PROTOCOL_VERSION }
  const listed = card.supportedInterfaces ?? []
  const at = listed.findIndex((i) => i.protocolBinding === PAI_BINDING)
  const supportedInterfaces = at < 0 ? [own, ...listed] : listed.map((i, n) => n === at ? { ...i, ...own } : i)
  return { ...card, supportedInterfaces }
}

function assertCard (card: unknown): void {
  const errors = validateCard(card)
  if (errors.length) throw new PaiCardError(errors, card)
}

async function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PaiConnectionError(message)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
