import type { EventEmitter } from 'node:events'
import { createHmac, createPrivateKey, hkdfSync, randomBytes, sign, timingSafeEqual } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import BlindPairing from 'blind-pairing'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import { GroupBase, groupId, groupNamespace, localWriter, newSlot, storeDir } from '../group/base.js'
import { GroupMembership, PROOF_ENTRY, joinBytes, readInviteCode, verifySigned } from '../group/membership.js'
import type { GroupEntry, Invitee, MembershipHost, Proven } from '../group/membership.js'
import { isId } from '../group/state.js'
import type { Message, Task } from '../a2a/types.js'
import { DeviceBase, OWN_IDENTITY, replicaNamespace } from '../devices/base.js'
import { PaiRpcError } from '../errors.js'
import { ErrorCodes } from '../protocol/jsonrpc.js'
import { hex } from '../util/replica.js'
import type { AgentRecord, HandshakeContext, Identity, OwnPeer, SharedTasks, SwarmLike } from './types.js'

// What an identity's devices all hold: the identity (its base's key, the
// id other agents know it by) and a secret only its devices have, which
// lets them find and recognize each other before they share any group.
export interface IdentityKeys {
  identity: Uint8Array
  secret: Uint8Array
}

export interface GroupIdentityOptions {
  // The agent's storage folder; its Corestore goes in store/ (storeDir).
  storage: string
  keys: IdentityKeys
  // The groups this device is in, as it keeps them.
  groups: GroupEntry[]
  // Told the whole list whenever it changes (a group made or joined here,
  // or learned from another of the identity's devices), to keep it.
  onGroups?: (groups: GroupEntry[]) => void | Promise<void>
}

export type { GroupEntry, InviteOptions, Inbox } from '../group/membership.js'

// The most groups an identity can be in: every connection's proof carries
// one entry per group.
export const MAX_GROUPS = 32

// The proof: the identity, a MAC with the identity's own key (for its
// other devices), then one entry per group (PROOF_ENTRY bytes).
const PROOF_HEAD = 32 + 32
// Devices whose claimed identity is remembered at once.
const MAX_CLAIMS = 4096
const DEFAULT_INVITE_TTL = 24 * 60 * 60 * 1000
// How often a device that can't write to a group yet asks its identity's
// other devices again (a group one of them just joined may not list it as
// a member there yet).
const PULL_AGAIN = 5000
// The longest a Node timer can wait (about 24.8 days).
const MAX_TIMER = 2 ** 31 - 1

const IDENTITY_SALT = Buffer.from('pai/identity/v1')
const DEVICE_DOMAIN = Buffer.from('pai/identity/v1/device\n')

// The methods an identity's devices call on each other: which groups each
// is in, "mine changed, look again", and "let my writers into these".
const GROUPS = 'pai/Groups'
const GROUPS_CHANGED = 'pai/GroupsChanged'
const ADD_WRITERS = 'pai/AddWriters'

// What a new device sends one of its identity's devices: its Noise key
// and its writer in the identity's base, signed by the device over
// DEVICE_DOMAIN, the invite id and the writer.
interface NewDevice { device: string, identityWriter: string, name?: string, sig: string }

interface DeviceInvite { publicKey: Uint8Array, expires: number, additional: unknown }

// What a connected device proved: the identity's own MAC (true only for
// this identity's devices) and its entry for each group both are in.
interface Proof { own: boolean, groups: Map<string, Proven> }

// An identity in any number of groups. The identity is its own Autobase
// (src/devices/), listing the devices that act as it; each group is a
// GroupMembership. A device connects with a proof naming the identity it
// acts for and showing, for each of its groups, that it holds the group's
// seed. It may make calls once some group both are in admits it (its
// roster admits the identity, latest and signed, and the identity's base
// lists the device), or, for another device of this identity, once this
// identity's base lists it. Every connection replicates the store: the
// identity bases and the groups both sides have.
//
// An identity's own devices sign its base (src/devices/state.ts), and
// tell each other the groups they're in, so a device added once ends up
// in every group (see #pull).
export class GroupIdentity implements Identity {
  readonly #options: GroupIdentityOptions
  readonly #identity: string
  readonly #auth: Buffer
  readonly #topic: Buffer
  #store: Corestore | null = null
  #own: DeviceBase | null = null
  // The groups, by id, in the order they were added.
  readonly #groups = new Map<string, GroupMembership>()
  // Groups this device keeps but couldn't open (it was removed, or the
  // group moved to newer rules), by id, with why: kept, not run.
  readonly #unopened = new Map<string, { entry: GroupEntry, problem: string }>()
  // Other members' identity bases, opened on first need.
  #replicas = new Map<string, { base: DeviceBase, ready: boolean }>()
  // The identity each connected device said it acts for, and what it proved.
  #claims = new Map<string, string>()
  #proofs = new Map<string, Proof>()
  #device: string | null = null
  #keyPair: { publicKey: Uint8Array, secretKey: Uint8Array } | null = null
  #swarm: SwarmLike | null = null
  #pairing: BlindPairing | null = null
  // Device invites this device made, by invite id: kept in memory only (a
  // restart drops them), and answered while this device runs.
  #deviceInvites = new Map<string, DeviceInvite>()
  #deviceMember: { close (): Promise<void> } | null = null
  // This identity's other devices, connected now.
  #ownPeers = new Map<string, OwnPeer>()
  #pulling: Promise<void> = Promise.resolve()
  #pullTimer: NodeJS.Timeout | null = null
  #adding: Promise<unknown> = Promise.resolve()
  #listeners = new Set<() => void>()
  #sharedTasks: SharedTasks | null = null
  #host: MembershipHost | null = null
  #closed = false
  readonly #peers = new Map<string, AgentRecord>()

