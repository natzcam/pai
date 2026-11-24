// The group's shared state: the ops writers append to the Autobase, and the
// deterministic `apply` that folds them into the view (a Hyperbee).
//
// Everything here must be a pure function of the ops and the view: Autobase
// may undo and re-apply a stretch of ops when it reorders them, so `apply`
// never reads clocks, files or anything outside its arguments. Times come
// from the ops themselves (`at`, set by their author).

import { applyJobOp, madeAt, parseJobOp, sweepJobs } from './jobs.js'
import type { JobOp } from './jobs.js'
import { applyFlowOp, flowJobEnded, flowTargets, parseFlowOp, runSchedule } from './flows.js'
import type { FlowOp } from './flows.js'

// Members are identities (src/devices/): an id here is an identity's key,
// and each of its devices writes to the group with its own writer.

// A role a member holds: a short lowercase name ('member', 'mailbox',
// 'reviewer', ...), used by policy and by the job board. Admins are a
// separate record (`admin/<id>`); `admin` is not a role anyone is given,
// but policy can name it.
export type Role = string

// A call policy rule: whether agents matching `from` may call agents
// matching `to`. A selector is '*', 'role:<role>' or an identity (hex).
export interface PolicyRule {
  name: string
  from: string
  to: string
  allow: boolean
}

// Ops any admin may append on its own.
export type AdminOp =
  | { type: 'invite.add', invite: InviteRecord }
  | { type: 'invite.remove', id: string }
  | { type: 'member.add', id: string, writer: string, device?: string, name?: string, roles?: Role[], until?: number | null, invite?: string }
  | { type: 'member.renew', id: string, until: number | null }
  | { type: 'member.remove', id: string }
  | { type: 'member.roles', id: string, roles: Role[] }
  | { type: 'policy.set', rule: PolicyRule }
  | { type: 'policy.remove', name: string }

// Ops any member may append for itself.
export type MemberOp =
  // Another device of the author's identity joins the group as a writer.
  | { type: 'writer.add', writer: string, device: string }
  // A device that left the author's identity stops writing for it.
  | { type: 'writer.remove', writer: string }
  // Does nothing but show the writer has written: an admin's writer signs
  // only once it has (Autobase stalls on signers that never write).
  | { type: 'hello' }
  // An admin's device saying what time it is (see `clock`).
  | { type: 'clock.tick' }
  // The latest state of a task the author (as an agent) is serving, for
  // the whole group to read. `owner` is the identity that created it.
  | { type: 'task.put', task: SharedTask, owner: string | null }
  // The current epoch's seed, sealed to `device` (see seed.rotate): by an
  // admin for any member's device, by a member for its own. `check` is the
  // seed's commitment (seedCheck), which must be the epoch's.
  | { type: 'seed.share', epoch: number, device: string, box: string, check: string }

// Ops that need k of n admins: proposed by one, approved by others.
export type QuorumOp =
  | { type: 'admin.add', id: string }
  // Moves the group to a newer version of these rules (see RULES).
  | { type: 'rules.set', version: number }
  | { type: 'admin.remove', id: string }
  | { type: 'quorum.set', k: number | 'majority' }
  // A new seed for discovery and handshakes, sealed to each device of each
  // member (device key -> sealed box, hex). `epoch` is the one it starts;
  // `check` commits to the seed (seedCheck), so a device can tell its box
  // holds this epoch's seed, and nobody can share another one.
  | { type: 'seed.rotate', epoch: number, boxes: Record<string, string>, check: string }

// What an agent appends: an admin op, or a k-of-n proposal or vote.
export type GroupAppend = AdminOp | MemberOp | JobOp | FlowOp | { type: 'propose', pid: string, op: QuorumOp } | { type: 'approve' | 'withdraw', pid: string }

export type Op = (
  // `rules`: the version the group starts on (see RULES); 1 if unset.
  // `name`: the admin's; `title`: the group's own.
  | { type: 'init', id: string, name?: string, title?: string, device?: string, rules?: number }
  | AdminOp
  | MemberOp
  | JobOp
  | FlowOp
  | { type: 'propose', pid: string, op: QuorumOp }
  | { type: 'approve', pid: string }
  | { type: 'withdraw', pid: string }
) & { at: number }

// A task as the group stores it: the A2A Task, as the serving agent last
// published it.
export interface SharedTask {
  id: string
  contextId: string
  status: { state: string, timestamp?: string }
  [key: string]: unknown
}

// The largest task (as JSON) the group stores; bigger ones are stored
// without their artifacts.
export const MAX_SHARED_TASK = 256 * 1024

export interface TaskRecord {
  // The identity serving it (whose devices run it).
  agent: string
  owner: string | null
  task: SharedTask
  at: number
}

