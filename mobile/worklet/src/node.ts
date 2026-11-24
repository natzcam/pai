// The phone's pai: one device of its user's identity, for the people in
// its groups' loops. It joins with a device invite (`pai device invite` on
// another of the identity's devices), gets the identity's groups from its
// other devices, then offers what a person does, across every group: answer
// a job's question, take a job held for a person and finish it (with a
// workflow's branch choices), approve a proposal, post jobs, follow and
// rerun workflows, leave. It has no transport of its own; ipc.ts serves it
// to the app over the worklet's IPC.
//
// Its keys (the device's key pair, the identity's, and each group's) aren't
// kept in files: the app keeps them in the OS's key store (Keychain,
// Keystore), hands them over at start (`secrets`), and stores the ones a
// join makes, and the new set whenever a group is added ('secrets'). The
// groups' data under `dir` stays in the app's own storage.

import { EventEmitter } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import HyperDHT from 'hyperdht'
import { Pai } from '../../../src/pai.js'
import type { CardInput } from '../../../src/pai.js'
import { GroupIdentity, joinDevice } from '../../../src/identity/group.js'
import type { GroupEntry, Inbox } from '../../../src/identity/group.js'
import type { GroupMembership } from '../../../src/group/membership.js'
import { isJobId, isJobTarget, partsText, specProblem } from '../../../src/group/jobs.js'
import type { JobRecord, JobSpec } from '../../../src/group/jobs.js'
import { loopsOf, resultMeets } from '../../../src/group/flows.js'
import type { FlowCondition, FlowSpec, FlowSummary, FlowView } from '../../../src/group/flows.js'

// What the app keeps in the OS's key store: this phone's name, its device
// key pair (the secret key, hex: the public key is its last 32 bytes), the
// identity's key and secret, and each group's name, slot, key and seed
// (hex).
export interface PhoneSecrets {
  pai: 'phone/1'
  name: string
  secretKey: string
  identity: string
  secret: string
  groups: Array<{ name: string, slot: string, key: string, seed: string }>
}

// One of the identity's groups, as the phone shows it.
export interface GroupStatus {
  id: string
  name: string
  title: string | null
  members: number
  // The identity's roles there.
  roles: string[]
  writable: boolean
}

export interface PhoneNodeOptions {
  // The app's own folder for pai: the group's data, its tasks.
  dir: string
  // The keys, once joined (see PhoneSecrets).
  secrets?: PhoneSecrets | null
  // DHT bootstrap nodes (a testnet's); the public DHT by default.
  bootstrap?: Array<{ host: string, port: number }>
  timeout?: number
}

export interface Status {
  // Joined an identity (has its keys), and running.
  joined: boolean
  running: boolean
  name: string | null
  identity: string | null
  device: string | null
  // The identity's groups; and across them, its roles, how many members
  // they have, and whether it can write to all of them yet.
  groups: GroupStatus[]
  roles: string[]
  members: number
  writable: boolean
  // Devices it's connected to now: none while it (re)connects.
  peers: number
  // Why the group stopped (see GroupIdentity.problem), or null.
  problem: string | null
}

// What finishing a workflow's step leads to: the steps that test its
// result. `answers`: results a branch looks for (equals or contains), each
// with the steps it starts; `otherwise`: the steps any other result starts;
// `onFail`: the steps a failure starts. Empty when nothing tests it.
export interface Choices {
  answers: Array<{ text: string, leadsTo: string[] }>
  otherwise: string[]
  onFail: string[]
}

// The inbox of every group, each item naming its group, with what each
// held job runs as where that's more than its text (attached results, or a
// note on a retry), and the choices a held workflow step's result makes.
type InGroup<T> = T & { group: string }
export type PhoneInbox = { [K in keyof Inbox]: Array<InGroup<Inbox[K][number]>> } & { inputs: Record<string, string>, choices: Record<string, Choices> }

// How long a fresh start may go without reaching another device before
// it's tried once more (see #watchFirstPeer).
const FIRST_PEER_WAIT = 30_000

export class PhoneNode extends EventEmitter {
  readonly dir: string
  readonly storage: string
  #opts: PhoneNodeOptions
  #pai: Pai | null = null
  #identity: GroupIdentity | null = null
  #secrets: PhoneSecrets | null
  #starting: Promise<void> | null = null
  #unsubscribe: (() => void) | null = null
  #inputs = new Map<string, Promise<string>>()
  #watch: ReturnType<typeof setTimeout> | null = null
  // Bumped by close and wipe: a restart begun before one of them doesn't
  // carry on after it.
  #generation = 0
  #suspended = false