  constructor (options: GroupIdentityOptions) {
    if (options.keys.identity.byteLength !== 32) throw new Error('Identity key must be 32 bytes')
    if (options.keys.secret.byteLength !== 32) throw new Error('Identity secret must be 32 bytes')
    if (options.groups.length > MAX_GROUPS) throw new Error(`An identity can be in at most ${MAX_GROUPS} groups`)
    this.#options = options
    this.#identity = hex(options.keys.identity)
    this.#auth = deriveIdentityKey(options.keys.secret, 'auth')
    this.#topic = deriveIdentityKey(options.keys.secret, 'topic')
  }

  // The identity this device acts for, hex: its id in every roster.
  get self (): string {
    return this.#identity
  }

  // This device's Noise key, hex, once discover() has run.
  get device (): string | null {
    return this.#device
  }

  // This device's identity base, once discover() has opened it.
  get own (): DeviceBase {
    if (!this.#own) throw new Error('The identity is not open yet')
    return this.#own
  }

  // The groups this identity is in, in the order they were added.
  groups (): GroupMembership[] {
    return [...this.#groups.values()]
  }

  // A group by its name or id; without one, the first group.
  group (ref?: string): GroupMembership {
    const all = this.groups()
    if (ref === undefined) {
      if (!all[0]) throw new Error('This agent isn\'t in any group yet')
      return all[0]
    }
    const found = all.find((g) => g.name === ref) ?? all.find((g) => g.id === ref)
    if (!found) throw new Error(`This agent isn't in a group named ${ref} (its groups: ${all.map((g) => g.name).join(', ') || 'none'})`)
    return found
  }

  // Why something this agent keeps stopped (a group moved to rules newer
  // than this build applies, or a log applies differently here), or null.
  get problem (): string | null {
    if (this.#own?.stalled) return this.#own.stalled
    for (const g of this.#groups.values()) if (g.problem) return `${g.name}: ${g.problem}`
    for (const { entry, problem } of this.#unopened.values()) return `${entry.name}: ${problem}`
    return null
  }

  // Groups this device keeps but couldn't open, and why (see discover).
  unopened (): Array<{ name: string, id: string, problem: string }> {
    return [...this.#unopened.entries()].map(([id, { entry, problem }]) => ({ name: entry.name, id, problem }))
  }

  async discover (swarm: SwarmLike, self: AgentRecord): Promise<void> {
    this.#device = hex(self.id)
    this.#swarm = swarm
    this.#keyPair = swarm.keyPair ?? null
    const store = new Corestore(storeDir(this.#options.storage))
    this.#store = store
    const own = new DeviceBase(store, this.#options.keys.identity)
    try {
      await own.ready()
      if (own.hasDevice(this.#device) === false) throw new Error('This device was removed from its identity')
      this.#own = own
      // A group that can't open (this identity was removed from it, its
      // membership lapsed, it moved to rules this build doesn't apply)
      // doesn't stop the others: it's kept, and said (problem).
      for (const entry of this.#options.groups) {
        const g = new GroupMembership(this.#hostFor(), entry)
        try {
          await g.open()
          this.#groups.set(g.id, g)
        } catch (err) {
          this.#unopened.set(g.id, { entry, problem: (err as Error).message })
        }
      }
    } catch (err) {
      for (const g of this.#groups.values()) await g.close().catch(() => {})
      this.#groups.clear()
      this.#own = null
      await own.close()
      await store.close()
      this.#store = null
      throw err
    }
    own.on('change', () => { this.#changed() })
    own.on('error', () => {})
    own.on('stall', () => { this.#emit() })
    // This identity's devices find each other here, groups or not.
    swarm.join(this.#topic, { server: true, client: true })
    this.#changed()
    for (const g of this.#groups.values()) await g.settled()
    await swarm.flush()
  }

  // What each group needs from this identity.
  #hostFor (): MembershipHost {
    if (this.#host) return this.#host
    const identity = this
    this.#host = {
      get store () { return identity.#store! },
      identity: this.#identity,
      get device () { return identity.#device! },
      get keyPair () { return identity.#keyPair },
      get swarm () { return identity.#swarm! },
      get own () { return identity.#own! },
      get closed () { return identity.#closed },
      identityBase: (id) => this.#identityBase(id),
      pairing: () => this.#pairingOn(),
      changed: () => { this.#changed() }
    }
    return this.#host
  }

  #pairingOn (): BlindPairing {
    if (!this.#swarm) throw new Error('The identity is not open yet')
    this.#pairing ??= new BlindPairing(this.#swarm, { poll: 5000 })
    return this.#pairing
  }

  // ---- connections ----

  // The proof: the identity, its MAC with the identity's key (only its own
  // devices can check it), then each group's entry. It names whom the
  // device acts for, and shows the seeds it holds.
  proof (ctx: HandshakeContext): Uint8Array {
    const identity = Buffer.from(this.#identity, 'hex')
    const parts = [identity, this.#mac(ctx.handshakeHash, ctx.localPublicKey, identity)]
    for (const g of this.#groups.values()) parts.push(g.proofEntry(ctx.handshakeHash, ctx.localPublicKey, identity))
    return Buffer.concat(parts)
  }

  // Holds if the peer is another device of this identity (its MAC with the
  // identity's key checks out) or proves the seed of a group both are in.
  // An entry for one of this device's groups must hold wholly, or the
  // connection is refused. Whether the peer may sync and call is up to
  // admits().
  async authenticate (ctx: HandshakeContext, remoteProof: Uint8Array): Promise<boolean> {
    const n = (remoteProof.byteLength - PROOF_HEAD) / PROOF_ENTRY
    if (!Number.isInteger(n) || n < 0 || n > MAX_GROUPS) return false
    const proof = Buffer.from(remoteProof)
    const identity = proof.subarray(0, 32)
    const claim = hex(identity)
    const device = hex(ctx.remotePublicKey)
    const own = timingSafeEqual(proof.subarray(32, PROOF_HEAD), this.#mac(ctx.handshakeHash, ctx.remotePublicKey, identity))
    // Only this identity's devices know its key.
    if (claim === this.#identity && !own) return false
    const groups = new Map<string, Proven>()
    for (let i = 0; i < n; i++) {
      const entry = proof.subarray(PROOF_HEAD + i * PROOF_ENTRY, PROOF_HEAD + (i + 1) * PROOF_ENTRY)
      for (const g of this.#groups.values()) {
        if (groups.has(g.id)) continue
        const proven = g.check(entry, ctx.handshakeHash, ctx.remotePublicKey, identity)
        if (proven === false) return false
        if (proven === null) continue
        groups.set(g.id, proven)
        break
      }
    }
    if (!own && groups.size === 0) return false
    // Bounded: the oldest claims go first (they're re-made on reconnect).
    this.#claims.delete(device)
    this.#proofs.delete(device)
    this.#claims.set(device, claim)
    this.#proofs.set(device, { own, groups })
    if (this.#claims.size > MAX_CLAIMS) {
      const oldest = this.#claims.keys().next().value!
      this.#claims.delete(oldest)
      this.#proofs.delete(oldest)
    }
    return true
  }

  attach (conn: unknown, remoteId: Uint8Array): void {
    if (!this.#store) return
    // Opens the claimed identity's replica only if it's a member somewhere.
    const claim = this.#claims.get(hex(remoteId))
    if (claim) this.#identityBase(claim)
    this.#store.replicate(conn)
  }

  // Another device of this identity: once this identity's base lists it.
  // Any other: once some group both are in admits it.
  admits (id: Uint8Array): boolean | 'pending' {
    const device = hex(id)
    const identity = this.#claims.get(device)
    const proof = this.#proofs.get(device)
    if (!identity || !proof || !this.#own) return 'pending'
    if (identity === this.#identity) return proof.own ? this.#own.hasDevice(device) : false
    let result: boolean | 'pending' = false
    for (const [gid, proven] of proof.groups) {
      const g = this.#groups.get(gid)
      if (!g) continue
      const admits = g.admits(device, identity, proven)
      if (admits === true) return true
      if (admits === 'pending') result = 'pending'
    }
    return result
  }

  // Whether `caller` (an identity, or a device) may call this agent: by
  // the policy of any group both are in. A device stands for its identity:
  // the one it claimed on connecting, or (for mail from a device not
  // connected) the one a roster records it for. This identity's own
  // devices always may.
  mayCall (caller: string): boolean {
    const identity = this.#claims.get(caller) ?? this.#rosterIdentity(caller) ?? caller
    if (identity === this.#identity) return true
    return this.groups().some((g) => g.mayCall(identity))
  }

  #rosterIdentity (device: string): string | null {
    for (const g of this.#groups.values()) {
      const id = g.identityOfDevice(device)
      if (id !== null) return id
    }
    return null
  }

  // The identity this connected device acts for, if it said.
  identityOf (device: Uint8Array): string | null {
    return this.#claims.get(hex(device)) ?? null
  }

  // A device acts for its identity once admitted.
  principalOf (device: Uint8Array): string | null {
    return this.admits(device) === true ? this.identityOf(device) : null
  }

  // Calls can address an identity: this one, or a member of a group this
  // one is in; its devices answer.
  isPrincipal (id: Uint8Array): boolean {
    const key = hex(id)
    return key === this.#identity || this.groups().some((g) => g.isMember(key))
  }

  onAdmissionChange (listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  async resolve (id: Uint8Array): Promise<AgentRecord | null> {
    const key = hex(id)
    const known = this.#peers.get(key)
    const identity = this.#claims.get(key)
    const member = identity ? this.groups().map((g) => g.isMember(identity) ? g.base.roster.members.find((m) => m.id === identity) : undefined).find(Boolean) : undefined
    if (!known && !member) return null
    return { ...known, id, ...(member?.name ? { name: member.name } : {}) }
  }

  remember (record: AgentRecord): void {
    this.#peers.set(hex(record.id), record)
  }

  // ---- shared tasks ----

  // Tasks shared in groups: each task in one group (its `pai/group`
  // metadata, set when it's made: see placement), readable by that
  // group's members, and read back from every group's replica. Null before
  // discover().
  tasks (): SharedTasks | null {
    if (!this.#own) return null
    const find = async (agent: string, id: string): Promise<{ task: Task, owner: string | null } | null> => {
      for (const g of this.#groups.values()) {
        const found = await g.readTask(agent, id)
        if (found) return found
      }
      return null
    }
    const self = this
    const all = async function * (agent: string): AsyncGenerator<{ task: Task, owner: string | null }> {
      const seen = new Set<string>()
      for (const g of self.#groups.values()) {
        for await (const rec of g.listTasks(agent)) {
          if (seen.has(rec.task.id)) continue
          seen.add(rec.task.id)
          yield rec
        }
      }
    }
    // The group a task is shared in, if this identity is in it.
    const groupOf = (task: Task | null): GroupMembership | null => {
      const id = task?.metadata?.['pai/group']
      return typeof id === 'string' ? this.#groups.get(id) ?? null : null
    }
    this.#sharedTasks ??= {
      get: async (id) => await find(this.#identity, id),
      list: () => all(this.#identity),
      getOf: async (agent, id) => await find(agent, id),
      listOf: (agent) => all(agent),
      put: (task, owner) => { groupOf(task)?.queueTask(task, owner) },
      placement: (caller, message) => this.#placement(caller, message),
      canRead: (caller, task) => {
        if (caller === this.#identity) return true
        if (task === undefined) return this.groups().some((g) => g.isMember(caller))
        return groupOf(task)?.isMember(caller) ?? false
      },
      canControl: (owner, caller, task) => {
        if (caller === owner || caller === this.#identity) return true
        return groupOf(task)?.base.isAdmin(caller) ?? false
      }
    }
    return this.#sharedTasks
  }

  // The group a new task from `caller` is shared in: the one the message
  // names (`pai/group`), if both are in it; else the first group both are
  // in (by id); else none (the task stays on this device).
  #placement (caller: string | undefined, message: Message): string | null {
    const shared = (g: GroupMembership): boolean => caller === undefined || caller === this.#identity || g.isMember(caller)
    const named = message.metadata?.['pai/group']
    const g = typeof named === 'string' ? this.#groups.get(named) : undefined
    if (g && shared(g)) return g.id
    const both = this.groups().filter(shared).map((x) => x.id).sort()
    return both[0] ?? null
  }

  // ---- groups ----

  // Starts a group, with this identity as its only admin. `name`: this
  // identity's name for it (made unique); `title`: the group's own (what
  // invites carry; default `name`); `member`: this identity's name in its
  // roster.
  async createGroup (name: string, opts: { title?: string, member?: string } = {}): Promise<GroupMembership> {
    return await this.#serially(async () => {
      this.#checkRoom()
      const slot = newSlot()
      const keys = await GroupBase.create(this.#need(), slot, {
        identity: this.#options.keys.identity,
        device: Buffer.from(this.#device!, 'hex'),
        ...(opts.member ? { name: opts.member } : {}),
        title: opts.title ?? name
      })
      return await this.#add({ name: this.#uniqueName(name), slot, key: keys.key, seed: keys.seed })
    })
  }

  // Joins a group with an admin's invite code (from `pai group invite`),
  // through this device's swarm. Waits for an admin until the invite
  // lapses, `timeout` passes or `signal` aborts. `name`: this identity's
  // name for it (default: the group's own, from the code). The pairing runs
  // on a swarm of its own: this device's would refuse the admin's
  // connection, from a group it isn't in yet.
  async joinGroup (code: string, opts: { name?: string, member?: string, timeout?: number, signal?: AbortSignal } = {}): Promise<GroupMembership> {
    this.#checkRoom()
    // The wait for an admin holds nothing up: only adding the group does.
    const slot = newSlot()
    const { keys, title } = await joinWith(this.#need(), slot, {
      identity: this.#options.keys.identity,
      keyPair: this.#keyPair!,
      code,
      ...(opts.member ? { name: opts.member } : {}),
      ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      // The same DHT nodes as this device's swarm.
      ...((this.#swarm as { dht?: { bootstrapNodes?: unknown } } | null)?.dht?.bootstrapNodes ? { bootstrap: (this.#swarm as unknown as { dht: { bootstrapNodes: unknown } }).dht.bootstrapNodes } : {})
    })
    return await this.#serially(async () => {
      const id = groupId(keys.seed)
      // Another of this identity's devices may have brought it meanwhile.
      const had = this.#groups.get(id)
      if (had) return had
      if (this.#unopened.has(id)) throw new Error('This agent already keeps that group, but can\'t open it (see pai group list)')
      this.#checkRoom()
      return await this.#add({ name: this.#uniqueName(opts.name ?? title ?? 'group'), slot, key: keys.key, seed: keys.seed })
    })
  }

  // Changes this identity's name for a group (local to this device).
  async renameGroup (ref: string, name: string): Promise<GroupMembership> {
    const g = this.group(ref)
    const clean = groupName(name)
    if (this.groups().some((x) => x !== g && x.name === clean)) throw new Error(`There's already a group named ${clean}`)
    g.name = clean
    await this.#saveGroups()
    return g
  }

  #checkRoom (): void {
    if (this.#groups.size + this.#unopened.size >= MAX_GROUPS) throw new Error(`An identity can be in at most ${MAX_GROUPS} groups`)
  }


  #need (): Corestore {
    if (!this.#store || this.#closed) throw new Error('The identity is not open')
    return this.#store
  }

  // One change to the group list at a time.
  async #serially<T> (fn: () => Promise<T>): Promise<T> {
    const run = this.#adding.then(fn, fn)
    this.#adding = run.catch(() => {})
    return await run
  }

  // Opens a group this device now has, keeps it, and tells this
  // identity's other devices.
  async #add (entry: GroupEntry): Promise<GroupMembership> {
    const g = new GroupMembership(this.#hostFor(), entry)
    await g.open()
    this.#groups.set(g.id, g)
    await this.#saveGroups()
    this.#changed()
    for (const peer of this.#ownPeers.values()) void peer.request(GROUPS_CHANGED, {}).catch(() => {})
    return g
  }

  // Every group this device keeps: those it runs, and those it couldn't
  // open (kept for a later build or a renewal).
  async #saveGroups (): Promise<void> {
    await this.#options.onGroups?.([...this.groups().map((g) => g.entry), ...[...this.#unopened.values()].map((u) => u.entry)])
  }

  #uniqueName (wanted: string): string {
    const base = groupName(wanted)
    const taken = new Set([...this.groups().map((g) => g.name), ...[...this.#unopened.values()].map((u) => u.entry.name)])
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  }

  // ---- this identity's devices ----

  // Requests from this identity's other devices (see #pull).
  serves (method: string): boolean {
    return method === GROUPS || method === GROUPS_CHANGED || method === ADD_WRITERS
  }

  async serve (method: string, params: unknown, device: string): Promise<unknown> {
    if (this.#claims.get(device) !== this.#identity || this.#proofs.get(device)?.own !== true || this.#own?.hasDevice(device) !== true) {
      throw PaiRpcError.a2a(ErrorCodes.InvalidRequest, 'NOT_OWN_DEVICE', 'Only another device of this identity can ask that')
    }
    if (method === GROUPS) {
      return { groups: this.groups().map((g) => ({ name: g.name, key: b64(g.entry.key), seed: b64(g.entry.seed) })) }
    }
    if (method === GROUPS_CHANGED) {
      this.#pullFrom(device)
      return {}
    }
    const writers = (params as { writers?: unknown })?.writers
    if (typeof writers !== 'object' || writers === null) throw PaiRpcError.invalidParams('writers must be an object', 'writers')
    const added: string[] = []
    for (const [id, writer] of Object.entries(writers)) {
      const g = this.#groups.get(id)
      if (!g || !isId(writer)) continue
      await g.addDevice(device, writer)
      added.push(id)
    }
    return { added }
  }

  // Another device of this identity connected (and both accepted): learn
  // its groups.
  connected (peer: OwnPeer): void {
    const device = hex(peer.id)
    if (this.#claims.get(device) !== this.#identity || this.#proofs.get(device)?.own !== true) return
    this.#ownPeers.set(device, peer)
    this.#pullFrom(device)
  }

  // While a group can't be written to yet, asks this identity's connected
  // devices again, now and then.
  #pullAgain (): void {
    if (this.#pullTimer || this.#closed || this.#ownPeers.size === 0) return
    if (this.groups().every((g) => g.base.writable)) return
    this.#pullTimer = setTimeout(() => {
      this.#pullTimer = null
      for (const device of this.#ownPeers.keys()) this.#pullFrom(device)
      this.#pulling.then(() => { this.#pullAgain() }, () => {})
    }, PULL_AGAIN)
    this.#pullTimer.unref()
  }

  #pullFrom (device: string): void {
    this.#pulling = this.#pulling.then(async () => { await this.#pull(device) }).catch(() => {})
  }

  // Asks another device of this identity for its groups, joins those this
  // device lacks (in a new slot each, under the other device's name for
  // it), and asks that device to let this one's writers in, for those and
  // for any group this device can't write to yet.
  async #pull (device: string): Promise<void> {
    const peer = this.#ownPeers.get(device)
    if (!peer || peer.closed) {
      this.#ownPeers.delete(device)
      return
    }
    if (this.#closed) return
    const res = await peer.request(GROUPS, {}) as { groups?: Array<{ name?: unknown, key?: unknown, seed?: unknown }> }
    const writers: Record<string, string> = {}
    for (const g of (res?.groups ?? []).slice(0, MAX_GROUPS)) {
      if (typeof g?.key !== 'string' || typeof g.seed !== 'string') continue
      const key = Buffer.from(g.key, 'base64url')
      const seed = Buffer.from(g.seed, 'base64url')
      if (key.byteLength !== 32 || seed.byteLength !== 32) continue
      const id = groupId(seed)
      // One this device keeps but can't open stays as it is.
      if (this.#unopened.has(id)) continue
      let mine = this.#groups.get(id)
      if (!mine) {
        mine = await this.#serially(async () => {
          const again = this.#groups.get(id)
          if (again) return again
          if (this.#unopened.has(id)) return undefined
          this.#checkRoom()
          return await this.#add({ name: this.#uniqueName(typeof g.name === 'string' ? g.name : 'group'), slot: newSlot(), key, seed })
        }).catch(() => undefined)
        if (!mine) continue
      }
      if (!mine.base.writable) writers[id] = hex(mine.base.writerKey)
    }
    if (Object.keys(writers).length > 0) await peer.request(ADD_WRITERS, { writers })
  }

  // A one-use code that adds another device to this identity, answered by
  // this device while it runs. The new device gets the identity's key and
  // secret, then its groups from this identity's devices (see #pull).
  async inviteDevice (opts: { expiresIn?: number } = {}): Promise<{ code: string, expires: number }> {
    if (!this.own.writable) throw new Error('This device is not a writer of its identity yet (still syncing?)')
    const expires = Date.now() + (opts.expiresIn ?? DEFAULT_INVITE_TTL)
    for (const [id, inv] of this.#deviceInvites) if (inv.expires <= Date.now()) this.#deviceInvites.delete(id)
    const created = BlindPairing.createInvite(this.own.key, { expires })
    this.#deviceInvites.set(hex(created.id), { publicKey: created.publicKey, expires, additional: created.additional })
    if (!this.#deviceMember) {
      this.#deviceMember = this.#pairingOn().addMember({
        discoveryKey: this.own.base.discoveryKey,
        onadd: async (candidate) => { await this.#onNewDevice(candidate) }
      })
    }
    return { code: Buffer.from(created.invite).toString('base64url'), expires }
  }

  // Takes a device out of this identity; a remaining device then retires
  // its writer in each group.
  async removeDevice (device: string): Promise<void> {
    if (!isId(device)) throw new Error('Expected a device id (64 hex characters)')
    if (this.own.hasDevice(device) !== true) throw new Error('Not a device of this identity')
    if (device === this.#device) throw new Error('This is the device you\'re on: remove it from another one')
    if (this.own.state.devices.length === 1) throw new Error('An identity keeps at least one device')
    await this.own.append({ type: 'device.remove', device })
    this.#changed()
  }

  // This device leaves its identity (the phone's "leave"): it removes
  // itself, then waits until the removal has gone out to another device
  // (one of its own, or any agent that keeps its identity's base), so it
  // holds once this device's data is gone. Not until it's signed: that
  // device applies it and stops talking to this one at once.
  //
  // It first waits for such a device (`connect`, default 15 s), and
  // changes nothing if there's none. If the removal is made but doesn't
  // go out in `timeout`, calling it again waits for it once more (the
  // removal stays made: it goes out whenever this device connects).
  async leave (opts: { connect?: number, timeout?: number } = {}): Promise<void> {
    const own = this.own
    const device = this.#device
    if (device === null) throw new Error('The identity is not open yet')
    // Applying its own removal retires this device's writer, and Autobase
    // stops replicating it: a session of its own keeps the core (and the
    // removal in it) going out.
    interface Core extends EventEmitter { length: number, peers: Array<{ remoteContiguousLength: number }>, ready (): Promise<void>, close (): Promise<void> }
    const base = own.base as unknown as { store: { get (o: { key: Uint8Array, active: boolean }): Core }, local: { key: Uint8Array } }
    const core = base.store.get({ key: base.local.key, active: true })
    const wait = async (until: () => boolean, ms: number): Promise<boolean> => {
      const end = Date.now() + ms
      while (!until()) {
        if (Date.now() > end) return false
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return true
    }
    try {
      await core.ready()
      const made = own.hasDevice(device) === false
      if (!made) {
        if (own.state.devices.length === 1) throw new Error('An identity keeps at least one device: this is its only one')
        if (!await wait(() => core.peers.length > 0, opts.connect ?? 15_000)) {
          throw new Error('Not connected to another of your devices: leave while one of them is running (nothing changed)')
        }
      }
      // The removal is this device's last block on its core.
      const at = made ? core.length - 1 : core.length
      let sent = false
      core.on('upload', (index: number) => { if (index >= at) sent = true })
      if (!made) await own.append({ type: 'device.remove', device })
      if (!await wait(() => sent || core.peers.some((p) => p.remoteContiguousLength > at), opts.timeout ?? 60_000)) {
        throw new Error('This device removed itself, but no other device has heard yet: try again while one is running (it picks up from here)')
      }
    } finally {
      await core.close().catch(() => {})
    }
  }

  async #onNewDevice (candidate: { inviteId: Uint8Array, userData: Uint8Array, open (k: Uint8Array): void, confirm (r: { key: Uint8Array, encryptionKey: Uint8Array, additional?: unknown }): void, deny (opts?: { status?: number }): void }): Promise<void> {
    const inviteId = hex(candidate.inviteId)
    const invite = this.#deviceInvites.get(inviteId)
    if (!invite || invite.expires <= Date.now()) return
    candidate.open(invite.publicKey)
    let who: NewDevice
    try {
      who = JSON.parse(Buffer.from(candidate.userData).toString())
    } catch {
      return
    }
    if (!isId(who?.device) || !isId(who?.identityWriter) || typeof who.sig !== 'string') return
    if (!verifySigned(who.device, deviceBytes(candidate.inviteId, who.identityWriter), who.sig)) return
    // The code is spent once a real redemption reaches it, whatever follows.
    this.#deviceInvites.delete(inviteId)
    // A device already listed (or removed before) can't come in again
    // this way: its old writer is retired.
    if (this.own.hasDevice(who.device) !== 'pending') return candidate.deny()
    const name = typeof who.name === 'string' ? who.name.slice(0, 200) : undefined
    try {
      await this.own.append({ type: 'device.add', device: who.device, writer: who.identityWriter, ...(name ? { name } : {}) })
    } catch {
      return candidate.deny()
    }
    const listed = this.own.state.devices.find((d) => d.device === who.device)
    if (listed?.writer !== who.identityWriter) return candidate.deny()
    candidate.confirm({ key: this.own.key, encryptionKey: Buffer.from(this.#options.keys.secret), additional: invite.additional })
  }

  // ---- keeping up ----

  // An identity's base: this device's own, or a replica of a member's (of
  // any group this identity is in), opened on first need. Null until a
  // replica has loaded, and for identities that aren't members anywhere.
  #identityBase (identity: string): DeviceBase | null {
    if (identity === this.#identity) return this.#own
    if (!this.#store || this.#closed || !isId(identity)) return null
    if (!this.groups().some((g) => g.isMember(identity))) return null
    let entry = this.#replicas.get(identity)
    if (!entry) {
      const base = new DeviceBase(this.#store, Buffer.from(identity, 'hex'), replicaNamespace(identity))
      const fresh = { base, ready: false }
      entry = fresh
      this.#replicas.set(identity, fresh)
      base.on('change', () => { this.#changed() })
      base.on('error', () => {})
      base.ready().then(() => { fresh.ready = true; this.#changed() }, () => {})
    }
    return entry.ready ? entry.base : null
  }

  #changed (): void {
    if (this.#closed || !this.#own) return
    for (const g of this.#groups.values()) g.update()
    this.#pullAgain()
    this.#closeFormerMembers()
    // This device signs its identity's base once it can write there.
    this.#own.hello().catch(() => {})
    this.#emit()
  }

  // Replicas of identities no longer in any roster are closed.
  #closeFormerMembers (): void {
    for (const [identity, { base }] of this.#replicas) {
      if (this.groups().some((g) => g.isMember(identity))) continue
      this.#replicas.delete(identity)
      base.close().catch(() => {})
    }
  }

  // One failing listener doesn't stop the rest.
  #emit (): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {}
    }
  }

  #mac (handshakeHash: Uint8Array, device: Uint8Array, identity: Uint8Array): Buffer {
    return createHmac('sha256', this.#auth).update(handshakeHash).update(device).update(identity).digest()
  }

  async close (): Promise<void> {
    this.#closed = true
    if (this.#pullTimer) clearTimeout(this.#pullTimer)
    this.#listeners.clear()
    await this.#adding.catch(() => {})
    await this.#pulling
    for (const g of this.#groups.values()) await g.close().catch(() => {})
    await this.#deviceMember?.close().catch(() => {})
    await this.#pairing?.close().catch(() => {})
    for (const { base } of this.#replicas.values()) await base.close()
    await this.#own?.close()
    await this.#store?.close().catch(() => {})
  }
}

// ---- without a running agent (the CLI's init, create and join) ----

// A new identity in `storage`, with this device (`keyPair`) as its only
// device. Refuses a folder that already holds an agent's store.
export async function createIdentity (opts: { storage: string, keyPair: { publicKey: Uint8Array }, name?: string }): Promise<IdentityKeys> {
  await assertNoStore(opts.storage)
  const store = new Corestore(storeDir(opts.storage))
  try {
    const identity = await DeviceBase.create(store, opts.keyPair.publicKey, opts.name)
    return { identity, secret: randomBytes(32) }
  } finally {
    await store.close()
  }
}

// Starts a group in `storage`'s store (the agent not running), with the
// identity as its only admin. See GroupIdentity.createGroup.
export async function createGroup (opts: { storage: string, keys: IdentityKeys, keyPair: { publicKey: Uint8Array }, name: string, title?: string, member?: string }): Promise<GroupEntry> {
  const store = new Corestore(storeDir(opts.storage))
  try {
    const slot = newSlot()
    const keys = await GroupBase.create(store, slot, {
      identity: opts.keys.identity,
      device: opts.keyPair.publicKey,
      ...(opts.member ? { name: opts.member } : {}),
      title: opts.title ?? opts.name
    })
    return { name: groupName(opts.name), slot, key: keys.key, seed: keys.seed }
  } finally {
    await store.close()
  }
}

export interface JoinOptions {
  storage: string
  keyPair: { publicKey: Uint8Array, secretKey: Uint8Array }
  code: string
  // This identity's name in the group's roster (or the new device's name).
  name?: string
  bootstrap?: unknown
  // Give up after this long. Default: until the invite expires.
  timeout?: number
  signal?: AbortSignal
}

// Redeems a group invite (the agent not running): finds an online admin
// of the group by blind pairing, sends it the identity, the device and
// its writer, and gets back the group's key and seed. Waits for an admin
// until the invite lapses. `as`: this identity's name for the group
// (default: the group's own, from the code).
export async function joinGroup (opts: JoinOptions & { keys: IdentityKeys, as?: string }): Promise<GroupEntry> {
  const store = new Corestore(storeDir(opts.storage))
  try {
    const slot = newSlot()
    const { keys, title } = await joinWith(store, slot, { ...opts, identity: opts.keys.identity })
    return { name: groupName(opts.as ?? title ?? 'group'), slot, key: keys.key, seed: keys.seed }
  } finally {
    await store.close()
  }
}

// Adds this device to an identity: redeems a code from `pai device invite`
// with one of the identity's running devices, and gets back the identity
// and its secret. Its groups follow once it runs (see GroupIdentity).
export async function joinDevice (opts: JoinOptions): Promise<IdentityKeys> {
  const { invite, expires } = decode(opts.code)
  await assertNoStore(opts.storage)
  let joined = false
  try {
    const store = new Corestore(storeDir(opts.storage))
    let identityWriter: Uint8Array
    try {
      // Writer keys don't depend on the base: they come from the namespace.
      identityWriter = await localWriter(store, OWN_IDENTITY)
    } finally {
      await store.close()
    }
    const inviteId = BlindPairing.createRequest(invite, Buffer.alloc(0)).inviteId
    const userData: NewDevice = {
      device: hex(opts.keyPair.publicKey),
      identityWriter: hex(identityWriter),
      ...(opts.name ? { name: opts.name } : {}),
      sig: hex(sign(null, deviceBytes(inviteId, hex(identityWriter)), privateKey(opts.keyPair)))
    }
    const result = await redeem(invite, expires, userData, opts)
    if (!result.encryptionKey || result.encryptionKey.byteLength !== 32) throw new Error('The device sent no identity secret')
    joined = true
    return { identity: Buffer.from(result.key), secret: Buffer.from(result.encryptionKey) }
  } finally {
    if (!joined) await rm(storeDir(opts.storage), { recursive: true, force: true }).catch(() => {})
  }
}

// Redeems a group invite into `slot` of `store`. A failed join leaves the
// slot empty (its writer was never added), so it can be tried again.
async function joinWith (store: Corestore, slot: string, opts: Omit<JoinOptions, 'storage'> & { identity: Uint8Array }): Promise<{ keys: { key: Uint8Array, seed: Uint8Array }, title: string | null }> {
  const { title } = readInviteCode(opts.code)
  const { invite, expires } = decode(opts.code)
  const writer = await localWriter(store, groupNamespace(slot))
  const inviteId = BlindPairing.createRequest(invite, Buffer.alloc(0)).inviteId
  const userData: Invitee = {
    identity: hex(opts.identity),
    device: hex(opts.keyPair.publicKey),
    writer: hex(writer),
    ...(opts.name ? { name: opts.name } : {}),
    sig: hex(sign(null, joinBytes(inviteId, writer, opts.identity), privateKey(opts.keyPair)))
  }
  const result = await redeem(invite, expires, userData, opts).catch((err: Error) => {
    throw err.message.startsWith('Nobody answered') ? new Error(err.message.replace('Nobody', 'No group admin')) : err
  })
  if (!result.encryptionKey) throw new Error('The admin sent no group seed')
  return { keys: { key: Buffer.from(result.key), seed: Buffer.from(result.encryptionKey) }, title }
}

function decode (code: string): { invite: Uint8Array, expires: number } {
  let invite: Uint8Array
  let expires: number
  try {
    invite = readInviteCode(code).invite
    expires = BlindPairing.decodeInvite(invite).expires
  } catch {
    throw new Error('That is not a pai invite code')
  }
  if (expires && expires <= Date.now()) throw new Error(`That invite expired at ${new Date(expires).toISOString()}`)
  return { invite, expires }
}

// Blind pairing as the candidate, on a swarm of its own (a key of its own
// too: the device's may be in use by its running agent; the signed
// userData names the device). Waits for an answer until the invite lapses
// (or `opts.timeout`, or `opts.signal`).
async function redeem (invite: Uint8Array, expires: number, userData: object, opts: Pick<JoinOptions, 'bootstrap' | 'timeout' | 'signal'>): Promise<{ key: Uint8Array, encryptionKey?: Uint8Array, data?: Uint8Array | null }> {
  const swarm = new Hyperswarm(opts.bootstrap ? { bootstrap: opts.bootstrap } : {})
  const using = new BlindPairing(swarm, { poll: 5000 })
  let candidate: { close (): Promise<void> } | null = null
  let timer: NodeJS.Timeout | undefined
  let onAbort = (): void => {}
  try {
    return await new Promise((resolve, reject) => {
      const wait = opts.timeout ?? (expires ? expires - Date.now() : 24 * 60 * 60 * 1000)
      const capped = wait > MAX_TIMER
      timer = setTimeout(() => {
        reject(new Error(capped ? 'Nobody answered in 24 days; try again' : 'Nobody answered the invite before it expired'))
      }, Math.min(wait, MAX_TIMER))
      onAbort = () => reject(new Error('Join canceled'))
      if (opts.signal?.aborted) return onAbort()
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      candidate = using.addCandidate({ invite, userData: Buffer.from(JSON.stringify(userData)), onadd: (res) => { resolve(res) } })
    })
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
    await (candidate as { close (): Promise<void> } | null)?.close().catch(() => {})
    await using.close().catch(() => {})
    await swarm.destroy().catch(() => {})
  }
}

// Throws if the storage folder already holds an agent's store: its
// identity and groups would carry over.
async function assertNoStore (storage: string): Promise<void> {
  const dir = storeDir(storage)
  if (await stat(dir).then(() => true, () => false)) {
    throw new Error(`${dir} already holds an agent's identity and groups; use another folder`)
  }
}

// A group's name as an identity keeps it: no whitespace (it goes in
// commands), at most 64 characters.
export function groupName (name: string): string {
  const clean = name.trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 64)
  return clean || 'group'
}

function deriveIdentityKey (secret: Uint8Array, label: 'auth' | 'topic'): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), IDENTITY_SALT, label, 32))
}

function deviceBytes (inviteId: Uint8Array, identityWriter: string): Buffer {
  return Buffer.concat([DEVICE_DOMAIN, inviteId, Buffer.from(identityWriter, 'hex')])
}

function b64 (b: Uint8Array): string {
  return Buffer.from(b).toString('base64url')
}

// A Hyperswarm key pair's secret key is the 32-byte seed, then the public key.
function privateKey (keyPair: { publicKey: Uint8Array, secretKey: Uint8Array }) {
  return createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: b64(keyPair.secretKey.subarray(0, 32)), x: b64(keyPair.publicKey) }, format: 'jwk' })
}