export interface InviteRecord {
  // blind-pairing's invite id and public key, hex.
  id: string
  publicKey: string
  // The invite lapses at this time (ms); members it admits get `days`.
  expires: number
  roles: Role[]
  days: number | null
  by?: string
}

export interface MemberRecord {
  // The member's identity key, hex.
  id: string
  // Its devices' writers in the group's Autobase, hex.
  writers: string[]
  // The device (Noise key) each writer belongs to, where known.
  devices: Record<string, string>
  // Writers that have written something; an admin's sign only then.
  written: string[]
  name: string | null
  roles: Role[]
  // Membership ends at this time (ms), or never.
  until: number | null
  addedBy: string | null
  at: number
}

export interface Proposal {
  pid: string
  op: QuorumOp
  by: string
  at: number
  // Admins who proposed or approved it, in order.
  approvals: string[]
}

// The most writers (devices) one member can have in the group.
export const MAX_WRITERS = 16

// How long a proposal stays open.
export const PROPOSAL_TTL = 7 * 24 * 60 * 60 * 1000

// The most roles one member holds, and policy rules a group keeps.
export const MAX_ROLES = 8
export const MAX_RULES = 256
// The most devices one rotation seals to.
export const MAX_BOXES = 1024
// A sealed seed: X25519 ephemeral key, 32-byte seed, 16-byte tag (hex).
const BOX = /^[0-9a-f]{160}$/

const HEX32 = /^[0-9a-f]{64}$/
const ROLE = /^[a-z][a-z0-9_-]{0,31}$/
const RULE_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/

// The view, as `apply` sees it: a Hyperbee with string keys and JSON values.
export interface View {
  get (key: string): Promise<{ value: any } | null>
  put (key: string, value: unknown): Promise<void>
  del (key: string): Promise<void>
  createReadStream (range: { gt: string, lt: string }): AsyncIterable<{ key: string, value: any }>
}

export interface Host {
  addWriter (key: Uint8Array, opts: { indexer: boolean }): Promise<void>
  removeWriter (key: Uint8Array): Promise<void>
  removeable (key: Uint8Array): boolean
  // Stops applying here (Autobase's escape hatch): this build can't apply
  // what comes next, and a newer one will, from this same op.
  interrupt? (reason: string): void
}

// The newest version of these rules this build applies. A change to what
// an op does from then on is gated on the group's version (`rules` in the
// view, 1 when unset), which only a rules.set quorum op moves, at one
// point in the log every replica agrees on. A build that meets a version
// newer than this one stops applying there (see settle) instead of
// reading the rest differently; once upgraded, it goes on from that op.
export const RULES = 1

// The version this process applies: RULES, unless a test plays a newer
// build (testing only).
let supported = RULES
export function supportedRules (): number { return supported }
export function setSupportedRulesForTesting (v: number): void { supported = v }

// The group's rules version (see RULES).
export async function rulesOf (view: View): Promise<number> {
  return (await view.get('rules'))?.value ?? 1
}

// Why a group's base stopped applying: interrupt reasons are
// `rules:<version>`.
export function rulesProblem (reason: unknown): string | null {
  const m = /^rules:(\d+)$/.exec(String(reason ?? ''))
  if (!m) return null
  return `This group moved to rules v${m[1]}, and this pai applies up to v${RULES}: upgrade pai to go on (nothing is lost; it picks up where it stopped)`
}

export interface ApplyNode {
  value: unknown
  from: { key: Uint8Array }
}

// Folds `nodes` into `view`. `bootstrap` is the base's key: only its writer
// may start the group (`init`). Ops that fail a check are skipped, never
// thrown, so one bad op can't stall the base for everyone.
export async function apply (nodes: ApplyNode[], view: View, host: Host, bootstrap: Uint8Array): Promise<void> {
  for (const node of nodes) {
    const op = parseOp(node.value)
    if (op === null) continue
    const writer = hex(node.from.key)
    await applyOp(op, writer, view, host, bootstrap)
  }
}

