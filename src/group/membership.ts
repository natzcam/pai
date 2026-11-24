import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto'
import BlindPairing from 'blind-pairing'
import type Corestore from 'corestore'
import { GroupBase, deriveGroupKey, groupId } from './base.js'
import type { GroupKeys } from './base.js'
import { MAX_BOXES, MAX_SHARED_TASK, PROPOSAL_TTL, RULES, admitted, allows, explain, mayPost, isId, readTask, readTasks, rulesProblem, isTrimmed } from './state.js'
import type { AdminOp, GroupAppend, Proposal, QuorumOp, Role, Roster, SharedTask, TaskRecord } from './state.js'
import { openSeed, sealSeed, seedCheck } from './seed.js'
import { MAX_QUESTIONS, RESULT_CUT_NOTE, canClaim, isEnded, jobMessage, leaseFrom, limitsOf, limitsProblem, parseJobOp, questionKey, specProblem, taskResultText } from './jobs.js'
import type { JobLimits, JobOp, JobRecord, JobSpec } from './jobs.js'
import { MAX_FLOW_INPUT, flowProblem, flowTargets, scheduleProblem } from './flows.js'
import type { FlowSpec, FlowSummary, FlowView, Schedule, ScheduleRecord } from './flows.js'
import { unknownFields } from './flow-guide.js'
import type { Message, Part, Task } from '../a2a/types.js'
import { isTerminal } from '../task/task.js'
import type { DeviceBase } from '../devices/base.js'
import { hex } from '../util/replica.js'
import type { SwarmLike } from '../identity/types.js'

// One group an identity is in, as this device keeps it.
export interface GroupEntry {
  // This identity's name for the group: unique among its groups, local.
  name: string
  // Where in the agent's Corestore the group lives (see groupNamespace).
  slot: string
  key: Uint8Array
  // The group's first seed (later ones come sealed in the group's log).
  seed: Uint8Array
}

export interface InviteOptions {
  // How long the invite can be redeemed. Default 24 hours.
  expiresIn?: number
  // Membership length for whoever redeems it, in days; default no end.
  days?: number | null
  // Roles whoever redeems it gets; default ['member'].
  roles?: Role[]
}

// What's waiting on an identity in a group (GroupMembership.inbox).
export interface Inbox {
  // Questions on jobs it posted (any job's, for an admin).
  questions: JobRecord[]
  // Open jobs it may take.
  open: JobRecord[]
  // Jobs a person holds through this device (pai job take).
  held: JobRecord[]
  // Proposals it hasn't approved (an admin's).
  proposals: Proposal[]
}

// What a connected device proved for one group: the epoch it was in, its
// MAC for that epoch over the connection's handshake, and (once checked)
// whether that MAC holds for the keys it was checked with.
export interface Proven { epoch: number, mac: Buffer, handshakeHash: Buffer, checked: { keys: EpochKeys, ok: boolean } | null }

// One group's part of a handshake proof: the epoch (u32), the MAC with
// that epoch's auth key, the MAC with epoch 0's.
export const PROOF_ENTRY = 4 + 32 + 32

// What one epoch's seed gives: its keys, the box it came in, and its
// commitment (seedCheck).
interface EpochKeys { seed: Buffer, auth: Buffer, topic: Buffer, box: string | null, check: string }

function epochKeys (seed: Buffer, box: string | null, check: string): EpochKeys {
  return { seed, auth: deriveGroupKey(seed, 'auth'), topic: deriveGroupKey(seed, 'topic'), box, check }
}

// What a group needs from the identity that's in it (GroupIdentity).
export interface MembershipHost {
  readonly store: Corestore
  // The identity, hex: its id in every group's roster.
  readonly identity: string
  // This device's Noise key, hex, and its key pair (to open sealed seeds).
  readonly device: string
  readonly keyPair: { publicKey: Uint8Array, secretKey: Uint8Array } | null
  readonly swarm: SwarmLike
  readonly own: DeviceBase
  readonly closed: boolean
  // An identity's base: this device's own, or a replica of a member's.
  identityBase (identity: string): DeviceBase | null
  // The blind pairing on this device's swarm, made on first need.
  pairing (): BlindPairing
  // Something changed: re-check connections and tell listeners.
  changed (): void
}

// An admin seals the current seed to another member's device only once
// that device's box has been missing this long (plus up to as much again,
// at random): its own identity's devices, or the admin that let it in,
// usually do it first, and every extra copy stays in the log.
const ADMIN_SHARE_DELAY = 20_000
// Up to how long (ms) an admin's device waits, past a lease's end, before
// saying what time it is: another admin's word, if first, does instead.
const TICK_JITTER = 1000
const TICK_RETRY = 2000
// How often jobs held by hand are looked for again (after a restart).
const REHOLD_EVERY = 10_000
// How often lapsed memberships are looked for.
const EXPIRY_CHECK = 30_000
const DEFAULT_INVITE_TTL = 24 * 60 * 60 * 1000
// How long a task's writes are batched before they go to the group: soon
// when its state changes, less often while it only streams (every write is
// a full snapshot in the group's log, which every member keeps).
const TASK_BATCH = 250
const TASK_STREAM_BATCH = 5000
// The longest a Node timer can wait (about 24.8 days).
const MAX_TIMER = 2 ** 31 - 1

// One group, as an identity's device takes part in it: its log and roster,
// its seed epochs and discovery topics, admission by its roster, its job
// board and workflows, and the tasks the identity shares in it. The
// identity (GroupIdentity) holds one of these per group.
export class GroupMembership {
  readonly id: string
  readonly slot: string
  name: string
  // Seeds this device knows, by epoch: 0 is the group entry's; later ones
  // come sealed to this device in the base (see seed.rotate).
  readonly #keys = new Map<number, EpochKeys>()
  #epoch = 0
  // When each device was first seen without a box for the current epoch.
  #missingSince = new Map<string, number>()
  // Topics joined, by hex: 'both' (announced and looked up) or 'client'.
  #topics = new Map<string, 'both' | 'client'>()
  #topicsChanging: Promise<void> = Promise.resolve()
  readonly #host: MembershipHost
  readonly #entry: GroupEntry
  #group: GroupBase | null = null
  #member: { close (): Promise<void> } | null = null
  #timer: NodeJS.Timeout | null = null
  // As an admin's device: when to next tell the group what time it is.
  #tick: NodeJS.Timeout | null = null
  #ticking = false
  #tickAgain = false
  #tickFor = 0
  #tickMark = ''
  // Why the group stopped applying (a newer rules version), if it did.
  #problem: string | null = null
  // Jobs taken by hand (takeJob) whose claims this agent keeps renewing.
  readonly #held = new Map<string, NodeJS.Timeout>()
  #reheldAt = 0
  #maintaining: Promise<void> = Promise.resolve()
  #maintainQueued = false
  // Task writes waiting to go to the group, by task id.
  #pendingTasks = new Map<string, { task: Task, owner: string | null }>()
  #taskTimer: NodeJS.Timeout | null = null
  #taskTimerAt = 0
  // The state each task was last published in.
  #publishedStates = new Map<string, string>()
  #publishing: Promise<void> = Promise.resolve()
  #closed = false

