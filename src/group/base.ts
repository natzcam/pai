import { hkdfSync, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import Autobase from 'autobase'
import type Corestore from 'corestore'
import type Hyperbee from 'hyperbee'
import { RULES, admitted, apply, readBoxes, readRoster } from './state.js'
import type { ApplyNode, GroupAppend, Roster } from './state.js'
import type { JobRecord } from './jobs.js'
import { readFlow, readSchedules, summarize } from './flows.js'
import { nextDue } from './jobs.js'
import type { FlowRecord, FlowSummary, FlowView, ScheduleRecord } from './flows.js'
import { Replica, hex, viewMark } from '../util/replica.js'

// What an agent needs to open one of its groups: the base's key, and the
// seed that derives the base's encryption key, the discovery topic, the
// auth key and the group's public id.
export interface GroupKeys {
  key: Uint8Array
  seed: Uint8Array
}

const SALT = Buffer.from('pai/group/v1')

export function deriveGroupKey (seed: Uint8Array, label: 'topic' | 'auth' | 'base' | 'id'): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(seed), SALT, label, 32))
}

// A group's id: public among its members (tasks and requests name their
// group by it), and derived from the first seed, so only they know it.
export function groupId (seed: Uint8Array): string {
  return deriveGroupKey(seed, 'id').subarray(0, 8).toString('hex')
}

// The agent's Corestore lives in its storage folder. It holds this
// device's identity base (namespace `identity`), replicas of other
// members' identity bases (`identity/<key>`) and each group's base
// (`group/<slot>`): one store, so one replication stream per connection
// carries them all. A peer can only open the cores whose keys it has.
export function storeDir (storage: string): string {
  return join(storage, 'store')
}

// Where in the store a group lives. A slot is a local name, made when the
// group is created or joined (before its key is known: the writer key it
// gives comes from the namespace).
export function groupNamespace (slot: string): string {
  return `group/${slot}`
}

export function newSlot (): string {
  return randomBytes(8).toString('hex')
}

// This device's writer key in a base, before it's in it: what gets added
// to admit it. Writer keys come from the namespace, not the base, so it's
// known up front.
export async function localWriter (store: Corestore, namespace: string): Promise<Uint8Array> {
  const ns = store.namespace(namespace)
  try {
    return Buffer.from(await Autobase.getLocalKey(ns))
  } finally {
    await ns.close()
  }
}

// One agent's replica of the group's Autobase, with the roster read out of
// it. `roster` is the latest state; `signed` is the part a majority of
// admins has signed, which no reordering can undo. An agent is admitted
// only when both say so: a removal counts as soon as it's seen, an
// addition once it's signed. Emits 'change' after either moves.
export class GroupBase extends Replica {
  protected override readonly what = 'the group'
  readonly seed: Uint8Array
  roster: Roster = emptyRoster()
  signed: Roster = emptyRoster()
  // Where the view stood when each roster was last read, and the sealed
  // seeds as last read (kept until the epoch or its box count moves).
  #seen = { mark: '', signedLength: -1, boxes: '' }
  #boxes: Record<string, string> = {}

  // `store` is the agent's Corestore (see storeDir), which the caller
  // owns; `slot` is where in it this group lives.
  constructor (store: Corestore, keys: { key: Uint8Array | null, seed: Uint8Array }, slot: string) {
    super(store, groupNamespace(slot), keys.key, { apply, urgent, encryptionKey: deriveGroupKey(keys.seed, 'base') })
    this.seed = keys.seed
  }

  // A new group in `slot`, with `identity` (acting through `device`, its
  // Noise key) as its only admin. `name` is the admin's in the roster;
  // `title`, the group's own name, which invites carry.
  static async create (store: Corestore, slot: string, opts: { identity: Uint8Array, device: Uint8Array, name?: string, title?: string }): Promise<GroupKeys> {
    const seed = randomBytes(32)
    const group = new GroupBase(store, { seed, key: null }, slot)
    try {
      await group.ready()
      // Names are capped at 200 characters in the roster.
      await group.appendOp({
        type: 'init',
        id: hex(opts.identity),
        device: hex(opts.device),
        rules: RULES,
        ...(opts.name ? { name: opts.name.slice(0, 200) } : {}),
        ...(opts.title ? { title: opts.title.slice(0, 200) } : {})
      })
      if (!group.roster.admins.includes(hex(opts.identity))) throw new Error('The new group did not record its admin')
      return { key: Buffer.from(group.base.key), seed }
    } finally {
      await group.close()
    }
  }

  // Whether `id` may make A2A calls now: true; false for an agent removed
  // or whose membership lapsed; 'pending' for one whose addition isn't
  // signed yet, or that this replica doesn't know (it may still be syncing).
  admits (id: string, now = Date.now()): boolean | 'pending' {
    const latest = admitted(this.roster, id, now)
    if (latest) return admitted(this.signed, id, now) ? true : 'pending'
    if (this.roster.removed.includes(id) || this.roster.members.some((m) => m.id === id)) return false
    return 'pending'
  }

  isAdmin (id: string): boolean {
    return this.roster.admins.includes(id)
  }

  // Appends an op as this agent. Whether it takes effect is up to `apply`.
  // `at`: the op's time, when the caller needs to know it (default now).
  async append (op: GroupAppend, at?: number): Promise<void> {
    if (!this.writable) throw new Error('This agent is not a writer in the group yet (still syncing?)')
    await this.appendOp(at === undefined ? op : { ...op, at })
  }