async function applyOp (op: Op, writer: string, view: View, host: Host, bootstrap: Uint8Array): Promise<void> {
  if (op.type === 'init') {
    if (writer !== hex(bootstrap) || await view.get('meta') !== null) return
    // A group made by a newer build: a newer build reads it.
    if ((op.rules ?? 1) > supported) {
      if (!host.interrupt) throw new Error(`rules v${op.rules!} is newer than this build's v${supported}`)
      host.interrupt(`rules:${op.rules!}`)
      return
    }
    if (op.rules !== undefined) await view.put('rules', op.rules)
    await view.put('meta', { by: op.id, at: op.at, title: op.title ?? null })
    await view.put(`writer/${writer}`, op.id)
    await view.put(`member/${op.id}`, { id: op.id, writers: [writer], devices: op.device ? { [writer]: op.device } : {}, written: [writer], name: op.name ?? null, roles: ['member'], until: null, addedBy: null, at: op.at } satisfies MemberRecord)
    await view.put(`admin/${op.id}`, { at: op.at })
    await view.put('clock', op.at)
    return
  }

  const author = await authorOf(view, writer)
  if (author === null) return
  await markWritten(view, host, author, writer)
  const admin = await isAdmin(view, author)
  const { clock, moved } = await advanceClock(view, admin, op.at)
  const at = madeAt(op.at, clock)
  const mayPostFor = async (by: string, to: string | null): Promise<boolean> => await postAllowed(view, by, [to])
  // What the clock moving on makes due: deadlines, timeouts and schedules.
  if (moved) await sweepJobs(view, clock, async (job) => { await flowJobEnded(view, job, clock, mayPostFor) }, async (name, due) => { await runSchedule(view, name, due, clock, mayPostFor) })

  if (op.type === 'hello' || op.type === 'clock.tick') return

  if (op.type.startsWith('job.')) {
    if (op.type === 'job.post' && !(await postAllowed(view, author, [op.job.to]))) return
    const rec = await view.get(`member/${author}`)
    await applyJobOp(op as JobOp & { at: number }, author, writer, view, rec?.value ?? null, admin, async (job) => { await flowJobEnded(view, job, at, mayPostFor) }, clock)
    return
  }

  if (op.type.startsWith('flow.') || op.type.startsWith('schedule.')) {
    // Members start and schedule workflows (their steps are posted as
    // theirs).
    const rec = await view.get(`member/${author}`)
    const m = rec?.value as MemberRecord | undefined
    if (!m || (m.until !== null && m.until <= at && !admin)) return
    if (op.type === 'flow.start' && !(await postAllowed(view, author, flowTargets({ steps: op.flow.steps })))) return
    if (op.type === 'schedule.set' && !(await postAllowed(view, author, flowTargets(op.schedule.flow)))) return
    await applyFlowOp({ ...op, at } as FlowOp & { at: number }, author, view, admin, mayPostFor)
    return
  }

  if (op.type === 'task.put') {
    // Each identity writes only its own tasks (keyed by it, so nobody can
    // take another's task id), and a newer snapshot wins over an older one
    // whatever order two devices' writes land in.
    if (await view.get(`member/${author}`) === null) return
    const key = `task/${author}/${op.task.id}`
    const rec = await view.get(key)
    if (rec !== null && stamp(rec.value.task) > stamp(op.task)) return
    await view.put(key, { agent: author, owner: op.owner, task: op.task, at: op.at } satisfies TaskRecord)
    return
  }

  if (op.type === 'seed.share') {
    // For the current epoch's seed only, to a current member's device (a
    // member: its own), and never over a box already there.
    const epoch = await epochOf(view)
    if (op.epoch !== epoch.n || epoch.n === 0 || op.check !== epoch.check) return
    if (await view.get(`seed/${epoch.n}/${op.device}`) !== null) return
    const owner = await deviceOwner(view, op.device, at)
    if (owner === null || (owner !== author && !await isAdmin(view, author))) return
    await view.put(`seed/${epoch.n}/${op.device}`, op.box)
    await view.put('epoch', { ...epoch, boxes: epoch.boxes + 1 })
    return
  }

  if (op.type === 'writer.add') {
    // A member vouches for its own devices: it already controls its
    // identity. The new writer signs (if the member is an admin) only once
    // it has written.
    const rec = await view.get(`member/${author}`)
    if (rec === null) return
    const m = rec.value as MemberRecord
    if (m.until !== null && m.until <= at) return
    if (m.writers.includes(op.writer) || m.writers.length >= MAX_WRITERS) return
    if (await view.get(`writer/${op.writer}`) !== null) return // a writer serves once
    await view.put(`writer/${op.writer}`, author)
    await view.put(`member/${author}`, { ...m, writers: [...m.writers, op.writer], devices: { ...m.devices, [op.writer]: op.device } })
    await host.addWriter(Buffer.from(op.writer, 'hex'), { indexer: false })
    return
  }

  if (op.type === 'writer.remove') {
    const rec = await view.get(`member/${author}`)
    if (rec === null) return
    const m = rec.value as MemberRecord
    // A member keeps at least one writer: leaving is an admin's call.
    if (!m.writers.includes(op.writer) || m.writers.length === 1) return
    const key = Buffer.from(op.writer, 'hex')
    if (host.removeable(key)) await host.removeWriter(key)
    const devices = { ...m.devices }
    delete devices[op.writer]
    await view.put(`member/${author}`, { ...m, writers: m.writers.filter((w) => w !== op.writer), written: m.written.filter((w) => w !== op.writer), devices })
    return
  }

  if (!await isAdmin(view, author)) return

  switch (op.type) {
    case 'invite.add':
      if (await view.get(`invite/${op.invite.id}`) !== null) return
      await view.put(`invite/${op.invite.id}`, { ...op.invite, by: author })
      return
    case 'invite.remove':
      await view.del(`invite/${op.id}`)
      return
    case 'member.add': {
      if (await view.get(`member/${op.id}`) !== null) return
      // A writer belongs to one agent, ever (a removed one can come back).
      const owner: string | null = (await view.get(`writer/${op.writer}`))?.value ?? null
      if (owner !== null && owner !== op.id) return
      if (op.invite !== undefined) {
        const invite = await view.get(`invite/${op.invite}`)
        if (invite === null || invite.value.expires <= at) return
        await view.del(`invite/${op.invite}`) // one use
      }
      await view.del(`removed/${op.id}`)
      await view.put(`writer/${op.writer}`, op.id)
      await view.put(`member/${op.id}`, {
        id: op.id, writers: [op.writer], devices: op.device ? { [op.writer]: op.device } : {}, written: [], name: op.name ?? null, roles: op.roles ?? ['member'], until: op.until ?? null, addedBy: author, at: op.at
      } satisfies MemberRecord)
      await host.addWriter(Buffer.from(op.writer, 'hex'), { indexer: false })
      return
    }
    case 'member.renew': {
      const rec = await view.get(`member/${op.id}`)
      if (rec === null) return
      await view.put(`member/${op.id}`, { ...rec.value, until: op.until })
      return
    }
    case 'member.roles': {
      const rec = await view.get(`member/${op.id}`)
      if (rec === null) return
      await view.put(`member/${op.id}`, { ...rec.value, roles: [...new Set(op.roles)] })
      return
    }
    case 'policy.set': {
      const existing = await view.get(`policy/${op.rule.name}`)
      if (existing === null && (await countKeys(view, 'policy/')) >= MAX_RULES) return
      const { name, from, to, allow } = op.rule
      await view.put(`policy/${name}`, { name, from, to, allow } satisfies PolicyRule)
      return
    }
    case 'policy.remove':
      await view.del(`policy/${op.name}`)
      return
    case 'member.remove': {
      // Admins leave through `admin.remove` (k of n), not here.
      if (await isAdmin(view, op.id)) return
      const rec = await view.get(`member/${op.id}`)
      if (rec === null) return
      for (const w of rec.value.writers as string[]) {
        const key = Buffer.from(w, 'hex')
        if (host.removeable(key)) await host.removeWriter(key)
      }
      await view.del(`member/${op.id}`)
      await view.put(`removed/${op.id}`, { by: author, at: op.at })
      return
    }
    case 'propose': {
      if (await view.get(`proposal/${op.pid}`) !== null) return
      const proposal: Proposal = { pid: op.pid, op: op.op, by: author, at: op.at, approvals: [author] }
      await view.put(`proposal/${op.pid}`, proposal)
      await settle(proposal, view, host, at)
      return
    }
    case 'approve': {
      const rec = await view.get(`proposal/${op.pid}`)
      if (rec === null) return
      const proposal = rec.value as Proposal
      if (op.at - proposal.at > PROPOSAL_TTL || op.at < proposal.at) return
      if (proposal.approvals.includes(author)) return
      proposal.approvals.push(author)
      await view.put(`proposal/${op.pid}`, proposal)
      await settle(proposal, view, host, at)
      return
    }
    case 'withdraw': {
      const rec = await view.get(`proposal/${op.pid}`)
      if (rec !== null && rec.value.by === author) await view.del(`proposal/${op.pid}`)
    }
  }
}