  constructor (host: MembershipHost, entry: GroupEntry) {
    if (entry.key.byteLength !== 32) throw new Error('Group key must be 32 bytes')
    if (entry.seed.byteLength !== 32) throw new Error('Group seed must be 32 bytes')
    this.#host = host
    this.#entry = entry
    this.id = groupId(entry.seed)
    this.slot = entry.slot
    this.name = entry.name
    this.#keys.set(0, epochKeys(Buffer.from(entry.seed), null, ''))
  }

  // The keys this device keeps for the group: its entry.
  get entry (): GroupEntry {
    return { ...this.#entry, name: this.name }
  }

  // Where this device finds the group now: its seed epoch's topic.
  get topic (): Buffer {
    return this.#keys.get(this.#epoch)!.topic
  }

  // The seed epoch this device is in.
  get epoch (): number {
    return this.#epoch
  }

  // The identity this device acts for, hex: its id in the roster.
  get self (): string {
    return this.#host.identity
  }

  // The group's base, once open() has run.
  get base (): GroupBase {
    if (!this.#group) throw new Error('The group is not open yet')
    return this.#group
  }

  // Opens the group's base, and fails if this device shouldn't start in it.
  async open (): Promise<void> {
    const group = new GroupBase(this.#host.store, { key: this.#entry.key, seed: this.#entry.seed }, this.slot)
    try {
      await group.ready()
      const problem = rulesProblem(group.interrupted) ?? this.#startProblem(group.roster)
      if (problem) throw new Error(problem)
    } catch (err) {
      await group.close()
      // Stopped at a newer rules version while opening: say that.
      const stopped = rulesProblem(group.interrupted)
      throw stopped !== null ? new Error(stopped) : err
    }
    this.#group = group
    group.on('change', () => { this.#host.changed() })
    group.on('error', () => {})
    group.on('interrupt', (reason: string) => {
      this.#problem = rulesProblem(reason) ?? `The group stopped applying: ${reason}`
      this.#host.changed()
    })
    group.on('stall', () => { this.#host.changed() })
    // Memberships lapse with time, not only with ops (and a missed update
    // shouldn't leave a roster stale for long).
    this.#timer = setInterval(() => {
      this.#group?.refresh().catch(() => {}).finally(() => { this.#host.changed() })
    }, EXPIRY_CHECK)
    this.#timer.unref()
  }

  // Waits for topic changes in flight.
  async settled (): Promise<void> {
    await this.#topicsChanging
  }

  // Why this device shouldn't start, or null: fail at start rather than be
  // refused by every peer.
  #startProblem (roster: Roster): string | null {
    const me = this.self
    if (roster.removed.includes(me)) return 'This agent was removed from the group'
    const rec = roster.members.find((m) => m.id === me)
    if (rec?.until != null && rec.until <= Date.now() && !roster.admins.includes(me)) {
      return `This agent's group membership lapsed at ${new Date(rec.until).toISOString()}: ask an admin to run \`pai group renew ${me}\``
    }
    return null
  }

  // ---- admission ----

  // This group's part of the handshake proof (see PROOF_ENTRY): it shows
  // the seed, for the device and the identity it acts for.
  proofEntry (handshakeHash: Uint8Array, device: Uint8Array, identity: Uint8Array): Buffer {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(this.#epoch, 0)
    return Buffer.concat([head, this.#mac(this.#keys.get(this.#epoch)!, handshakeHash, device, identity), this.#mac(this.#keys.get(0)!, handshakeHash, device, identity)])
  }

  // Reads a peer's proof entry: null if it isn't for this group (its epoch
  // 0 MAC doesn't hold), false if it is but a MAC for an epoch this device
  // knows doesn't hold, else what it proved. Epoch 0's MAC shows the peer
  // has the group's first seed, as every member has (removed ones too).
  // Whether it may sync is up to admits(): see #standing.
  check (entry: Buffer, handshakeHash: Uint8Array, device: Uint8Array, identity: Uint8Array): Proven | null | false {
    if (!timingSafeEqual(entry.subarray(36, 68), this.#mac(this.#keys.get(0)!, handshakeHash, device, identity))) return null
    const proven: Proven = { epoch: entry.readUInt32BE(0), mac: entry.subarray(4, 36), handshakeHash: Buffer.from(handshakeHash), checked: null }
    // A MAC for an epoch this device knows must hold, whatever else.
    const keys = this.#keys.get(proven.epoch)
    if (keys && !this.#holds(proven, keys, hex(identity), hex(device))) return false
    return proven
  }

  // Whether `device`, acting for `identity` with `proven`, may make calls
  // through this group: its proof stands, its identity is admitted (latest
  // and signed), and the identity's base lists the device.
  admits (device: string, identity: string, proven: Proven): boolean | 'pending' {
    if (!this.#group) return 'pending'
    const standing = this.#standing(proven, device, identity)
    if (standing !== true) return standing
    const member = this.#group.admits(identity)
    if (member !== true) return member
    const base = this.#host.identityBase(identity)
    return base ? base.hasDevice(device) : 'pending'
  }

  // Whether a connected device's proof still stands with what this device
  // knows now. A MAC for the latest epoch (that this device has the seed
  // for) is enough. Anything else (a peer that missed a rotation, or one
  // whose epoch this device hasn't caught up with) needs the roster to
  // vouch for it: a current member's device, on record. A device that
  // knows nothing of the group yet (just joined) lets peers sync while it
  // loads the roster ('pending'), then checks them like this.
  #standing (proven: Proven, device: string, identity: string): boolean | 'pending' {
    const roster = this.#group?.roster
    if (!roster) return 'pending'
    if (roster.members.length === 0) return 'pending'
    const keys = this.#keys.get(proven.epoch)
    if (keys && proven.epoch >= Math.max(roster.seed.epoch, this.#epoch) && (proven.epoch === 0 || keys.check === roster.seed.check)) {
      return this.#holds(proven, keys, identity, device)
    }
    return this.#vouched(identity, device)
  }

  // Whether `proven`'s MAC holds for `keys` (checked once per keys).
  #holds (proven: Proven, keys: EpochKeys, identity: string, device: string): boolean {
    if (proven.checked?.keys !== keys) {
      const expected = this.#mac(keys, proven.handshakeHash, Buffer.from(device, 'hex'), Buffer.from(identity, 'hex'))
      proven.checked = { keys, ok: timingSafeEqual(proven.mac, expected) }
    }
    return proven.checked.ok
  }

  // Whether the roster vouches for `device` acting as `identity`: a current
  // member, with the device on record (in the group, or in the identity's
  // base) and not removed from it.
  #vouched (identity: string, device: string): boolean {
    const roster = this.#group?.roster
    if (!roster || !admitted(roster, identity, Date.now())) return false
    const base = this.#host.identityBase(identity)
    const listed = base?.hasDevice(device)
    if (listed === false) return false
    if (listed === true) return true
    return Object.values(roster.members.find((m) => m.id === identity)?.devices ?? {}).includes(device)
  }

  // Whether `identity` is in this group's roster (any standing).
  isMember (identity: string): boolean {
    return this.#group?.roster.members.some((m) => m.id === identity) ?? false
  }

  // The identity the roster records `device` for, if any.
  identityOfDevice (device: string): string | null {
    return this.#group?.roster.members.find((m) => Object.values(m.devices).includes(device))?.id ?? null
  }

  // By this group's policy, whether `identity` (a member) may call this
  // agent. This identity itself always may.
  mayCall (identity: string): boolean {
    if (!this.#group) return false
    if (identity === this.self) return true
    return this.isMember(identity) && allows(this.#group.roster, identity, this.self)
  }

  // ---- the roster ----

  // The latest roster, less proposals and invites that have lapsed (they
  // stay in the view, but can't take effect).
  roster (): Roster {
    const roster = this.base.roster
    const now = Date.now()
    return {
      ...roster,
      proposals: roster.proposals.filter((p) => now - p.at <= PROPOSAL_TTL),
      invites: roster.invites.filter((i) => i.expires > now)
    }
  }

  // Appends an admin op, or a k-of-n proposal or vote, as this identity.
  // Throws instead when the group's rules would skip it, saying why.
  async act (op: GroupAppend): Promise<void> {
    // A member's own ops: its devices' writers, and seeds for them.
    if (op.type === 'writer.add' || op.type === 'writer.remove' || op.type === 'hello' || op.type === 'seed.share') {
      if (!this.isMember(this.self)) throw new Error('Not a member of the group')
      await this.base.append(op)
      return
    }
    if (!this.base.isAdmin(this.self)) throw new Error('Only a group admin can do that')
    const roster = this.base.roster
    if (op.type === 'approve' || op.type === 'withdraw') {
      const proposal = roster.proposals.find((p) => p.pid === op.pid)
      if (!proposal || Date.now() - proposal.at > PROPOSAL_TTL) throw new Error('No open proposal with that id (it may have passed or lapsed)')
      if (op.type === 'withdraw' && proposal.by !== this.self) throw new Error('Only the admin who proposed it can withdraw it')
      if (op.type === 'approve' && proposal.approvals.includes(this.self)) throw new Error('You already back that proposal')
    } else {
      const problem = explain(op as AdminOp | { type: 'propose', op: QuorumOp }, roster)
      if (problem) throw new Error(problem)
    }
    await this.base.append(op)
  }

  // A one-use invite code for blind pairing. Admins answer it while online.
  // The code carries the group's own name, as the joiner's default name
  // for it.
  async invite (opts: InviteOptions = {}): Promise<{ code: string, expires: number }> {
    const expires = Date.now() + (opts.expiresIn ?? DEFAULT_INVITE_TTL)
    const created = BlindPairing.createInvite(this.base.key, { expires })
    await this.act({
      type: 'invite.add',
      invite: { id: hex(created.id), publicKey: hex(created.publicKey), expires, roles: opts.roles ?? ['member'], days: opts.days ?? null }
    })
    return { code: inviteCode(created.invite, this.base.roster.title), expires }
  }

  // Proposes a new seed (k of n admins): sealed to every device of every
  // member this replica knows of; devices it misses get theirs later from
  // their own identity or an admin. Returns the proposal id.
  async rotateSeed (): Promise<string> {
    const roster = this.base.roster
    const seed = randomBytes(32)
    const boxes: Record<string, string> = {}
    for (const device of this.#memberDevices(roster).slice(0, MAX_BOXES)) boxes[device] = sealSeed(seed, Buffer.from(device, 'hex'))
    const pid = randomBytes(32).toString('hex')
    await this.act({ type: 'propose', pid, op: { type: 'seed.rotate', epoch: roster.seed.epoch + 1, boxes, check: seedCheck(seed) } })
    return pid
  }

  // Every device of every current member (not lapsed), as far as this
  // replica knows: as the roster records them, less any its identity base
  // says it removed. (The rules seal only to devices the roster records.)
  #memberDevices (roster: Roster): string[] {
    const devices = new Set<string>()
    const now = Date.now()
    for (const m of roster.members) {
      if (!admitted(roster, m.id, now)) continue
      const base = this.#host.identityBase(m.id)
      for (const d of Object.values(m.devices)) if (base?.hasDevice(d) !== false) devices.add(d)
    }
    return [...devices]
  }

  // Follows the roster's seed epoch, once this device's box for it has
  // come and holds the seed the epoch committed to; then the topics that
  // go with it. A box is opened again when it changes (a reordering can
  // swap one rotation for another).
  #updateEpoch (): void {
    const roster = this.#group?.roster
    if (!roster) return
    const n = roster.seed.epoch
    const box = roster.seed.boxes[this.#host.device]
    const known = this.#keys.get(n)
    const keyPair = this.#host.keyPair
    if (n > 0 && box && keyPair && (known?.box !== box || known.check !== roster.seed.check)) {
      const seed = openSeed(box, keyPair)
      if (seed && seedCheck(seed) === roster.seed.check) this.#keys.set(n, epochKeys(seed, box, roster.seed.check))
    }
    const keys = this.#keys.get(n)
    if (n === 0 || (keys && keys.check === roster.seed.check)) this.#epoch = n
    this.#updateTopics()
  }

  // The current epoch's keys, if this device has them.
  #currentKeys (): EpochKeys | null {
    const roster = this.#group?.roster
    if (!roster || roster.seed.epoch === 0 || this.#epoch !== roster.seed.epoch) return null
    const keys = this.#keys.get(this.#epoch)
    return keys && keys.check === roster.seed.check ? keys : null
  }

  // Seals the current seed to `device`, if this device has it and the
  // device has no box yet.
  async shareSeed (device: string): Promise<void> {
    const keys = this.#currentKeys()
    if (!keys || this.base.roster.seed.boxes[device]) return
    await this.base.append({ type: 'seed.share', epoch: this.#epoch, device, box: sealSeed(keys.seed, Buffer.from(device, 'hex')), check: keys.check })
  }

  // Lets another device of this identity write to the group: its writer,
  // and the current seed sealed to it.
  async addDevice (device: string, writer: string): Promise<void> {
    const me = this.base.roster.members.find((m) => m.id === this.self)
    if (!me) throw new Error('Not a member of the group')
    if (!me.writers.includes(writer)) await this.act({ type: 'writer.add', writer, device })
    await this.shareSeed(device).catch(() => {})
  }

  // The current epoch's topic, announced and looked up. After a rotation,
  // the first epoch's topic too: admins announce there, and everyone looks,
  // so devices that missed rotations, and new ones (which get only the
  // first seed), can find the group and catch up. Removed members can find
  // admins there, but not sync (see #standing).
  #updateTopics (): void {
    const swarm = this.#host.swarm
    if (this.#closed) return
    const want = new Map<string, 'both' | 'client'>()
    want.set(this.topic.toString('hex'), 'both')
    if (this.#epoch !== 0) {
      const first = this.#keys.get(0)!.topic.toString('hex')
      want.set(first, this.#group?.isAdmin(this.self) ? 'both' : 'client')
    }
    const same = want.size === this.#topics.size && [...want].every(([t, mode]) => this.#topics.get(t) === mode)
    if (same) return
    const before = this.#topics
    this.#topics = want
    this.#topicsChanging = this.#topicsChanging.then(async () => {
      for (const [topic, mode] of before) {
        if (want.get(topic) !== mode) await swarm.leave(Buffer.from(topic, 'hex')).catch(() => {})
      }
      for (const [topic, mode] of want) {
        if (before.get(topic) !== mode) swarm.join(Buffer.from(topic, 'hex'), { server: mode === 'both', client: true })
      }
    }).catch(() => {})
  }

  // ---- the job board (src/group/jobs.ts) ----

  // Every job on the board, newest first. `signed`: as far as a majority
  // of admins has signed it, which no reordering can undo.
  // `state`: only the open, or the claimed, jobs (cheap: indexed).
  async listJobs (opts: { signed?: boolean, state?: 'open' | 'claimed' } = {}): Promise<JobRecord[]> {
    return await this.base.jobs(opts.signed === true, opts.state)
  }

  // What a worker reads (see GroupBase.activeJobs).
  async activeJobs (opts: { signed?: boolean, ids?: string[] } = {}): Promise<{ active: JobRecord[], named: Map<string, JobRecord | null> }> {
    return await this.base.activeJobs(opts.signed === true, opts.ids)
  }

  async getJob (id: string, opts: { signed?: boolean } = {}): Promise<JobRecord | null> {
    return await this.base.job(id, opts.signed === true)
  }

  // Posts a job for `to` ('role:<role>' or an identity; default anyone
  // allowed). `lease` (ms): how long a claim holds before anyone allowed
  // may claim it again; default for good.
  async postJob (spec: JobSpec, opts: { to?: string, lease?: number } & JobLimits = {}): Promise<JobRecord> {
    this.#checkPost([opts.to ?? null])
    const clean: JobSpec = {
      text: spec.text,
      ...(spec.data !== undefined ? { data: spec.data } : {}),
      ...(spec.attach !== undefined ? { attach: spec.attach } : {}),
      ...(spec.context !== undefined ? { context: spec.context } : {})
    }
    const problem = specProblem(clean) ?? limitsProblem(opts)
    if (problem) throw new Error(problem)
    for (const a of clean.attach ?? []) {
      const j = await this.getJob(a)
      if (j?.state !== 'done' && j?.state !== 'failed') throw new Error(`Job ${a} ${j ? `is ${j.state}` : 'isn\'t on the board'}: only an ended job's result can be attached`)
    }
    // The top bit clear: ids with it set are the group's rules' own.
    const raw = randomBytes(16)
    raw[0]! &= 0x7f
    const id = raw.toString('hex')
    const job = { id, spec: clean, to: opts.to ?? null, lease: opts.lease ?? null, ...limitsOf(opts) }
    await this.#jobOp({ type: 'job.post', job }, 'a job is text (and optional data, attach and context) up to 16 KiB as JSON, for role:<role> or an agent id, with a lease of at least 5000 whole milliseconds')
    const posted = await this.getJob(id)
    if (!posted) throw new Error('The job was not recorded')
    return posted
  }

  // The message job `job` runs as: its text and data, the whole result
  // of each job it attaches, and last a note on a retry. A result is read
  // from the task its worker shared with the group; if that task isn't
  // there whole, the board's copy (up to 16 KiB) stands in, saying so, and
  // for a workflow's step pruned from the board, the workflow's copy. An
  // attachment that can't be read says why instead: this never throws.
  // The message names this group (`pai/group`), so its task is shared here.
  async jobInput (job: JobRecord): Promise<Message> {
    const base = jobMessage(job)
    const message = { ...base, metadata: { ...(base.metadata ?? {}), 'pai/group': this.id } }
    if (!job.spec.attach?.length) return message
    const flow = job.flow ? await this.getFlow(job.flow.id).catch(() => null) : null
    const attached = await Promise.all(job.spec.attach.map(async (id): Promise<Part> => {
      let name = `job ${id}`
      let text: string
      try {
        const from = await this.getJob(id)
        const step = flow ? Object.entries(flow.jobs).find(([, j]) => j === id)?.[0] : undefined
        if (from?.flow) name = `step ${from.flow.step}`
        else if (step !== undefined) name = `step ${step}`
        if (from !== null) text = await this.#wholeResult(from)
        else if (step !== undefined && flow!.items && Object.hasOwn(flow!.items, step) && (flow!.steps.find((s) => s.name === step)?.settle ?? 'all') === 'all') {
          // A map or copies step that keeps every result: each item's
          // whole result, as its JSON array. (One that settles on one
          // result has it in the workflow's copy.)
          const items = await Promise.all(Array.from({ length: flow!.items[step]!.n }, async (_, i) => {
            const itemJob = Object.hasOwn(flow!.jobs, `${step}#${i}`) ? await this.getJob(flow!.jobs[`${step}#${i}`]!) : null
            return itemJob ? await this.#wholeResult(itemJob, false) : null
          }))
          const stored = Object.hasOwn(flow!.results, step) ? JSON.parse(flow!.results[step]!) as string[] : []
          text = JSON.stringify(items.map((t, i) => t ?? stored[i] ?? ''))
        } else text = step !== undefined && Object.hasOwn(flow!.results, step) ? flow!.results[step]! : '(no longer on the board)'
      } catch (err) {
        text = `(couldn't be read: ${(err as Error).message})`
      }
      return { text: `--- Attached: the result of ${name} ---\n${text}`, metadata: { 'pai/attached': id } }
    }))
    const retry = message.parts.filter((p) => p.metadata?.['pai/retry'] === true)
    const rest = message.parts.filter((p) => p.metadata?.['pai/retry'] !== true)
    return { ...message, parts: [...rest, ...attached, ...retry] }
  }

  // An ended job's whole result: from the task its worker shared with the
  // group, or else the board's copy (saying where the rest is, if it was
  // cut). `marked`: a failed one's starts "(it failed)".
  async #wholeResult (from: JobRecord, marked = true): Promise<string> {
    if (from.state !== 'done' && from.state !== 'failed') return `(it is ${from.state}: no result)`
    const task = from.ref && from.claim ? (await this.readTask(from.claim.by, from.ref))?.task ?? null : null
    const whole = task && !isTrimmed(task) && isTerminal(task.status.state) ? taskResultText(task) : null
    const cut = (from.result ?? '').endsWith(RESULT_CUT_NOTE)
    const text = whole || (cut ? `${from.result!.slice(0, -RESULT_CUT_NOTE.length)}\n…(cut: the whole result is only on the agent that ran it, ${from.claim?.by ?? 'unknown'})` : from.result ?? '')
    return from.state === 'failed' && marked ? `(it failed)\n${text}` : text
  }

  // Whether this identity may claim `job` now.
  claimable (job: JobRecord): boolean {
    const me = this.base.roster.members.find((m) => m.id === this.self)
    // A job runs as a message from its poster, so this group's policy on
    // calls from the poster to this agent applies...
    // ...and only while the poster is still in the group.
    // A lease runs out by the group's clock, as the group's rules judge it;
    // an admin's own claim moves that clock to its time.
    const now = Date.now()
    const clock = this.base.isAdmin(this.self) ? Math.max(now, this.base.roster.clock) : this.base.roster.clock
    return me !== undefined && admitted(this.base.roster, this.self, now) && admitted(this.base.roster, job.by, now) && canClaim(job, this.self, me.roles, clock) && this.mayCall(job.by)
  }

  // Claims a job for this device (see JobWorker). Whether it wins is up to
  // the log's order: check the signed board.
  // `at`: the claim's time (default now); a claim is known by it.
  async claimJob (id: string, opts: { hand?: boolean, at?: number } = {}): Promise<void> {
    const job = await this.getJob(id)
    if (!job || !this.claimable(job)) throw new Error('That job can\'t be claimed by this agent (now)')
    await this.#jobOp({ type: 'job.claim', id, ...(opts.hand === true ? { hand: true as const } : {}) }, undefined, opts.at)
  }

  // Says this device is still working on a job it claimed: its lease runs
  // from now.
  async renewJob (id: string): Promise<void> {
    await this.#jobOp({ type: 'job.renew', id })
  }

  // Gives a claimed job back to the board.
  async releaseJob (id: string): Promise<void> {
    this.#letGo(id)
    await this.#jobOp({ type: 'job.release', id })
  }

  // Reports how a claimed job went.
  async finishJob (id: string, outcome: { state: 'done' | 'failed', result: string | null, ref: string | null }): Promise<void> {
    await this.#jobOp({ type: 'job.done', id, ...outcome }, 'a result is up to 16 KiB of text')
    this.#letGo(id)
  }

  // Claims a job for a person to do by hand (pai job take), and says
  // whether the claim held once signed (or as it stands after `timeout`).
  // While this agent runs, it renews a leased job's claim for them; it
  // stops when they finish or release the job, or lose it.
  async takeJob (id: string, opts: { timeout?: number, signal?: AbortSignal } = {}): Promise<{ job: JobRecord, mine: boolean }> {
    // Its own time names the claim: it's known whatever order it lands in.
    const at = Date.now()
    await this.claimJob(id, { hand: true, at })
    const ours = (j: JobRecord | null): boolean => this.holdsByHand(j) && j!.claim!.at === at
    const lease = (await this.getJob(id))?.lease ?? null
    // Renewed from the start (signing can take a while), while it's ours.
    if (lease !== null) this.#hold(id, lease, at)
    // Settled once the signed board shows this claim, a claim made after
    // it, or the job ended. (Another's older claim signed first isn't the
    // answer: this one can still win after it.)
    const settled = await this.#waitFor(async () => await this.getJob(id, { signed: true }), (j) => j !== null && (isEnded(j) || (j.claim !== null && j.claim.at >= at)), { timeout: opts.timeout ?? 30_000, ...(opts.signal ? { signal: opts.signal } : {}) })
    if (settled !== null && ours(settled)) return { job: settled, mine: true }
    this.#letGo(id)
    if (settled !== null && (isEnded(settled) || (settled.claim !== null && settled.claim.at >= at))) return { job: settled, mine: false }
    // Not signed in time (or the wait was stopped): give the claim back
    // rather than leave a job held by nobody who knows it.
    if (ours(await this.getJob(id))) await this.releaseJob(id).catch(() => {})
    throw new Error('The claim wasn\'t signed in time (are the admins online?): the job was given back')
  }

  // Renews job `id`'s claim a few times per lease while `still` holds;
  // stops by itself once it doesn't (the worker's claims, and hand ones).
  renewing (id: string, lease: number, still: (job: JobRecord | null) => boolean): NodeJS.Timeout {
    const timer = setInterval(() => {
      void (async () => {
        let now: JobRecord | null
        try {
          now = await this.getJob(id)
        } catch {
          return // a read that failed: try again next time
        }
        if (!still(now)) clearInterval(timer)
        else await this.renewJob(id).catch(() => {})
      })()
    }, Math.floor(lease / 3))
    timer.unref()
    return timer
  }

  // Keeps renewing the hand claim made at `at` while this agent runs,
  // until it's finished, released or lost.
  #hold (id: string, lease: number, at: number): void {
    if (this.#held.has(id)) return
    this.#held.set(id, this.renewing(id, lease, (j) => {
      const still = this.holdsByHand(j) && j!.claim!.at === at
      if (!still) this.#held.delete(id)
      return still
    }))
  }

  #letGo (id: string): void {
    const timer = this.#held.get(id)
    if (timer) clearInterval(timer)
    this.#held.delete(id)
  }

  // Asks the job's poster a question about a job this device runs (its
  // task stopped for input). `n` is the question's number under the claim.
  async askJob (id: string, n: number, text: string): Promise<void> {
    if (n > MAX_QUESTIONS) throw new Error(`The job's run asked more than ${MAX_QUESTIONS} questions`)
    await this.#jobOp({ type: 'job.ask', id, n, text }, 'a question is up to 16 KiB of text')
  }

  // Answers the question a job's run asked: its poster's call, or an
  // admin's.
  async answerJob (id: string, text: string): Promise<JobRecord> {
    const job = await this.getJob(id)
    if (!job) throw new Error('No such job')
    const q = job.question ?? null
    if (job.state !== 'claimed' || q === null || q.answer !== null) throw new Error('That job isn\'t waiting for an answer')
    if (job.by !== this.self && !this.base.isAdmin(this.self)) throw new Error('Only the job\'s poster or an admin can answer it')
    await this.#jobOp({ type: 'job.answer', id, n: q.n, text }, 'an answer is up to 16 KiB of text')
    return (await this.getJob(id)) ?? job
  }

  // The job once `done` holds for it (or as it stands after `timeout`, or
  // when `signal` aborts).
  async waitJobWhere (id: string, done: (job: JobRecord | null) => boolean, opts: { timeout?: number, signal?: AbortSignal } = {}): Promise<JobRecord | null> {
    return await this.#waitFor(async () => await this.getJob(id), done, opts)
  }

  // What's waiting on this identity: questions on jobs it posted (all of
  // them, for an admin), open jobs it may take, jobs it holds, and (for an
  // admin) proposals it hasn't approved.
  async inbox (): Promise<Inbox> {
    const { active } = await this.activeJobs({})
    const admin = this.base.isAdmin(this.self)
    return {
      questions: active.filter((j) => questionKey(j) !== '' && (j.by === this.self || admin)),
      open: active.filter((j) => j.state === 'open' && this.claimable(j)),
      held: active.filter((j) => this.holdsByHand(j)),
      // Not ones past their time, which no approval can settle.
      proposals: admin ? this.roster().proposals.filter((p) => !p.approvals.includes(this.self)) : []
    }
  }

  // Why this group stopped (it moved to rules newer than this build
  // applies, or this build applies it differently from the admins'), or
  // null.
  get problem (): string | null {
    return this.#problem ?? this.#group?.stalled ?? null
  }

  // The rules version the group is on, and the newest this build applies.
  get rules (): { group: number, supported: number } {
    return { group: this.base.roster.rules, supported: RULES }
  }

  // Whether `job` is held by a person through this device (pai job take).
  holdsByHand (job: JobRecord | null): boolean {
    return job?.state === 'claimed' && job.claim?.by === this.self && job.claim.writer === hex(this.base.writerKey) && job.claim.hand === true
  }

  // After a restart: jobs taken by hand through this device are renewed
  // again (their renewals lived in memory).
  // As the view catches up (at most every REHOLD_EVERY): the claimed jobs
  // only, which are indexed.
  #rehold (): void {
    const group = this.#group
    if (this.#closed || !group?.writable || Date.now() - this.#reheldAt < REHOLD_EVERY) return
    this.#reheldAt = Date.now()
    void (async () => {
      for (const job of await group.jobs(false, 'claimed')) {
        if (job.lease !== null && this.holdsByHand(job)) this.#hold(job.id, job.lease, job.claim!.at)
      }
    })().catch(() => { this.#reheldAt = 0 })
  }

  // Cancels a job that's open or claimed: the poster's or an admin's call.
  async cancelJob (id: string): Promise<JobRecord> {
    const job = await this.getJob(id)
    if (!job) throw new Error('No such job')
    if (job.state !== 'open' && job.state !== 'claimed') throw new Error(`That job is already ${job.state}`)
    if (job.by !== this.self && !this.base.isAdmin(this.self)) throw new Error('Only the job\'s poster or an admin can cancel it')
    await this.#jobOp({ type: 'job.cancel', id })
    return (await this.getJob(id)) ?? job
  }

  // The job once it has ended (done, failed or canceled), or as it stands
  // when `timeout` (ms) passes or `signal` aborts. Null if there's no such
  // job (yet: it may still be syncing) by then.
  async waitJob (id: string, opts: { timeout?: number, signal?: AbortSignal } = {}): Promise<JobRecord | null> {
    return await this.waitJobWhere(id, isEnded, opts)
  }

  // ---- workflows (src/group/flows.ts) ----

  // Starts a workflow with `input`; the group's rules post its steps as
  // jobs (as this identity's) as they become ready.
  async startFlow (spec: FlowSpec, input: string): Promise<FlowView> {
    // Fields the rules don't know they'd ignore: most likely a mistake.
    const problem = unknownFields(spec)[0] ?? flowProblem(spec)
    if (problem) throw new Error(problem)
    if (Buffer.byteLength(input) > MAX_FLOW_INPUT) throw new Error(`A workflow's input is at most ${MAX_FLOW_INPUT / 1024} KiB`)
    if (!this.isMember(this.self)) throw new Error('Not a member of the group')
    this.#checkPost(flowTargets(spec))
    // The top bit clear: ids with it set are the group's rules' own.
    const raw = randomBytes(16)
    raw[0]! &= 0x7f
    const id = raw.toString('hex')
    await this.base.append({ type: 'flow.start', flow: { id, ...(spec.name !== undefined ? { name: spec.name } : {}), input, steps: spec.steps } })
    const started = await this.base.flow(id)
    if (!started) throw new Error('The workflow was not recorded')
    return started
  }

  // Has the group start a workflow every `every` ms (from `start`, a
  // time; default a period from now), as this identity's, by the group's
  // clock: an admin's device has to be running for it to run on time. A
  // name already set is replaced (another member's: an admin's call).
  async setSchedule (schedule: Schedule): Promise<ScheduleRecord> {
    const problem = scheduleProblem(schedule) ?? unknownFields(schedule.flow)[0] ?? null
    if (problem) throw new Error(problem)
    if (!this.isMember(this.self)) throw new Error('Not a member of the group')
    const existing = (await this.base.schedules()).find((s) => s.name === schedule.name)
    if (existing && existing.by !== this.self && !this.base.isAdmin(this.self)) throw new Error(`The schedule ${schedule.name} is another member's: only they or an admin can change it`)
    this.#checkPost(flowTargets(schedule.flow))
    const at = Date.now()
    await this.base.append({ type: 'schedule.set', schedule }, at)
    // Recorded at its time, or the group's clock if that's later.
    const set = (await this.base.schedules()).find((s) => s.name === schedule.name && s.by === this.self && s.at >= at)
    if (!set) throw new Error('The schedule was not recorded')
    return set
  }

  async listSchedules (): Promise<ScheduleRecord[]> {
    return await this.base.schedules()
  }

  async dropSchedule (name: string): Promise<void> {
    const existing = (await this.base.schedules()).find((s) => s.name === name)
    if (!existing) throw new Error(`No schedule named ${name}`)
    if (existing.by !== this.self && !this.base.isAdmin(this.self)) throw new Error(`The schedule ${name} is another member's: only they or an admin can drop it`)
    await this.base.append({ type: 'schedule.drop', name })
  }

  async listFlows (): Promise<FlowSummary[]> {
    return await this.base.flows()
  }

  async getFlow (id: string): Promise<FlowView | null> {
    return await this.base.flow(id)
  }

  // Cancels a running workflow and its open steps: its starter's or an
  // admin's call.
  async cancelFlow (id: string): Promise<FlowView> {
    const flow = await this.getFlow(id)
    if (!flow) throw new Error('No such workflow')
    if (flow.state !== 'running') throw new Error(`That workflow is already ${flow.state}`)
    if (flow.by !== this.self && !this.base.isAdmin(this.self)) throw new Error('Only the workflow\'s starter or an admin can cancel it')
    await this.base.append({ type: 'flow.cancel', id })
    return (await this.getFlow(id)) ?? flow
  }

  // The workflow once it has ended, or as it stands at `timeout` (ms) or
  // when `signal` aborts.
  async waitFlow (id: string, opts: { timeout?: number, signal?: AbortSignal } = {}): Promise<FlowView | null> {
    return await this.#waitFor(async () => await this.getFlow(id), (f) => f !== null && f.state !== 'running', opts)
  }

  // Re-reads `read` on every change to the group until `ended` holds, the
  // timeout passes or the signal aborts; returns the last read.
  async #waitFor<T> (read: () => Promise<T>, ended: (v: T) => boolean, opts: { timeout?: number, signal?: AbortSignal }): Promise<T> {
    const group = this.base
    let value = await read()
    if (ended(value) || opts.signal?.aborted) return value
    return await new Promise<T>((resolve) => {
      let checking = Promise.resolve()
      const finish = (): void => {
        clearTimeout(timer)
        group.off('change', onChange)
        opts.signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onChange = (): void => {
        checking = checking.then(async () => {
          value = await read().catch(() => value)
          if (ended(value)) finish()
        })
      }
      const onAbort = (): void => { void checking.then(finish) }
      const timer = setTimeout(onAbort, Math.min(opts.timeout ?? MAX_TIMER, MAX_TIMER))
      group.on('change', onChange)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      onChange()
    })
  }

  // The group's rules drop a job (or workflow) the policy doesn't let this
  // identity post: say so here instead.
  #checkPost (targets: Array<string | null>): void {
    const denied = targets.find((to) => !mayPost(this.base.roster, this.self, to))
    if (denied !== undefined) throw new Error(`The group's policy doesn't let you post jobs for ${denied ?? 'anyone'}`)
  }

  // Appends a job op as this identity's member; `shape` says what a
  // malformed one got wrong.
  async #jobOp (op: JobOp, shape = 'malformed job operation', at?: number): Promise<void> {
    if (parseJobOp(op as unknown as Record<string, any>) === null) throw new Error(shape)
    if (!this.isMember(this.self)) throw new Error('Not a member of the group')
    await this.base.append(op, at)
  }

  // ---- shared tasks ----

  // A task `agent` shared in this group.
  async readTask (agent: string, id: string): Promise<{ task: Task, owner: string | null } | null> {
    if (!this.#group) return null
    const rec = await readTask(this.#group.base.view, agent, id)
    return rec ? { task: rec.task as unknown as Task, owner: rec.owner } : null
  }

  // Every task `agent` shared in this group.
  async * listTasks (agent: string): AsyncGenerator<{ task: Task, owner: string | null }> {
    if (!this.#group) return
    for await (const rec of readTasks(this.#group.base.view, agent) as AsyncGenerator<TaskRecord>) {
      yield { task: rec.task as unknown as Task, owner: rec.owner }
    }
  }

  // Batches a task's writes; a final state goes out at once, a new state
  // soon, and more of the same (streaming) at most every few seconds.
  queueTask (task: Task, owner: string | null): void {
    this.#pendingTasks.set(task.id, { task, owner })
    if (isTerminal(task.status.state)) return this.#flushTasks()
    const wait = this.#publishedStates.get(task.id) === task.status.state ? TASK_STREAM_BATCH : TASK_BATCH
    const at = Date.now() + wait
    if (this.#taskTimer && this.#taskTimerAt <= at) return
    if (this.#taskTimer) clearTimeout(this.#taskTimer)
    this.#taskTimerAt = at
    this.#taskTimer = setTimeout(() => { this.#taskTimer = null; this.#flushTasks() }, wait)
    this.#taskTimer.unref()
  }

  // Publishes what's waiting, once this device can write to the group
  // (until then it waits: update() flushes again).
  #flushTasks (): void {
    this.#publishing = this.#publishing.then(async () => {
      const group = this.#group
      if (!group?.writable || this.#closed) return
      const batch = [...this.#pendingTasks.values()]
      this.#pendingTasks.clear()
      for (const { task, owner } of batch) {
        this.#publishedStates.set(task.id, task.status.state)
        if (isTerminal(task.status.state)) this.#publishedStates.delete(task.id)
        await group.append({ type: 'task.put', task: fitTask(task), owner }).catch(() => {
          // Kept for the next flush, unless a newer write took its place.
          if (!this.#pendingTasks.has(task.id)) this.#pendingTasks.set(task.id, { task, owner })
        })
      }
    }).catch(() => {})
  }

  // ---- keeping up ----

  // Runs after anything changed (this group, the identity, a member's
  // identity base): follows the seed epoch and topics, keeps writers and
  // seeds in step, moves the clock, picks up held jobs, flushes tasks.
  update (): void {
    if (this.#closed) return
    // Pairing that fails to start (say, while shutting down) is retried on
    // the next change; it never takes the agent down.
    this.#updatePairing().catch(() => {})
    this.#updateEpoch()
    this.#maintain()
    this.#keepTime()
    this.#rehold()
    if (this.#pendingTasks.size) this.#flushTasks()
  }

  // As an admin's device: leases run out, and memberships lapse, by the
  // group's clock, which only admins' ops move (see state.ts). So when one
  // is due by this device's clock and nothing an admin wrote has said so
  // yet, it says what time it is (after a moment, so several admin devices
  // seldom all do), and the job can be claimed again.
  #keepTime (force = false): void {
    const group = this.#group
    if (this.#closed || !group?.writable || !group.isAdmin(this.self)) return
    // A change during a pass gets a pass of its own after it.
    if (this.#ticking) {
      this.#tickAgain = true
      return
    }
    // Most changes aren't to the group (a member's tasks, say): its view
    // unmoved, there's nothing new to look at.
    const mark = group.mark
    if (!force && mark === this.#tickMark) return
    this.#tickMark = mark
    this.#ticking = true
    void (async () => {
      try {
        const roster = group.roster
        const due = (end: number): boolean => end >= roster.clock
        let next = Infinity
        const at = (t: number | null | undefined): void => { if (t != null && due(t)) next = Math.min(next, t) }
        // Leases running out, from the claimed jobs.
        for (const job of await group.jobs(false, 'claimed')) {
          if (job.claim !== null && job.lease !== null) at(leaseFrom(job.claim) + job.lease)
        }
        // Limits (timeouts, deadlines, retries' waits) from their index: one
        // already past, not swept yet (a sweep takes a batch at a time),
        // gets the clock moved on now.
        const limit = await group.nextDue()
        if (limit !== null) next = Math.min(next, Math.max(limit, roster.clock))
        for (const m of roster.members) {
          if (m.until !== null && due(m.until) && !roster.admins.includes(m.id)) next = Math.min(next, m.until)
        }
        // Already waiting for that one: busy boards don't keep putting it off.
        if (this.#tick && this.#tickFor === next) return
        if (this.#tick) clearTimeout(this.#tick)
        this.#tick = null
        if (next === Infinity || this.#closed) return
        this.#tickFor = next
        const wait = Math.max(0, next + 1 - Date.now()) + Math.floor(Math.random() * TICK_JITTER)
        this.#tick = setTimeout(() => {
          this.#tick = null
          // Another admin may have said so meanwhile.
          if (this.#closed || group.roster.clock > next || Date.now() <= next) {
            this.#keepTime(true)
            return
          }
          // Its change runs this again; a failed append (not writable for a
          // moment, say) tries again shortly.
          group.append({ type: 'clock.tick' }).catch(() => {
            if (this.#closed) return
            this.#tickFor = 0
            setTimeout(() => { this.#keepTime(true) }, TICK_RETRY).unref()
          })
        }, Math.min(wait, MAX_TIMER))
        this.#tick.unref()
      } catch {} finally {
        this.#ticking = false
        if (this.#tickAgain) {
          this.#tickAgain = false
          this.#keepTime()
        }
      }
    })()
  }

  // Keeps writers and seeds in step with the group and the identity, one
  // pass at a time; changes while a pass is queued share it.
  #maintain (): void {
    if (this.#maintainQueued) return
    this.#maintainQueued = true
    this.#maintaining = this.#maintaining.then(async () => {
      this.#maintainQueued = false
      if (this.#closed || !this.#group) return
      const group = this.#group
      const own = this.#host.own
      const roster = group.roster
      const me = roster.members.find((m) => m.id === this.self)
      const myWriter = hex(group.writerKey)
      if (me && group.writable) {
        // Devices that left this identity stop writing for it in the group.
        for (const w of me.writers) {
          const device = me.devices[w]
          if (w !== myWriter && device && own.hasDevice(device) === false) await this.act({ type: 'writer.remove', writer: w }).catch(() => {})
        }
        // An admin's device signs the group once it has written.
        if (group.isAdmin(this.self) && !me.written.includes(myWriter)) await this.act({ type: 'hello' }).catch(() => {})
      }
      // Devices without the current seed get it sealed to them: a member's
      // own devices by its other devices at once, any member's by an admin
      // once it has gone without for a while.
      if (me && group.writable && this.#currentKeys()) {
        const mine = new Set(Object.values(me.devices))
        const now = Date.now()
        const all = group.isAdmin(this.self) ? this.#memberDevices(roster) : [...mine]
        for (const device of this.#missingSince.keys()) if (!all.includes(device) || roster.seed.boxes[device]) this.#missingSince.delete(device)
        for (const device of all) {
          if (this.#closed || roster.seed.boxes[device]) continue
          if (!mine.has(device)) {
            const since = this.#missingSince.get(device) ?? now + Math.random() * ADMIN_SHARE_DELAY
            this.#missingSince.set(device, since)
            if (now - since < ADMIN_SHARE_DELAY) continue
          }
          await this.shareSeed(device).catch(() => {})
        }
      }
    }).catch(() => {})
  }

  // Admins listen for invitees; anyone else doesn't.
  async #updatePairing (): Promise<void> {
    const group = this.#group
    const isAdmin = group !== null && group.isAdmin(this.self)
    if (isAdmin && this.#member === null && !this.#host.closed) {
      this.#member = this.#host.pairing().addMember({
        discoveryKey: group.base.discoveryKey,
        onadd: async (candidate) => { await this.#onInvitee(candidate) }
      })
    } else if (!isAdmin && this.#member !== null) {
      const member = this.#member
      this.#member = null
      await member.close().catch(() => {})
    }
  }

  async #onInvitee (candidate: { inviteId: Uint8Array, userData: Uint8Array, open (k: Uint8Array): void, confirm (r: { key: Uint8Array, encryptionKey: Uint8Array }): void }): Promise<void> {
    const group = this.base
    const inviteId = hex(candidate.inviteId)
    const invite = group.roster.invites.find((i) => i.id === inviteId)
    if (!invite || invite.expires <= Date.now()) return
    candidate.open(Buffer.from(invite.publicKey, 'hex'))
    let who: Invitee
    try {
      who = JSON.parse(Buffer.from(candidate.userData).toString())
    } catch {
      return
    }
    if (!isId(who?.identity) || !isId(who?.device) || !isId(who?.writer) || typeof who.sig !== 'string') return
    if (!verifyJoin(who, candidate.inviteId)) return
    const name = typeof who.name === 'string' ? who.name.slice(0, 200) : undefined
    if (group.roster.members.some((m) => m.id === who.identity)) {
      // Already a member: the invite is spent, and nobody new gets in. More
      // devices join through the identity's own devices.
      await this.act({ type: 'invite.remove', id: inviteId }).catch(() => {})
      return
    }
    // member.add uses up the invite.
    await this.act({
      type: 'member.add',
      id: who.identity,
      writer: who.writer,
      device: who.device,
      ...(name ? { name } : {}),
      roles: invite.roles,
      until: invite.days ? Date.now() + invite.days * 24 * 60 * 60 * 1000 : null,
      invite: inviteId
    }).catch(() => {})
    const added = group.roster.members.find((m) => m.id === who.identity)
    if (!added?.writers.includes(who.writer)) return
    // After a rotation: the current seed, for when it has synced.
    await this.shareSeed(who.device).catch(() => {})
    candidate.confirm({ key: group.key, encryptionKey: Buffer.from(group.seed) })
  }

  #mac (keys: EpochKeys, handshakeHash: Uint8Array, device: Uint8Array, identity: Uint8Array): Buffer {
    return createHmac('sha256', keys.auth).update(handshakeHash).update(device).update(identity).digest()
  }

  async close (): Promise<void> {
    // What's waiting goes out first.
    if (this.#taskTimer) clearTimeout(this.#taskTimer)
    if (this.#pendingTasks.size) this.#flushTasks()
    await this.#publishing
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#tick) clearTimeout(this.#tick)
    for (const timer of this.#held.values()) clearInterval(timer)
    this.#held.clear()
    await this.#maintaining
    await this.#member?.close().catch(() => {})
    for (const topic of this.#topics.keys()) await this.#host.swarm.leave(Buffer.from(topic, 'hex')).catch(() => {})
    await this.#group?.close()
  }
}

// What a joining device sends an admin through blind pairing: its
// identity, its Noise key, its group writer and a name. `sig`, by the
// device's key, covers JOIN_DOMAIN, the invite id, the writer and the
// identity, so nobody can redeem it for another device or identity.
export interface Invitee { identity: string, device: string, writer: string, name?: string, sig: string }

export const JOIN_DOMAIN = Buffer.from('pai/group/v1/join\n')

export function joinBytes (inviteId: Uint8Array, writer: Uint8Array, identity: Uint8Array): Buffer {
  return Buffer.concat([JOIN_DOMAIN, inviteId, writer, identity])
}

function verifyJoin (who: Invitee, inviteId: Uint8Array): boolean {
  return verifySigned(who.device, joinBytes(inviteId, Buffer.from(who.writer, 'hex'), Buffer.from(who.identity, 'hex')), who.sig)
}

// Whether `sig` (hex) is `device`'s Ed25519 signature over `bytes`.
export function verifySigned (device: string, bytes: Buffer, sig: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(device, 'hex').toString('base64url') }, format: 'jwk' })
    return verify(null, bytes, key, Buffer.from(sig, 'hex'))
  } catch {
    return false
  }
}

// A group invite code: the blind-pairing invite, then (after a dot) the
// group's own name, both base64url.
export function inviteCode (invite: Uint8Array, title: string | null): string {
  const code = Buffer.from(invite).toString('base64url')
  return title ? `${code}.${Buffer.from(title).toString('base64url')}` : code
}

export function readInviteCode (code: string): { invite: Buffer, title: string | null } {
  const [invite = '', title] = code.trim().split('.')
  return { invite: Buffer.from(invite, 'base64url'), title: title ? Buffer.from(title, 'base64url').toString('utf-8').slice(0, 200) || null : null }
}

// A task as the group can store it: without its artifacts if it's too big
// (they stay on the device that has them), and its history trimmed if
// that's not enough.
function fitTask (task: Task): SharedTask {
  const size = (t: unknown): number => JSON.stringify(t).length
  if (size(task) <= MAX_SHARED_TASK) return task as unknown as SharedTask
  const { artifacts: _artifacts, ...rest } = task
  const lean = { ...rest, metadata: { ...(task.metadata ?? {}), 'pai/artifacts-omitted': true } }
  if (size(lean) <= MAX_SHARED_TASK) return lean as unknown as SharedTask
  const trimmed = { ...lean, history: (task.history ?? []).slice(-1) }
  if (size(trimmed) <= MAX_SHARED_TASK) return trimmed as unknown as SharedTask
  // Still too big (a huge status message, say): just where it stands.
  return {
    id: task.id,
    contextId: task.contextId,
    status: { state: task.status.state, ...(task.status.timestamp ? { timestamp: task.status.timestamp } : {}) },
    metadata: { 'pai/trimmed': true, ...(task.metadata?.['pai/group'] !== undefined ? { 'pai/group': task.metadata['pai/group'] } : {}) }
  } as unknown as SharedTask
}

export type { GroupKeys }
