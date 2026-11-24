import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import Corestore from 'corestore'
import { afterEach, describe, expect, it } from 'vitest'
import { waitFor } from './helpers.js'
import { GroupBase, groupNamespace, localWriter, storeDir } from '../src/group/base.js'
import type { GroupKeys } from '../src/group/base.js'
import { RULES, allows, mayPost, readTask, rulesProblem, setSupportedRulesForTesting } from '../src/group/state.js'
import { openSeed, sealSeed, seedCheck } from '../src/group/seed.js'
import { generateKeyPairSync } from 'node:crypto'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function folder (): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pai-group-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function id (): string {
  return randomBytes(32).toString('hex')
}

const stores = new Map<GroupBase, Corestore>()
// Every test folder keeps its group in this slot of its store.
const SLOT = 'test'

function storeAt (storage: string): Corestore {
  const store = new Corestore(storeDir(storage))
  cleanup.push(() => store.close())
  return store
}

// A new group in `storage`, with a made-up identity (`keys.identity`) as
// its admin, acting through `device`.
async function create (storage: string, device: Uint8Array, opts: { name?: string, title?: string, slot?: string } = {}): Promise<GroupKeys & { identity: Uint8Array }> {
  const store = new Corestore(storeDir(storage))
  try {
    const identity = randomBytes(32)
    const keys = await GroupBase.create(store, opts.slot ?? SLOT, { identity, device, ...(opts.name ? { name: opts.name } : {}), ...(opts.title ? { title: opts.title } : {}) })
    return { ...keys, identity }
  } finally {
    await store.close()
  }
}

async function open (storage: string, keys: GroupKeys, slot = SLOT): Promise<GroupBase> {
  const store = storeAt(storage)
  const group = new GroupBase(store, keys, slot)
  await group.ready()
  stores.set(group, store)
  cleanup.push(() => group.close())
  return group
}

// Replicates two bases' stores in memory.
function link (a: GroupBase, b: GroupBase): void {
  const s1 = stores.get(a)!.replicate(true) as any
  const s2 = stores.get(b)!.replicate(false) as any
  s1.pipe(s2).pipe(s1)
  cleanup.push(async () => { s1.destroy(); s2.destroy() })
}