// Runs a proposal once enough of the current admins back it (`at`: the
// time of the op that settles it).
async function settle (proposal: Proposal, view: View, host: Host, at: number): Promise<void> {
  const admins = await adminIds(view)
  const backers = proposal.approvals.filter((id) => admins.includes(id))
  if (backers.length < quorumOf(await quorumSetting(view), admins.length)) return
  const op = proposal.op
  if (op.type === 'rules.set' && op.version > supported) {
    // Nothing of this op is applied: a newer build applies it whole.
    if (!host.interrupt) throw new Error(`rules v${op.version} is newer than this build's v${supported}`)
    host.interrupt(`rules:${op.version}`)
    return
  }
  await view.del(`proposal/${proposal.pid}`)
  switch (op.type) {
    case 'rules.set':
      // Only forward.
      if (op.version > await rulesOf(view)) await view.put('rules', op.version)
      return
    case 'admin.add': {
      const rec = await view.get(`member/${op.id}`)
      if (rec === null || admins.includes(op.id)) return
      await view.put(`admin/${op.id}`, { at: proposal.at })
      // Only writers that have written sign; the rest when they first do.
      for (const w of (rec.value as MemberRecord).written) await host.addWriter(Buffer.from(w, 'hex'), { indexer: true })
      return
    }
    case 'admin.remove': {
      // Demoted to a member; the last admin stays.
      if (!admins.includes(op.id) || admins.length === 1) return
      const rec = await view.get(`member/${op.id}`)
      await view.del(`admin/${op.id}`)
      for (const w of (rec?.value.writers ?? []) as string[]) await host.addWriter(Buffer.from(w, 'hex'), { indexer: false })
      return
    }
    case 'quorum.set':
      await view.put('quorum', { k: op.k })
      return
    case 'seed.rotate': {
      // A proposal made before another rotation passed is stale.
      const epoch = await epochOf(view)
      if (op.epoch !== epoch.n + 1) return
      // Only to devices of agents still members now: anyone removed (or
      // lapsed) since it was proposed gets nothing.
      const owners = await deviceOwners(view, at)
      let boxes = 0
      for (const [device, box] of Object.entries(op.boxes)) {
        if (!owners.has(device)) continue
        await view.put(`seed/${op.epoch}/${device}`, box)
        boxes++
      }
      await view.put('epoch', { n: op.epoch, at: proposal.at, check: op.check, boxes } satisfies Epoch)
    }
  }
}