  // The earliest time a job limit falls due and isn't swept yet, or null.
  async nextDue (): Promise<number | null> {
    return await this.#atView(false, async (view) => await nextDue(view))
  }

  // The job board, newest first. `signed`: only what a majority of admins
  // has signed, which no reordering can undo (a claim there is final).
  // `state` 'open' or 'claimed': only those, from their index.
  async jobs (signed = false, state?: 'open' | 'claimed'): Promise<JobRecord[]> {
    return await this.#atView(signed, async (view) => {
      const jobs: JobRecord[] = []
      if (state) {
        const prefix = `jobs/${state}/`
        for await (const { key } of view.createReadStream({ gt: prefix, lt: `jobs/${state}0` })) {
          const job = (await view.get(`job/${key.slice(prefix.length)}`))?.value as JobRecord | undefined
          if (job) jobs.push(job)
        }
      } else {
        for await (const { value } of view.createReadStream({ gt: 'job/', lt: 'job0' })) jobs.push(value as JobRecord)
      }
      return jobs.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
    })
  }

  // From one snapshot: the open and claimed jobs (from their index), and
  // the jobs named in `ids` (null where gone), oldest first.
  async activeJobs (signed: boolean, ids: string[] = []): Promise<{ active: JobRecord[], named: Map<string, JobRecord | null> }> {
    return await this.#atView(signed, async (view) => {
      const active: JobRecord[] = []
      for await (const { key } of view.createReadStream({ gt: 'jobs/', lt: 'jobs0' })) {
        const job = (await view.get(`job/${key.slice(key.lastIndexOf('/') + 1)}`))?.value as JobRecord | undefined
        if (job) active.push(job)
      }
      const named = new Map<string, JobRecord | null>()
      for (const id of ids) named.set(id, active.find((j) => j.id === id) ?? ((await view.get(`job/${id}`))?.value as JobRecord | undefined) ?? null)
      return { active: active.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)), named }
    })
  }

  // Workflows, newest first, as summaries.
  async flows (): Promise<FlowSummary[]> {
    return await this.#atView(false, async (view) => {
      const flows: FlowSummary[] = []
      for await (const { value } of view.createReadStream({ gt: 'flow/', lt: 'flow0' })) flows.push(summarize(value as FlowRecord))
      return flows.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
    })
  }

  // One workflow, with its results.
  async flow (id: string): Promise<FlowView | null> {
    return await this.#atView(false, async (view) => await readFlow(view, id))
  }

  // Whether a keyed start (keyedFlowId) has used `id`, its run kept or not.
  async keyUsed (id: string): Promise<boolean> {
    return await this.#atView(false, async (view) => await view.get(`flow-key/${id}`) !== null)
  }

  // The group's schedules, by name.
  async schedules (): Promise<ScheduleRecord[]> {
    return await this.#atView(false, async (view) => await readSchedules(view))
  }

  async job (id: string, signed = false): Promise<JobRecord | null> {
    return await this.#atView(signed, async (view) => ((await view.get(`job/${id}`))?.value as JobRecord | undefined) ?? null)
  }

  // Runs `read` on the latest view, or a snapshot of the signed part.
  async #atView<T> (signed: boolean, read: (view: Hyperbee) => Promise<T>): Promise<T> {
    const view = this.base.view
    await view.ready()
    if (!signed) return await read(view)
    const snapshot = view.checkout(view.core.signedLength)
    try {
      return await read(snapshot)
    } finally {
      await snapshot.close().catch(() => {})
    }
  }

  // Each roster is re-read only when its part of the view has moved.
  protected async read (view: Hyperbee): Promise<boolean> {
    const mark = viewMark(view)
    const signedLength = view.core.signedLength
    let changed = false
    if (mark !== this.#seen.mark) {
      const roster = await readRoster(view)
      const boxes = `${view.core.fork}:${roster.seed.epoch}:${roster.seed.count}`
      if (boxes !== this.#seen.boxes) {
        this.#boxes = await readBoxes(view, roster.seed.epoch)
        this.#seen.boxes = boxes
      }
      this.roster = { ...roster, seed: { ...roster.seed, boxes: this.#boxes } }
      this.#seen.mark = mark
      changed = true
    }
    if (signedLength !== this.#seen.signedLength) {
      const snapshot = view.checkout(signedLength)
      try {
        this.signed = await readRoster(snapshot)
      } finally {
        await snapshot.close().catch(() => {})
      }
      this.#seen.signedLength = signedLength
      changed = true
    }
    return changed
  }

}

// Ops someone waits to see signed: a worker starts a job only once its
// claim is (see JobWorker), so the indexers sign one without waiting for
// their ack timer.
function urgent (nodes: ApplyNode[]): boolean {
  return nodes.some((n) => typeof n.value === 'object' && n.value !== null && (n.value as { type?: unknown }).type === 'job.claim')
}

function emptyRoster (): Roster {
  return { title: null, admins: [], members: [], removed: [], invites: [], proposals: [], quorum: { setting: 'majority', k: 1 }, policy: [], clock: 0, rules: 1, seed: { epoch: 0, at: 0, check: '', count: 0, boxes: {} } }
}