async function until (check: () => boolean, groups: GroupBase[], ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Promise.all(groups.map(async (g) => { await g.base.update(); await g.refresh() }))
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('GroupBase', () => {
  it('repairs a replica whose signed state stops following the indexers\', and says so if it stalls again soon', async () => {
    const dir = await folder()
    const group = await open(dir, await create(dir, Buffer.from(id(), 'hex')))
    // The lengths as Autobase would show them on a replica that doesn't
    // index: it signed 37, its indexers 137.
    const lengths = { mine: 37, theirs: 137 }
    let repairs = 0
    const base = group.base as any
    Object.defineProperty(base, 'isIndexer', { configurable: true, get: () => false })
    Object.defineProperty(base, 'core', { configurable: true, get: () => ({ key: Buffer.alloc(32), signedLength: lengths.mine, core: { state: { length: lengths.theirs } } }) })
    base.isFastForwarding = () => false
    base._runFastForward = async () => { repairs++; lengths.mine = lengths.theirs }
    const stalls: Array<string | null> = []
    group.on('stall', (s: string | null) => { stalls.push(s) })
    const min = 60_000

    let t = 1_000_000_000
    group.checkSigning(t)
    group.checkSigning(t += 59_000)
    expect(repairs).toBe(0) // lagging, but not for a minute yet
    group.checkSigning(t += 2_000)
    expect(repairs).toBe(1) // and caught up by it, quietly
    expect(group.stalled).toBe(null)

    // Another lag long after: repaired, still quietly.
    group.checkSigning(t += 40 * min)
    lengths.theirs = 150
    group.checkSigning(t += 15_000)
    group.checkSigning(t += min)
    expect(repairs).toBe(2)
    expect(group.stalled).toBe(null)

    // Stuck again soon after (moving a little restarts the count, and
    // repairs wait 5 minutes): the builds differ.
    lengths.theirs = 160
    group.checkSigning(t += 15_000)
    lengths.mine = 151
    group.checkSigning(t += 15_000)
    group.checkSigning(t += min)
    expect(repairs).toBe(2)
    group.checkSigning(t += 4 * min)
    expect(repairs).toBe(3)
    expect(group.stalled).toMatch(/copy of the group.*same pai version/)

    // Caught up by the repair, it still says so, until a while passes
    // with no repair.
    group.checkSigning(t += 15_000)
    expect(group.stalled).not.toBe(null)
    group.checkSigning(t += 30 * min)
    expect(group.stalled).toBe(null)
    expect(stalls).toEqual([expect.stringMatching(/same pai version/), null])

    // An indexer never takes this path.
    Object.defineProperty(base, 'isIndexer', { configurable: true, get: () => true })
    lengths.theirs = 200
    for (let i = 0; i < 10; i++) group.checkSigning(t += 10 * min)
    expect(repairs).toBe(3)
  })

  it('creates a group with its creator as the only admin', async () => {
    const dir = await folder()
    const keys = await create(dir, Buffer.from(id(), 'hex'), { name: 'boss', title: 'the team' })
    const admin = hex(keys.identity)
    const group = await open(dir, keys)
    expect(group.roster.admins).toEqual([admin])
    expect(group.roster.members.map((m) => m.name)).toEqual(['boss'])
    expect(group.roster.title).toBe('the team')
    expect(group.admits(admin)).toBe(true)
    expect(group.writable).toBe(true)
  })

  it('keeps groups side by side in one store, each in its slot', async () => {
    const dir = await folder()
    const device = Buffer.from(id(), 'hex')
    const one = await create(dir, device, { slot: 'one', title: 'one' })
    const two = await create(dir, device, { slot: 'two', title: 'two' })
    const store = storeAt(dir)
    const [a, b] = [new GroupBase(store, one, 'one'), new GroupBase(store, two, 'two')]
    cleanup.push(() => a.close(), () => b.close())
    await a.ready()
    await b.ready()
    expect([a.roster.title, b.roster.title]).toEqual(['one', 'two'])
    expect(a.writable && b.writable).toBe(true)
    expect(hex(a.writerKey)).not.toBe(hex(b.writerKey))
    expect(hex(await localWriter(store, groupNamespace('one')))).toBe(hex(a.writerKey))
  })

  it('admits a member once added, on both sides, and drops it when removed', async () => {
    const [aDir, bDir] = [await folder(), await folder()]
    const worker = id()
    const keys = await create(aDir, Buffer.from(id(), 'hex'))
    const admin = hex(keys.identity)
    const a = await open(aDir, keys)
    const b = await open(bDir, keys)
    const writer = await localWriter(stores.get(b)!, groupNamespace(SLOT))
    expect(hex(writer)).toBe(hex(b.writerKey)) // the key an admin adds before it joins
    link(a, b)

    await a.append({ type: 'member.add', id: worker, writer: Buffer.from(writer).toString('hex'), name: 'worker' })
    expect(a.roster.members.map((m) => m.id)).toContain(worker)
    await until(() => a.admits(worker) === true && b.admits(worker) === true && b.admits(admin) === true && b.writable, [a, b])

    await a.append({ type: 'member.remove', id: worker })
    expect(a.admits(worker)).toBe(false) // a removal counts at once
    await until(() => b.admits(worker) === false, [a, b])
    expect(a.roster.removed).toEqual([worker])
  })

  it('ignores admin ops from members, and member ops on admins', async () => {
    const [aDir, bDir] = [await folder(), await folder()]
    const [worker, stranger] = [id(), id()]
    const keys = await create(aDir, Buffer.from(id(), 'hex'))
    const admin = hex(keys.identity)
    const a = await open(aDir, keys)
    const b = await open(bDir, keys)
    link(a, b)
    await a.append({ type: 'member.add', id: worker, writer: Buffer.from(b.writerKey).toString('hex') })
    await until(() => b.writable && b.admits(admin) === true, [a, b])

    await b.append({ type: 'member.add', id: stranger, writer: id() })
    await b.append({ type: 'member.remove', id: admin })
    await until(() => a.roster.members.length === 2 && a.signed.members.length === 2, [a, b])
    await new Promise((resolve) => setTimeout(resolve, 300))
    await a.base.update()
    await a.refresh()
    expect(a.roster.members.map((m) => m.id).sort()).toEqual([admin, worker].sort())
    expect(a.admits(admin)).toBe(true)
  })

  it('lets a member add its own devices\' writers', async () => {
    const [aDir, bDir, cDir] = [await folder(), await folder(), await folder()]
    const worker = id()
    const keys = await create(aDir, Buffer.from(id(), 'hex'))
    const a = await open(aDir, keys)
    const b = await open(bDir, keys)
    const c = await open(cDir, keys) // the worker's second device
    link(a, b)
    link(b, c)
    await a.append({ type: 'member.add', id: worker, writer: hex(b.writerKey) })
    await until(() => b.writable, [a, b, c])
    await b.append({ type: 'writer.add', writer: hex(c.writerKey), device: id() })
    await until(() => c.writable, [a, b, c])
    expect(a.roster.members.find((m) => m.id === worker)?.writers).toEqual([hex(b.writerKey), hex(c.writerKey)])

    // Removing the member takes all its devices' writers out.
    await a.append({ type: 'member.remove', id: worker })
    await until(() => !c.writable, [a, b, c])
  })

  it('keeps each agent\'s tasks its own, and the newer snapshot of one', async () => {
    const [aDir, bDir] = [await folder(), await folder()]
    const worker = id()
    const keys = await create(aDir, Buffer.from(id(), 'hex'))
    const admin = hex(keys.identity)
    const a = await open(aDir, keys)
    const b = await open(bDir, keys)
    link(a, b)
    await a.append({ type: 'member.add', id: worker, writer: hex(b.writerKey) })
    await until(() => b.writable, [a, b])
    const task = (state: string, at: string) => ({ id: 'abcd.1', contextId: 'c', status: { state, timestamp: at } })

    await a.append({ type: 'task.put', task: task('TASK_STATE_WORKING', '2026-01-01T00:00:02Z'), owner: null })
    // The worker writes a task with the same id: its own, not the admin's.
    await b.append({ type: 'task.put', task: task('TASK_STATE_FAILED', '2026-01-01T00:00:09Z'), owner: null })
    // An older snapshot of the admin's doesn't replace the newer one.
    await a.append({ type: 'task.put', task: task('TASK_STATE_SUBMITTED', '2026-01-01T00:00:01Z'), owner: null })
    await until(() => true, [a, b])
    const view = a.base.view as any
    expect((await readTask(view, admin, 'abcd.1'))?.task.status.state).toBe('TASK_STATE_WORKING')
    await until(() => true, [a, b])
    await new Promise((resolve) => setTimeout(resolve, 300))
    await a.base.update()
    expect((await readTask(view, worker, 'abcd.1'))?.task.status.state).toBe('TASK_STATE_FAILED')
  })

  it('stops at a rules version this build can\'t apply, and goes on from there once upgraded', async () => {
    const [aDir, bDir] = [await folder(), await folder()]
    const keys = await create(aDir, Buffer.from(id(), 'hex'))
    const a = await open(aDir, keys)
    let b = await open(bDir, keys)
    link(a, b)
    await a.append({ type: 'member.add', id: id(), writer: hex(b.writerKey) })
    await until(() => b.writable, [a, b])
    expect(b.roster.rules).toBe(RULES)
    const shut = async (g: GroupBase): Promise<void> => { await g.close(); await stores.get(g)?.close() }
    await shut(b)

    // A newer build (a) moves the group on, and writes after it.
    setSupportedRulesForTesting(RULES + 1)
    try {
      await a.append({ type: 'propose', pid: id(), op: { type: 'rules.set', version: RULES + 1 } })
      await a.append({ type: 'policy.set', rule: { name: 'after', from: '*', to: '*', allow: true } })
      expect(a.roster.rules).toBe(RULES + 1)
    } finally {
      setSupportedRulesForTesting(RULES)
    }

    // b, on a build that applies only the current rules, syncs and stops at the version change:
    // nothing after it is read differently.
    b = await open(bDir, keys)
    link(a, b)
    const deadline = Date.now() + 10_000
    while (b.interrupted === null && Date.now() < deadline) {
      await b.base.update().catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(b.interrupted).toBe(`rules:${RULES + 1}`)
    expect(b.roster.rules).toBe(RULES)
    expect(b.roster.policy).toEqual([])
    expect(rulesProblem(b.interrupted)).toMatch(/upgrade pai/)
    await stores.get(b)?.close()

    // Upgraded, it goes on from that op.
    setSupportedRulesForTesting(RULES + 1)
    try {
      b = await open(bDir, keys)
      link(a, b)
      await until(() => b.roster.policy.length === 1, [b])
      expect(b.interrupted).toBeNull()
      expect(b.roster.rules).toBe(RULES + 1)
    } finally {
      setSupportedRulesForTesting(RULES)
    }
  })

  it('keeps a clock from its admins\' ops only, which never goes back', async () => {
    const dir = await folder()
    const keys = await create(dir, Buffer.from(id(), 'hex'))
    const a = await open(dir, keys)
    const start = a.roster.clock
    expect(start).toBeGreaterThan(0)
    await a.base.append({ type: 'clock.tick', at: start + 60_000 })
    await a.base.append({ type: 'clock.tick', at: start + 1 })
    await a.base.update()
    await a.refresh()
    expect(a.roster.clock).toBe(start + 60_000)
  })

  it('keeps roles and call policy; the most specific rule wins, a deny on a tie', async () => {
    const dir = await folder()
    const keys = await create(dir, Buffer.from(id(), 'hex'))
    const admin = hex(keys.identity)
    const a = await open(dir, keys)
    const [w, r] = [id(), id()]
    await a.append({ type: 'member.add', id: w, writer: id(), roles: ['worker'] })
    await a.append({ type: 'member.add', id: r, writer: id() })
    await a.append({ type: 'member.roles', id: r, roles: ['reviewer', 'member'] })
    expect(a.roster.members.find((m) => m.id === r)?.roles).toEqual(['reviewer', 'member'])
    expect(allows(a.roster, w, r)).toBe(true) // no rules

    await a.append({ type: 'policy.set', rule: { name: 'no-workers', from: 'role:worker', to: '*', allow: false } })
    expect(allows(a.roster, w, r)).toBe(false)
    expect(allows(a.roster, r, w)).toBe(true)
    // More specific about the callee: allowed.
    await a.append({ type: 'policy.set', rule: { name: 'to-reviewers', from: 'role:worker', to: 'role:reviewer', allow: true } })
    expect(allows(a.roster, w, r)).toBe(true)
    expect(allows(a.roster, w, admin)).toBe(false)
    // A tie: the deny wins.
    await a.append({ type: 'policy.set', rule: { name: 'tie', from: 'role:worker', to: 'role:reviewer', allow: false } })
    expect(allows(a.roster, w, r)).toBe(false)
    // Naming the caller beats any role rule; admins match role:admin.
    await a.append({ type: 'policy.set', rule: { name: 'w-ok', from: w, to: 'role:admin', allow: true } })
    expect(allows(a.roster, w, admin)).toBe(true)
    await a.append({ type: 'policy.remove', name: 'w-ok' })
    expect(a.roster.policy.map((p) => p.name).sort()).toEqual(['no-workers', 'tie', 'to-reviewers'])
    // Malformed rules and roles are skipped.
    await a.base.append({ type: 'policy.set', rule: { name: 'bad', from: 'role:', to: '*', allow: true }, at: Date.now() })
    await a.base.append({ type: 'member.roles', id: r, roles: ['admin'], at: Date.now() })
    await a.base.update()
    await a.refresh()
    expect(a.roster.policy).toHaveLength(3)
    expect(a.roster.members.find((m) => m.id === r)?.roles).toEqual(['reviewer', 'member'])

    // Posting a job is calling its taker: the same rules, applied by every
    // replica. For a role, the rules naming it (or '*'); for anyone, '*'.
    expect(mayPost(a.roster, w, 'role:reviewer')).toBe(false)
    expect(mayPost(a.roster, w, null)).toBe(false)
    expect(mayPost(a.roster, r, 'role:worker')).toBe(true)
    await a.append({ type: 'policy.set', rule: { name: 'admin-no-reviewers', from: admin, to: 'role:reviewer', allow: false } })
    expect(mayPost(a.roster, admin, 'role:reviewer')).toBe(false)
    expect(mayPost(a.roster, admin, r)).toBe(false) // r is a reviewer
    expect(mayPost(a.roster, admin, null)).toBe(true)
    expect(mayPost(a.roster, w, w)).toBe(true) // its own devices
    const jid = (): string => { const b = randomBytes(16); b[0]! &= 0x7f; return b.toString('hex') }
    const [refused, fine] = [jid(), jid()]
    const post = async (id: string, to: string | null): Promise<void> => {
      await a.base.append({ type: 'job.post', job: { id, spec: { text: 'x' }, to, lease: null }, at: Date.now() })
    }
    await post(refused, 'role:reviewer')
    await post(fine, null)
    const [flow, okFlow] = [jid(), jid()]
    await a.base.append({ type: 'flow.start', flow: { id: okFlow, input: '', steps: [{ name: 'a', to: null, text: 'x' }] }, at: Date.now() })
    await a.base.append({ type: 'flow.start', flow: { id: flow, input: '', steps: [{ name: 'a', to: null, text: 'x' }, { name: 'b', to: r, text: 'y', after: ['a'] }] }, at: Date.now() })
    await a.base.update()
    await a.refresh()
    expect(await a.job(refused, false)).toBeNull()
    expect(await a.job(fine, false)).not.toBeNull()
    expect(await a.flow(flow)).toBeNull()
    expect(await a.flow(okFlow)).not.toBeNull()
  })

  it('rotates the seed with k of n admins; members seal it only to their own devices', async () => {
    const [aDir, bDir] = [await folder(), await folder()]
    const device = (): { publicKey: Buffer, secretKey: Buffer } => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
      const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
      return { publicKey: pub, secretKey: Buffer.concat([seed, pub]) }
    }
    const [devA, devB, devX] = [device(), device(), device()]
    const keys = await create(aDir, devA.publicKey)
    const a = await open(aDir, keys)
    const b = await open(bDir, keys)
    link(a, b)
    const worker = id()
    await a.append({ type: 'member.add', id: worker, writer: hex(b.writerKey), device: hex(devB.publicKey) })
    await until(() => b.writable, [a, b])

    const seed = randomBytes(32)
    const check = seedCheck(seed)
    const box = sealSeed(seed, devA.publicKey)
    expect(openSeed(box, devA)?.equals(seed)).toBe(true)
    expect(openSeed(box, devB)).toBeNull()

    // Shares before any rotation, or for the wrong epoch, are skipped.
    await b.append({ type: 'seed.share', epoch: 1, device: hex(devB.publicKey), box: sealSeed(seed, devB.publicKey), check })
    expect(b.roster.seed.epoch).toBe(0)
    await a.append({ type: 'propose', pid: id(), op: { type: 'seed.rotate', epoch: 2, boxes: { [hex(devA.publicKey)]: box }, check } })
    expect(a.roster.seed.epoch).toBe(0) // not the next epoch
    // Boxes go only to members' devices on record.
    await a.append({ type: 'propose', pid: id(), op: { type: 'seed.rotate', epoch: 1, boxes: { [hex(devA.publicKey)]: box, [hex(devX.publicKey)]: sealSeed(seed, devX.publicKey) }, check } })
    expect(a.roster.seed).toMatchObject({ epoch: 1, check, count: 1, boxes: { [hex(devA.publicKey)]: box } })
    await until(() => b.roster.seed.epoch === 1, [a, b])

    // The member seals it to its own device, not to others; nothing is
    // sealed over.
    await b.append({ type: 'seed.share', epoch: 1, device: hex(devX.publicKey), box: sealSeed(seed, devX.publicKey), check })
    await b.append({ type: 'seed.share', epoch: 1, device: hex(devA.publicKey), box: sealSeed(seed, devA.publicKey), check })
    // Another seed (one from a rotation that lost, say) isn't shared.
    const other = randomBytes(32)
    await b.append({ type: 'seed.share', epoch: 1, device: hex(devB.publicKey), box: sealSeed(other, devB.publicKey), check: seedCheck(other) })
    expect(b.roster.seed.boxes[hex(devB.publicKey)]).toBeUndefined()
    await b.append({ type: 'seed.share', epoch: 1, device: hex(devB.publicKey), box: sealSeed(seed, devB.publicKey), check })
    await until(() => a.roster.seed.boxes[hex(devB.publicKey)] !== undefined, [a, b])
    expect(Object.keys(a.roster.seed.boxes).sort()).toEqual([hex(devA.publicKey), hex(devB.publicKey)].sort())
    expect(a.roster.seed.boxes[hex(devA.publicKey)]).toBe(box)
    expect(openSeed(a.roster.seed.boxes[hex(devB.publicKey)]!, devB)?.equals(seed)).toBe(true)
  })

  it('needs a majority of admins to add an admin, and a lapsed member is not admitted', async () => {
    const [aDir, bDir, cDir] = [await folder(), await folder(), await folder()]
    const [two, three] = [id(), id()]
    const keys = await create(aDir, Buffer.from(id(), 'hex'))
    const one = hex(keys.identity)
    const a = await open(aDir, keys)
    const b = await open(bDir, keys)
    const c = await open(cDir, keys)
    link(a, b)
    link(a, c)
    await a.append({ type: 'member.add', id: two, writer: hex(b.writerKey) })
    await a.append({ type: 'member.add', id: three, writer: hex(c.writerKey), until: Date.now() - 1 })
    expect(a.admits(three)).toBe(false) // already lapsed

    // 1 admin: majority is 1, so the proposal passes at once.
    await a.append({ type: 'propose', pid: id(), op: { type: 'admin.add', id: two } })
    expect(a.roster.admins.sort()).toEqual([one, two].sort())
    await until(() => b.isAdmin(two), [a, b, c])

    // 2 admins: majority is 2, so one admin's proposal waits for the other.
    const pid = id()
    await a.append({ type: 'member.renew', id: three, until: null })
    await a.append({ type: 'propose', pid, op: { type: 'admin.add', id: three } })
    expect(a.isAdmin(three)).toBe(false)
    expect(a.roster.proposals.map((p) => p.pid)).toEqual([pid])
    await until(() => b.roster.proposals.length === 1 && b.writable, [a, b, c])
    await b.append({ type: 'approve', pid })
    await until(() => a.isAdmin(three) && a.roster.proposals.length === 0, [a, b, c])
  })
})

function hex (b: Uint8Array): string {
  return Buffer.from(b).toString('hex')
}