interface Epoch {
  n: number
  at: number
  // The seed's commitment (seedCheck), and how many boxes it has.
  check: string
  boxes: number
}

// The seed's epoch: 0 until a rotation, then how many have passed.
async function epochOf (view: View): Promise<Epoch> {
  return (await view.get('epoch'))?.value ?? { n: 0, at: 0, check: '', boxes: 0 }
}

// The member whose device `device` is, by the group's record of its
// writers' devices, if it's still a member at `at`.
async function deviceOwner (view: View, device: string, at: number): Promise<string | null> {
  return (await deviceOwners(view, at)).get(device) ?? null
}

// Every device of every member at `at` (not lapsed), with its member.
async function deviceOwners (view: View, at: number): Promise<Map<string, string>> {
  const admins = new Set(await adminIds(view))
  const owners = new Map<string, string>()
  for await (const { value } of view.createReadStream({ gt: 'member/', lt: 'member0' })) {
    const m = value as MemberRecord
    if (m.until !== null && m.until <= at && !admins.has(m.id)) continue
    for (const d of Object.values(m.devices)) owners.set(d, m.id)
  }
  return owners
}

async function countKeys (view: View, prefix: string): Promise<number> {
  let n = 0
  for await (const _ of view.createReadStream({ gt: prefix, lt: prefix.slice(0, -1) + '0' })) n++
  return n
}

// k for `n` admins: a majority unless set, never more than n or less than 1.
export function quorumOf (setting: number | 'majority', n: number): number {
  const k = setting === 'majority' ? Math.floor(n / 2) + 1 : setting
  return Math.max(1, Math.min(n, k))
}

async function quorumSetting (view: View): Promise<number | 'majority'> {
  return (await view.get('quorum'))?.value?.k ?? 'majority'
}

// The member a writer writes for, if it's one of that member's current
// writers: a retired writer (writer.remove) no longer speaks for anyone.
async function authorOf (view: View, writer: string): Promise<string | null> {
  const id: string | null = (await view.get(`writer/${writer}`))?.value ?? null
  if (id === null) return null
  const rec = await view.get(`member/${id}`)
  return rec !== null && (rec.value as MemberRecord).writers.includes(writer) ? id : null
}

// Notes that `writer` has written; an admin's writer starts signing then.
async function markWritten (view: View, host: Host, author: string, writer: string): Promise<void> {
  const rec = await view.get(`member/${author}`)
  if (rec === null) return
  const m = rec.value as MemberRecord
  if (m.written.includes(writer)) return
  await view.put(`member/${author}`, { ...m, written: [...m.written, writer] })
  if (await isAdmin(view, author)) await host.addWriter(Buffer.from(writer, 'hex'), { indexer: true })
}

// Whether the group's policy lets `author` post jobs for each of `targets`
// (see mayPost): read from the view, and only what the rules need.
async function postAllowed (view: View, author: string, targets: Array<string | null>): Promise<boolean> {
  const policy = await readPolicy(view)
  if (policy.length === 0) return true
  const ids = [...new Set([author, ...targets.filter((t): t is string => t !== null && !t.startsWith('role:'))])]
  const members: MemberRecord[] = []
  const admins: string[] = []
  for (const id of ids) {
    const m = (await view.get(`member/${id}`))?.value as MemberRecord | undefined
    if (m) members.push(m)
    if (await isAdmin(view, id)) admins.push(id)
  }
  const roster = { policy, members, admins }
  return targets.every((to) => mayPost(roster, author, to))
}

// The group's clock: the latest time any admin's op carries. Times in ops
// are their authors' word; admins are trusted already (they sign the
// log), so their times decide when a lease has run out or a membership
// lapsed, and a member's clock can't. (An admin's clock far ahead makes
// leases and memberships lapse early for everyone.)
async function advanceClock (view: View, admin: boolean, at: number): Promise<{ clock: number, moved: boolean }> {
  const clock: number = (await view.get('clock'))?.value ?? 0
  if (!admin || at <= clock) return { clock, moved: false }
  await view.put('clock', at)
  return { clock: at, moved: true }
}