  constructor (opts: PhoneNodeOptions) {
    super()
    this.#opts = opts
    this.#secrets = opts.secrets ? checkSecrets(opts.secrets) : null
    this.dir = opts.dir
    this.storage = join(opts.dir, 'agent')
  }

  status (): Status {
    const identity = this.#identity
    const groups: GroupStatus[] = (identity?.groups() ?? []).map((g) => {
      const roster = g.roster()
      return { id: g.id, name: g.name, title: roster.title, members: roster.members.length, roles: roster.members.find((m) => m.id === g.self)?.roles ?? [], writable: g.base.writable }
    })
    const members = new Set((identity?.groups() ?? []).flatMap((g) => g.roster().members.map((m) => m.id)))
    return {
      joined: this.#secrets !== null,
      running: this.#pai !== null,
      name: this.#secrets?.name ?? null,
      identity: identity?.self ?? null,
      device: this.#pai ? Buffer.from(this.#pai.id).toString('hex') : null,
      groups,
      roles: [...new Set(groups.flatMap((g) => g.roles))],
      members: members.size,
      writable: groups.length > 0 && groups.every((g) => g.writable),
      peers: this.#pai?.peers.length ?? 0,
      problem: identity?.problem ?? null
    }
  }

  // Starts the agent if this phone has joined an identity; says whether.
  async start (): Promise<boolean> {
    if (this.#pai) return true
    if (this.#secrets === null) return false
    await this.#run(this.#secrets)
    return true
  }

  // Joins the identity whose device made `code`, as a new device named
  // `name`, then starts. That device has to be running. Returns the keys
  // for the app to keep (they're nowhere else).
  async join (code: string, name: string, opts: { signal?: AbortSignal } = {}): Promise<{ status: Status, secrets: PhoneSecrets, startError?: string }> {
    if (this.#secrets !== null) throw new Error('This phone already joined an identity')
    if (typeof code !== 'string' || code.trim() === '') throw new Error('A device invite code is needed (make one with `pai device invite`)')
    if (typeof name !== 'string' || name.trim() === '') throw new Error('A name for this phone is needed')
    // No keys, so any data here is from a join that didn't finish (the
    // app was killed before keeping them), or a phone that left: start clean.
    await rm(this.storage, { recursive: true, force: true })
    await mkdir(this.storage, { recursive: true })
    const keyPair = HyperDHT.keyPair()
    const named = name.trim().slice(0, 200)
    const keys = await joinDevice({
      storage: this.storage,
      keyPair,
      code: code.trim(),
      name: named,
      ...(this.#opts.bootstrap ? { bootstrap: this.#opts.bootstrap } : {}),
      ...(this.#opts.timeout ? { timeout: this.#opts.timeout } : {}),
      ...(opts.signal ? { signal: opts.signal } : {})
    })
    // Its groups come once it runs, from the identity's other devices.
    const secrets: PhoneSecrets = { pai: 'phone/1', name: named, secretKey: hex(keyPair.secretKey), identity: hex(keys.identity), secret: hex(keys.secret), groups: [] }
    this.#secrets = secrets
    // Joined either way: the keys go back to be kept even if pai doesn't
    // start, and `start` tries again (else they'd be lost, and the
    // identity left with a device nobody has).
    let startError: string | undefined
    try {
      await this.#run(secrets)
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err)
    }
    return { status: this.status(), secrets, ...(startError !== undefined ? { startError } : {}) }
  }

  // Leaves the identity: removes this phone from it (confirmed by another
  // of its devices, so that one has to be running), then wipes its data.
  // The app forgets the keys after.
  async leave (): Promise<void> {
    await this.#need().leave()
    await this.wipe()
  }

  // Stops and deletes this phone's pai data, without telling the identity
  // (when leaving can't reach another device: remove this one from there
  // with \`pai device remove\`).
  async wipe (): Promise<void> {
    await this.close()
    await rm(this.storage, { recursive: true, force: true })
    this.#secrets = null
    this.emit('change')
  }

  async inbox (): Promise<PhoneInbox> {
    const box: PhoneInbox = { questions: [], open: [], held: [], proposals: [], inputs: {}, choices: {} }
    const next = new Map<string, Promise<string>>()
    for (const g of this.#need().groups()) {
      const mine = await g.inbox()
      const mark = <T extends object>(x: T): InGroup<T> => ({ ...x, group: g.name })
      box.questions.push(...mine.questions.map(mark))
      box.open.push(...mine.open.map(mark))
      box.held.push(...mine.held.map(mark))
      box.proposals.push(...mine.proposals.map(mark))
      await Promise.all(mine.held.map(async (j) => {
        if (!j.spec.attach?.length && !((j.attempt ?? 1) > 1 && j.lastError != null)) return
        const key = `${j.id} ${j.claim?.at ?? 0}`
        const input = this.#inputs.get(key) ?? next.get(key) ?? g.jobInput(j).then((m) => partsText(m.parts, '\n\n'))
        next.set(key, input)
        try {
          box.inputs[j.id] = await input
        } catch {
          next.delete(key)
        }
      }))
      // Each workflow read once, however many of its steps are held.
      const flows = new Map<string, Promise<FlowView | null>>()
      await Promise.all(mine.held.map(async (j) => {
        if (!j.flow || j.flow.item !== undefined) return
        let flow = flows.get(j.flow.id)
        if (!flow) flows.set(j.flow.id, flow = g.getFlow(j.flow.id).catch(() => null))
        const view = await flow
        if (view) box.choices[j.id] = choicesOf(view, j.flow.step)
      }))
    }
    this.#inputs = next
    return box
  }

  // The members of every group (each once, with its roles across them):
  // who posted a job, who a role is.
  members (): Array<{ id: string, name: string | null, roles: string[] }> {
    const all = new Map<string, { id: string, name: string | null, roles: string[] }>()
    for (const g of this.#need().groups()) {
      for (const m of g.roster().members) {
        const seen = all.get(m.id)
        all.set(m.id, { id: m.id, name: seen?.name ?? m.name, roles: [...new Set([...(seen?.roles ?? []), ...m.roles])] })
      }
    }
    return [...all.values()]
  }

  // Every group's board, each job naming its group.
  async jobs (): Promise<Array<InGroup<JobRecord>>> {
    const all: Array<InGroup<JobRecord>> = []
    for (const g of this.#need().groups()) for (const j of await g.listJobs()) all.push({ ...j, group: g.name })
    return all
  }

  async job (id: string): Promise<InGroup<JobRecord> | null> {
    const found = await this.#withJob(id)
    return found ? { ...found.job, group: found.group.name } : null
  }

  // Takes a job to do by hand. `input`: what it runs as, when taken.
  async take (id: string): Promise<{ job: JobRecord, mine: boolean, input?: string }> {
    const g = await this.#groupOfJob(id)
    const taken = await g.takeJob(jobId(id))
    if (!taken.mine) return taken
    return { ...taken, input: partsText((await g.jobInput(taken.job)).parts, '\n\n') }
  }

  // Ends a job this phone holds: done with its result, or failed with why.
  async finish (id: string, state: 'done' | 'failed', text: string | null): Promise<JobRecord | null> {
    if (state !== 'done' && state !== 'failed') throw new Error('state is done or failed')
    if (text !== null && typeof text !== 'string') throw new Error('text is a string')
    const g = await this.#held(id)
    await g.finishJob(id, { state, result: text, ref: null })
    return await g.getJob(id)
  }

  // Gives a job this phone holds back to the board.
  async release (id: string): Promise<JobRecord | null> {
    const g = await this.#held(id)
    await g.releaseJob(id)
    return await g.getJob(id)
  }

  async answer (id: string, text: string): Promise<JobRecord> {
    if (typeof text !== 'string' || text === '') throw new Error('An answer has text')
    return await (await this.#groupOfJob(id)).answerJob(jobId(id), text)
  }

  async cancel (id: string): Promise<JobRecord> {
    return await (await this.#groupOfJob(id)).cancelJob(jobId(id))
  }

  // Posts a job in `group` (a name or id; default the first group).
  async post (spec: JobSpec, opts: { to?: string, group?: string } = {}): Promise<JobRecord> {
    const problem = specProblem(spec)
    if (problem) throw new Error(problem)
    if (opts.to !== undefined && !isJobTarget(opts.to)) throw new Error('to is role:<role> or an identity id')
    return await this.#need().group(opts.group).postJob(spec, opts.to ? { to: opts.to } : {})
  }

  async approve (pid: string): Promise<void> {
    if (typeof pid !== 'string' || !/^[0-9a-f]{64}$/.test(pid)) throw new Error('Expected a proposal id (64 hex characters)')
    const g = this.#need().groups().find((x) => x.roster().proposals.some((p) => p.pid === pid))
    if (!g) throw new Error('No open proposal with that id (it may have passed or lapsed)')
    await g.act({ type: 'approve', pid })
  }

  // Every group's workflows, each naming its group.
  async flows (): Promise<Array<InGroup<FlowSummary>>> {
    const all: Array<InGroup<FlowSummary>> = []
    for (const g of this.#need().groups()) for (const f of await g.listFlows()) all.push({ ...f, group: g.name })
    return all
  }

  async flow (id: string): Promise<InGroup<FlowView> | null> {
    for (const g of this.#need().groups()) {
      const f = await g.getFlow(jobId(id))
      if (f) return { ...f, group: g.name }
    }
    return null
  }

  // Starts a workflow: `from`, an earlier one's id, to run its steps again
  // on new `input`, in its group.
  async rerun (from: string, input: string): Promise<FlowView> {
    if (typeof input !== 'string' || input.trim() === '') throw new Error('A workflow needs input')
    const g = await this.#groupOfFlow(from)
    const old = (await g.getFlow(jobId(from)))!
    const spec: FlowSpec = { ...(old.name ? { name: old.name } : {}), steps: old.steps }
    return await g.startFlow(spec, input)
  }

  async cancelFlow (id: string): Promise<void> {
    await (await this.#groupOfFlow(id)).cancelFlow(jobId(id))
  }

  // The OS is about to pause the app, or has resumed it.
  async suspend (): Promise<void> {
    this.#suspended = true
    await this.#pai?.suspend()
  }

  // Reconnecting takes a while after (the swarm finds its peers again;
  // a first attempt on stale network state may fail and back off): the
  // status's `peers` says when it has.
  async resume (): Promise<void> {
    this.#suspended = false
    await this.#pai?.resume()
    this.emit('change')
  }

  async close (): Promise<void> {
    this.#generation++
    await this.#stop()
  }

  async #stop (): Promise<void> {
    if (this.#watch !== null) clearTimeout(this.#watch)
    this.#watch = null
    await this.#starting?.catch(() => {})
    this.#unsubscribe?.()
    this.#unsubscribe = null
    const pai = this.#pai
    this.#pai = null
    this.#identity = null
    await pai?.close()
  }

  // Seen on phones over the public DHT, mostly right after a join: the
  // agent never reaches another device (no peer, the group never syncs),
  // while a fresh start of it does at once. Until that's understood: no
  // peer 30 s after starting, and it restarts once.
  #watchFirstPeer (secrets: PhoneSecrets, retry: boolean): void {
    if (!retry) return
    this.#watch = setTimeout(() => {
      this.#watch = null
      if (this.#pai === null || this.#pai.peers.length > 0 || this.#suspended) return
      this.#restart(secrets).catch(() => {})
    }, FIRST_PEER_WAIT)
  }

  async #restart (secrets: PhoneSecrets): Promise<void> {
    const generation = this.#generation
    await this.#stop()
    if (generation !== this.#generation || this.#secrets !== secrets) return
    try {
      await this.#run(secrets, false)
    } finally {
      // Running again, or not (status says): the app looks either way.
      this.emit('change')
    }
  }

  async #run (secrets: PhoneSecrets, retry = true): Promise<void> {
    if (this.#starting) return await this.#starting
    this.#starting = (async () => {
      const secretKey = Buffer.from(secrets.secretKey, 'hex')
      await mkdir(this.storage, { recursive: true })
      const identity = new GroupIdentity({
        storage: this.storage,
        keys: { identity: bytes(secrets.identity), secret: bytes(secrets.secret) },
        groups: secrets.groups.map((g) => ({ name: g.name, slot: g.slot, key: bytes(g.key), seed: bytes(g.seed) })),
        // A group learned from another device: the app keeps the new keys.
        onGroups: (groups) => { this.#keep(secrets, groups) }
      })
      const pai = new Pai({
        identity,
        storage: this.storage,
        keyPair: { publicKey: secretKey.subarray(32), secretKey },
        card: phoneCard(secrets.name),
        ...(this.#opts.bootstrap ? { bootstrap: this.#opts.bootstrap } : {}),
        ...(this.#opts.timeout ? { timeout: this.#opts.timeout } : {})
      })
      try {
        await pai.ready()
      } catch (err) {
        await pai.close().catch(() => {})
        throw err
      }
      this.#pai = pai
      this.#identity = identity
      this.#unsubscribe = identity.onAdmissionChange(() => { this.emit('change') })
      this.emit('change')
      this.#watchFirstPeer(secrets, retry)
    })()
    try {
      await this.#starting
    } finally {
      this.#starting = null
    }
  }

  // The identity's groups changed: the secrets with them, for the app to
  // keep ('secrets').
  #keep (secrets: PhoneSecrets, groups: GroupEntry[]): void {
    if (this.#secrets !== secrets) return
    secrets.groups = groups.map((g) => ({ name: g.name, slot: g.slot, key: hex(g.key), seed: hex(g.seed) }))
    this.emit('secrets', secrets)
  }

  #need (): GroupIdentity {
    if (!this.#identity) throw new Error(this.#secrets === null ? 'This phone hasn\'t joined an identity yet' : 'pai isn\'t running yet')
    return this.#identity
  }

  // The group a job is on, and the job.
  async #withJob (id: string): Promise<{ group: GroupMembership, job: JobRecord } | null> {
    for (const g of this.#need().groups()) {
      const job = await g.getJob(jobId(id))
      if (job) return { group: g, job }
    }
    return null
  }

  async #groupOfJob (id: string): Promise<GroupMembership> {
    const found = await this.#withJob(id)
    if (!found) throw new Error('No such job')
    return found.group
  }

  async #groupOfFlow (id: string): Promise<GroupMembership> {
    for (const g of this.#need().groups()) if (await g.getFlow(jobId(id))) return g
    throw new Error('No such workflow')
  }

  // Only a job taken by hand on this phone: not one another device holds.
  async #held (id: string): Promise<GroupMembership> {
    const found = await this.#withJob(id)
    if (!found || !found.group.holdsByHand(found.job)) throw new Error('This phone doesn\'t hold that job: take it first')
    return found.group
  }
}

// It answers no messages: a person's device, not an agent's.
function phoneCard (name: string): CardInput {
  const description = 'A person in the loop, on their phone'
  return { name, description, version: '1.0.0', capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [{ id: 'person', name, description, tags: ['person'] }] }
}

// What a step's result leads to, read off the steps that test it, with
// the group's own test (resultMeets): each answer a branch looks for, with
// every step that answer starts (a `not` test's too); what any other
// result starts (the `not` tests, as for text no branch names); and what a
// failure starts. A step that runs once it's done, whatever its result
// (`failed` with `not`), is in each. A repeat that tests the step goes on
// to the steps after it (without a test of their own; else "the end")
// when its `until` holds, or on its last round, and else starts "<its
// first step> again".
export function choicesOf (flow: Pick<FlowView, 'steps' | 'loops'>, step: string): Choices {
  const tests: Array<{ name: string, c: FlowCondition }> = []
  const always: string[] = []
  const onFail: string[] = []
  const branch = (name: string, c: FlowCondition): void => {
    if (c.failed) (c.not ? always : onFail).push(name)
    else tests.push({ name, c })
  }
  for (const s of flow.steps) {
    if (s.if?.step === step) branch(s.name, s.if)
  }
  for (const { end, names: range, repeat: r } of loopsOf(flow.steps)) {
    if (r.until.step !== step) continue
    const after = flow.steps.filter((x) => !range.includes(x.name) && x.if === undefined && (x.after ?? []).some((a) => range.includes(a))).map((x) => x.name)
    const on = after.length ? after : ['the end']
    if ((flow.loops?.[end]?.round ?? 0) + 1 >= r.max) {
      always.push(...on)
      // A failure it was retrying is the workflow's on the last round.
      if (r.until.failed && r.until.not !== true) onFail.push(...on)
      continue
    }
    for (const n of on) branch(n, r.until)
    branch(`${r.from} again`, { ...r.until, not: r.until.not !== true })
  }
  const texts = [...new Set(tests.filter((t) => !t.c.not).map((t) => t.c.equals ?? t.c.contains ?? ''))]
  const answers = texts.map((text) => ({ text, leadsTo: [...tests.filter((t) => resultMeets(t.c, text)).map((t) => t.name), ...always] }))
  const otherwise = [...tests.filter((t) => t.c.not).map((t) => t.name), ...always]
  return { answers, otherwise, onFail }
}

function checkSecrets (s: PhoneSecrets): PhoneSecrets {
  const hexOf = (v: unknown, n: number): boolean => typeof v === 'string' && v.length === n * 2 && /^[0-9a-f]+$/.test(v)
  const group = (g: PhoneSecrets['groups'][number]): boolean => typeof g?.name === 'string' && typeof g.slot === 'string' && hexOf(g.key, 32) && hexOf(g.seed, 32)
  if (s?.pai !== 'phone/1' || typeof s.name !== 'string' || !hexOf(s.secretKey, 64) || !hexOf(s.identity, 32) || !hexOf(s.secret, 32) || !Array.isArray(s.groups) || !s.groups.every(group)) {
    throw new Error('The stored keys are damaged')
  }
  return s
}

function bytes (h: string): Uint8Array {
  return Buffer.from(h, 'hex')
}

function hex (x: Uint8Array): string {
  return Buffer.from(x).toString('hex')
}

function jobId (id: unknown): string {
  if (!isJobId(id)) throw new Error('Expected an id (32 hex characters)')
  return id
}