async function readPolicy (view: View): Promise<PolicyRule[]> {
  const policy: PolicyRule[] = []
  for await (const { value } of view.createReadStream({ gt: 'policy/', lt: 'policy0' })) policy.push(value)
  return policy
}

async function isAdmin (view: View, id: string): Promise<boolean> {
  return await view.get(`admin/${id}`) !== null
}

async function adminIds (view: View): Promise<string[]> {
  const ids: string[] = []
  for await (const { key } of view.createReadStream({ gt: 'admin/', lt: 'admin0' })) ids.push(key.slice('admin/'.length))
  return ids
}

// The group as one snapshot of the view.
export interface Roster {
  // The group's own name, given when it was made.
  title: string | null
  admins: string[]
  members: MemberRecord[]
  removed: string[]
  invites: InviteRecord[]
  proposals: Proposal[]
  quorum: { setting: number | 'majority', k: number }
  policy: PolicyRule[]
  // The group's clock (ms): the latest time an admin's op carries.
  clock: number
  // The group's rules version (see RULES).
  rules: number
  // The seed's epoch, its commitment, and its seed sealed to each device
  // that has a box (read only when asked for: see readRoster).
  seed: { epoch: number, at: number, check: string, count: number, boxes: Record<string, string> }
}

// `boxes`: also read the current epoch's sealed seeds (one per device).
export async function readRoster (view: View, opts: { boxes?: boolean } = {}): Promise<Roster> {
  const admins = await adminIds(view)
  const members: MemberRecord[] = []
  for await (const { value } of view.createReadStream({ gt: 'member/', lt: 'member0' })) members.push(value)
  const removed: string[] = []
  for await (const { key } of view.createReadStream({ gt: 'removed/', lt: 'removed0' })) removed.push(key.slice('removed/'.length))
  const invites: InviteRecord[] = []
  for await (const { value } of view.createReadStream({ gt: 'invite/', lt: 'invite0' })) invites.push(value)
  const proposals: Proposal[] = []
  for await (const { value } of view.createReadStream({ gt: 'proposal/', lt: 'proposal0' })) proposals.push(value)
  const setting = await quorumSetting(view)
  const policy = await readPolicy(view)
  const clock: number = (await view.get('clock'))?.value ?? 0
  const rules = await rulesOf(view)
  const epoch = await epochOf(view)
  const boxes = opts.boxes === true ? await readBoxes(view, epoch.n) : {}
  const title: string | null = (await view.get('meta'))?.value?.title ?? null
  return { title, admins, members, removed, invites, proposals, quorum: { setting, k: quorumOf(setting, admins.length) }, policy, clock, rules, seed: { epoch: epoch.n, at: epoch.at, check: epoch.check, count: epoch.boxes, boxes } }
}

// The sealed seeds of epoch `n`, by device.
export async function readBoxes (view: View, n: number): Promise<Record<string, string>> {
  const boxes: Record<string, string> = {}
  if (n === 0) return boxes
  for await (const { key, value } of view.createReadStream({ gt: `seed/${n}/`, lt: `seed/${n}0` })) boxes[key.slice(`seed/${n}/`.length)] = value
  return boxes
}

// Whether `from` may call `to` (both identities) by the roster's policy.
// The rules matching both sides are weighed by how specifically they name
// the caller (an identity, then a role, then '*'), then the callee; among
// equally specific rules, a deny wins. No matching rule: allowed.
export function allows (roster: Roster, from: string, to: string): boolean {
  return decide(roster.policy, from, rolesIn(roster, from), to, rolesIn(roster, to))
}

// Whether the policy lets `from` post a job (or start a workflow step)
// for `to`: a role, an identity, or anyone (null). Posting a job asks its
// taker to run it as the poster, so it's a call: to an identity, the rules
// on calling it; to a role, the rules naming that role (or '*'); to
// anyone, the rules naming '*'.
export function mayPost (roster: Pick<Roster, 'policy' | 'members' | 'admins'>, from: string, to: string | null): boolean {
  // A member may always hand work to its own devices, as it may call them.
  if (to === from) return true
  const fromRoles = rolesIn(roster, from)
  if (to === null) return decide(roster.policy, from, fromRoles, null, [])
  if (to.startsWith('role:')) return decide(roster.policy, from, fromRoles, null, [to.slice(5)])
  return decide(roster.policy, from, fromRoles, to, rolesIn(roster, to))
}

function rolesIn (roster: Pick<Roster, 'members' | 'admins'>, id: string): string[] {
  const roles = roster.members.find((m) => m.id === id)?.roles ?? []
  return roster.admins.includes(id) ? [...roles, 'admin'] : roles
}

// The rule naming both sides most specifically decides (the caller counts
// more); a deny wins a tie; with no rule, allowed.
function decide (policy: PolicyRule[], from: string, fromRoles: string[], to: string | null, toRoles: string[]): boolean {
  let best: { score: number, allow: boolean } | null = null
  for (const rule of policy) {
    const f = specificity(rule.from, from, fromRoles)
    const t = specificity(rule.to, to, toRoles)
    if (f < 0 || t < 0) continue
    const score = f * 3 + t
    if (best === null || score > best.score) best = { score, allow: rule.allow }
    else if (score === best.score && !rule.allow) best.allow = false
  }
  return best?.allow ?? true
}

// How specifically `selector` names an agent: 2 by id, 1 by role, 0 for
// '*', -1 if it doesn't match.
function specificity (selector: string, id: string | null, roles: string[]): number {
  if (selector === '*') return 0
  if (selector.startsWith('role:')) return roles.includes(selector.slice(5)) ? 1 : -1
  return selector === id ? 2 : -1
}

// Whether `v` is a policy rule's name: lowercase letters, digits, '.',
// '_' and '-', up to 64.
export function isRuleName (v: unknown): v is string {
  return typeof v === 'string' && RULE_NAME.test(v)
}

// Whether `v` is a policy selector: '*', 'role:<role>' or an identity.
export function isSelector (v: unknown): v is string {
  if (typeof v !== 'string') return false
  return v === '*' || (v.startsWith('role:') && ROLE.test(v.slice(5))) || HEX32.test(v)
}

// Whether `id` may make A2A calls, by this roster at `now`: never before
// the group's clock, so a device behind the admins agrees with the group's
// rules about who has lapsed.
export function admitted (roster: Pick<Roster, 'admins' | 'members' | 'clock'>, id: string, now: number): boolean {
  if (roster.admins.includes(id)) return true
  const m = roster.members.find((r) => r.id === id)
  return m !== undefined && (m.until === null || m.until > Math.max(now, roster.clock))
}

// Op values arrive from any writer: check their shape before use.
export function parseOp (value: unknown): Op | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, any>
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return null
  switch (v.type) {
    case 'init':
      return isId(v.id) && optString(v.name) && optString(v.title) && (v.device === undefined || isId(v.device)) && (v.rules === undefined || (Number.isInteger(v.rules) && v.rules >= 1)) ? v as Op : null
    case 'invite.add': {
      const i = v.invite
      return i && isId(i.id) && isId(i.publicKey) && typeof i.expires === 'number' && isRoles(i.roles) && (i.days === null || isPositive(i.days)) ? v as Op : null
    }
    case 'invite.remove':
      return isId(v.id) ? v as Op : null
    case 'member.add':
      return isId(v.id) && isId(v.writer) && (v.device === undefined || isId(v.device)) && optString(v.name) && (v.roles === undefined || isRoles(v.roles)) &&
        (v.until === undefined || v.until === null || typeof v.until === 'number') && (v.invite === undefined || isId(v.invite))
        ? v as Op
        : null
    case 'member.renew':
      return isId(v.id) && (v.until === null || typeof v.until === 'number') ? v as Op : null
    case 'member.remove':
      return isId(v.id) ? v as Op : null
    case 'member.roles':
      return isId(v.id) && isRoles(v.roles) ? v as Op : null
    case 'policy.set': {
      const r = v.rule
      return r && typeof r.name === 'string' && RULE_NAME.test(r.name) && isSelector(r.from) && isSelector(r.to) && typeof r.allow === 'boolean' ? v as Op : null
    }
    case 'policy.remove':
      return typeof v.name === 'string' && RULE_NAME.test(v.name) ? v as Op : null
    case 'seed.share':
      return Number.isInteger(v.epoch) && v.epoch > 0 && isId(v.device) && typeof v.box === 'string' && BOX.test(v.box) && isId(v.check) ? v as Op : null
    case 'writer.add':
      return isId(v.writer) && isId(v.device) ? v as Op : null
    case 'writer.remove':
      return isId(v.writer) ? v as Op : null
    case 'hello':
    case 'clock.tick':
      return v as Op
    case 'job.post':
    case 'job.claim':
    case 'job.release':
    case 'job.renew':
    case 'job.done':
    case 'job.cancel':
    case 'job.ask':
    case 'job.answer':
      return parseJobOp(v) === null ? null : v as Op
    case 'flow.start':
    case 'flow.cancel':
    case 'schedule.set':
    case 'schedule.drop':
      return parseFlowOp(v) === null ? null : v as Op
    case 'task.put': {
      const t = v.task
      const ok = typeof t === 'object' && t !== null && typeof t.id === 'string' && t.id.length <= 200 && typeof t.contextId === 'string' &&
        typeof t.status?.state === 'string' && (v.owner === null || isId(v.owner)) && JSON.stringify(t).length <= MAX_SHARED_TASK
      return ok ? v as Op : null
    }
    case 'propose':
      return isId(v.pid) && isQuorumOp(v.op) ? v as Op : null
    case 'approve':
    case 'withdraw':
      return isId(v.pid) ? v as Op : null
    default:
      return null
  }
}

function isQuorumOp (op: any): op is QuorumOp {
  if (typeof op !== 'object' || op === null) return false
  if (op.type === 'admin.add' || op.type === 'admin.remove') return isId(op.id)
  if (op.type === 'quorum.set') return op.k === 'majority' || (Number.isInteger(op.k) && op.k >= 1)
  // Any version: one newer than this build's must still settle here, to
  // stop at it (see settle).
  if (op.type === 'rules.set') return Number.isInteger(op.version) && op.version >= 1 && op.version <= 1_000_000
  if (op.type === 'seed.rotate') {
    if (!Number.isInteger(op.epoch) || op.epoch < 1 || !isId(op.check) || typeof op.boxes !== 'object' || op.boxes === null || Array.isArray(op.boxes)) return false
    const entries = Object.entries(op.boxes)
    return entries.length > 0 && entries.length <= MAX_BOXES && entries.every(([d, b]) => isId(d) && typeof b === 'string' && BOX.test(b))
  }
  return false
}

export function isId (v: unknown): v is string {
  return typeof v === 'string' && HEX32.test(v)
}

export function isRoles (v: unknown): v is Role[] {
  return Array.isArray(v) && v.length > 0 && v.length <= MAX_ROLES && v.every((r) => typeof r === 'string' && ROLE.test(r) && r !== 'admin')
}

function isPositive (v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

function optString (v: unknown): boolean {
  return v === undefined || (typeof v === 'string' && v.length <= 200)
}

function hex (b: Uint8Array): string {
  return Buffer.from(b).toString('hex')
}

// Why `op` wouldn't take effect on `roster`, or null: what `apply` checks,
// worded for a person. Lets a caller refuse an op up front instead of
// appending one that apply skips without a word.
export function explain (op: AdminOp | { type: 'propose', op: QuorumOp }, roster: Roster): string | null {
  const isMember = (id: string): boolean => roster.members.some((m) => m.id === id)
  const isAdmin = (id: string): boolean => roster.admins.includes(id)
  if (parseOp({ ...op, at: 0, pid: '0'.repeat(64) }) === null) return 'malformed group operation'
  switch (op.type) {
    case 'member.add':
      return isMember(op.id) ? 'already a member' : null
    case 'member.renew':
    case 'member.roles':
      return isMember(op.id) ? null : 'not a member'
    case 'policy.set':
      return roster.policy.length >= MAX_RULES && !roster.policy.some((r) => r.name === op.rule.name) ? `the group already has ${MAX_RULES} rules` : null
    case 'policy.remove':
      return roster.policy.some((r) => r.name === op.name) ? null : 'no rule with that name'
    case 'member.remove':
      if (isAdmin(op.id)) return 'that agent is an admin: propose `admin remove` first'
      return isMember(op.id) ? null : 'not a member'
    case 'invite.add':
    case 'invite.remove':
      return null
    case 'propose': {
      const q = op.op
      if (q.type === 'admin.add') {
        if (!isMember(q.id)) return 'not a member: invite it first'
        return isAdmin(q.id) ? 'already an admin' : null
      }
      if (q.type === 'admin.remove') {
        if (!isAdmin(q.id)) return 'not an admin'
        return roster.admins.length === 1 ? 'the group\'s last admin can\'t be removed' : null
      }
      if (q.type === 'seed.rotate') {
        return q.epoch === roster.seed.epoch + 1 ? null : 'another rotation passed meanwhile: try again'
      }
      return null
    }
  }
}

// The task with `id` that `agent` serves, as the group stores it.
export async function readTask (view: View, agent: string, id: string): Promise<TaskRecord | null> {
  return (await view.get(`task/${agent}/${id}`))?.value ?? null
}

// Every task `agent` serves.
export async function * readTasks (view: View, agent: string): AsyncGenerator<TaskRecord> {
  for await (const { value } of view.createReadStream({ gt: `task/${agent}/`, lt: `task/${agent}0` })) yield value
}

function stamp (task: SharedTask): number {
  return Date.parse(task.status?.timestamp ?? '') || 0
}

// Whether a shared task is a cut-down copy (too big to store whole), not
// the whole task: then it never replaces a device's own.
export function isTrimmed (task: { metadata?: unknown }): boolean {
  const m = task.metadata as Record<string, unknown> | undefined
  return m?.['pai/artifacts-omitted'] === true || m?.['pai/trimmed'] === true
}
