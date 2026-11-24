import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_ENDED_JOBS, MAX_LAPSES, RESULT_CUT_NOTE, applyJobOp, canClaim, jobMessage, parseJobOp, sweepJobs } from '../src/group/jobs.js'
import type { JobRecord } from '../src/group/jobs.js'
import type { GroupMembership } from '../src/group/membership.js'
import { GroupIdentity, createGroup, createIdentity } from '../src/identity/group.js'
import { JobWorker } from '../src/jobs/worker.js'
import { loadKeyPair } from '../src/store/key-file.js'
import { joinGroup } from '../src/identity/group.js'
import type { Pai } from '../src/pai.js'
import type { Message } from '../src/a2a/types.js'
import type { TaskHandle } from '../src/server.js'
import { agentText, firstText, useTestnet, waitFor } from './helpers.js'

// A member's job id: the top bit clear (set is the rules' own).
const jobId = (): string => { const b = randomBytes(16); b[0]! &= 0x7f; return b.toString('hex') }
const id = (): string => randomBytes(32).toString('hex')

function job (over: Partial<JobRecord> = {}): JobRecord {
  return { id: jobId(), by: id(), spec: { text: 'x' }, to: null, lease: null, state: 'open', claim: null, result: null, ref: null, at: 0, updated: 0, ...over }
}

describe('job rules', () => {
  it('lets the right members claim: anyone, by role, by id; again only after a lease', () => {
    const me = id()
    expect(canClaim(job(), me, [], 0)).toBe(true)
    expect(canClaim(job({ to: 'role:writer' }), me, ['member'], 0)).toBe(false)
    expect(canClaim(job({ to: 'role:writer' }), me, ['writer'], 0)).toBe(true)
    expect(canClaim(job({ to: me }), me, [], 0)).toBe(true)
    expect(canClaim(job({ to: id() }), me, [], 0)).toBe(false)
    const claimed = { state: 'claimed' as const, claim: { by: id(), writer: id(), at: 1000 } }
    expect(canClaim(job(claimed), me, [], 5000)).toBe(false)
    expect(canClaim(job({ ...claimed, lease: 1000 }), me, [], 1500)).toBe(false)
    expect(canClaim(job({ ...claimed, lease: 1000 }), me, [], 2001)).toBe(true)
    expect(canClaim(job({ state: 'done' }), me, [], 0)).toBe(false)
  })

  it('checks job ops\' shapes', () => {
    const post = (j: object) => parseJobOp({ type: 'job.post', job: { id: jobId(), spec: { text: 'hi' }, to: null, lease: null, ...j } })
    expect(post({})).not.toBeNull()
    expect(post({ to: 'role:writer' })).not.toBeNull()
    // The cap is in bytes: 6000 three-byte characters are 18000 bytes.
    expect(post({ spec: { text: '€'.repeat(5000) } })).not.toBeNull()
    expect(post({ spec: { text: '€'.repeat(6000) } })).toBeNull()
    expect(post({ to: 'writer' })).toBeNull()
    expect(post({ lease: -1 })).toBeNull()
    expect(post({ lease: 4999 })).toBeNull()
    expect(post({ lease: 5000 })).not.toBeNull()
    expect(post({ spec: { text: 'x'.repeat(17 * 1024) } })).toBeNull()
    expect(post({ id: 'nope' })).toBeNull()
    expect(post({ id: '8' + jobId().slice(1) })).toBeNull() // a workflow's (the rules') own
    expect(parseJobOp({ type: 'job.done', id: jobId(), state: 'done', result: 'x'.repeat(16 * 1024 + 1), ref: null })).toBeNull()
    expect(parseJobOp({ type: 'job.done', id: jobId(), state: 'finished', result: null, ref: null })).toBeNull()
    expect(parseJobOp({ type: 'job.done', id: jobId(), state: 'failed', result: 'oops', ref: 'task-1' })).not.toBeNull()
    // Attachments and a context.
    expect(post({ spec: { text: 'hi', attach: [jobId()], context: 'review-1' } })).not.toBeNull()
    expect(post({ spec: { text: 'hi', attach: [] } })).toBeNull()
    expect(post({ spec: { text: 'hi', attach: ['nope'] } })).toBeNull()
    const twice = jobId()
    expect(post({ spec: { text: 'hi', attach: [twice, twice] } })).toBeNull()
    expect(post({ spec: { text: 'hi', attach: Array.from({ length: 9 }, jobId) } })).toBeNull()
    expect(post({ spec: { text: 'hi', context: 'has space' } })).toBeNull()
    expect(post({ spec: { text: 'hi', context: 'x'.repeat(65) } })).toBeNull()
  })

  it('tells another attempt why the last was lost, and runs in the poster\'s named context', () => {
    const first = jobMessage(job({ spec: { text: 'do it' }, attempt: 1 }))
    expect(first.parts).toEqual([{ text: 'do it' }])
    expect(first.contextId).toBeUndefined()
    const by = id()
    const again = jobMessage(job({ by, spec: { text: 'do it', context: 'c1' }, attempt: 2, retries: 3, lastError: 'timed out after 5 s', claim: { by: id(), writer: id(), at: 7 } }))
    expect(again.parts[1]).toMatchObject({ text: '(This is attempt 2 of 4. The last attempt was lost: timed out after 5 s)' })
    expect(again.metadata).toMatchObject({ 'pai/attempt': 2, 'pai/last-error': 'timed out after 5 s' })
    expect(again.contextId).toBe(`${by}:c1`)
    expect(again.messageId).toMatch(/-7$/)
  })
})

describe('job pruning and leases', () => {
  // A view in memory, as apply sees it.
  function memView () {
    const map = new Map<string, unknown>()
    return {
      map,
      get: async (k: string) => map.has(k) ? { value: map.get(k) } : null,
      put: async (k: string, v: unknown) => { map.set(k, v) },
      del: async (k: string) => { map.delete(k) },
      createReadStream: async function * ({ gt, lt }: { gt: string, lt: string }) {
        for (const k of [...map.keys()].sort()) if (k > gt && k < lt) yield { key: k, value: map.get(k) }
      }
    }
  }

  it('indexes active jobs, bounds renewals, and prunes the jobs that ended first', async () => {
    const view = memView()
    const [poster, worker] = [id(), id()]
    const writer = id()
    const member = { roles: ['member'], until: null }
    const j = jobId()
    await applyJobOp({ type: 'job.post', job: { id: j, spec: { text: 'x' }, to: null, lease: 5000 }, at: 0 }, poster, id(), view, member, false)
    expect(view.map.has(`jobs/open/${j}`)).toBe(true)
    await applyJobOp({ type: 'job.claim', id: j, at: 10 }, worker, writer, view, member, false)
    expect([view.map.has(`jobs/open/${j}`), view.map.has(`jobs/claimed/${j}`)]).toEqual([false, true])
    // Renewed at 4000: a claim at 8000 is too early. Renewals from another
    // device, or too far ahead, don't count.
    await applyJobOp({ type: 'job.renew', id: j, at: 4000 }, worker, writer, view, member, false)
    await applyJobOp({ type: 'job.renew', id: j, at: 4500 }, worker, id(), view, member, false)
    await applyJobOp({ type: 'job.renew', id: j, at: 4000 + 10_001 }, worker, writer, view, member, false)
    expect((view.map.get(`job/${j}`) as JobRecord).claim?.renewed).toBe(4000)
    // Leases run out by the group's clock (its admins' latest time), not
    // by the time a claim says it was made.
    const noop = async (): Promise<void> => {}
    await applyJobOp({ type: 'job.claim', id: j, at: 8000 }, id(), id(), view, member, false, noop, 8000)
    expect((view.map.get(`job/${j}`) as JobRecord).claim?.by).toBe(worker)
    await applyJobOp({ type: 'job.claim', id: j, at: 9e15 }, id(), id(), view, member, false, noop, 8500)
    expect((view.map.get(`job/${j}`) as JobRecord).claim?.by).toBe(worker)
    // A member whose membership lapsed by the group's clock can't backdate
    // its way in.
    await applyJobOp({ type: 'job.claim', id: j, at: 1 }, id(), id(), view, { roles: [], until: 9000 }, false, noop, 9500)
    expect((view.map.get(`job/${j}`) as JobRecord).claim?.by).toBe(worker)
    await applyJobOp({ type: 'job.done', id: j, state: 'done', result: 'ok', ref: null, at: 8500 }, worker, writer, view, member, false)

    // Once the group's clock is past the lease, a renewal is too late, and
    // another member may claim.
    const k = jobId()
    await applyJobOp({ type: 'job.post', job: { id: k, spec: { text: 'k' }, to: null, lease: 5000 }, at: 0 }, poster, id(), view, member, false)
    await applyJobOp({ type: 'job.claim', id: k, at: 100 }, worker, writer, view, member, false, noop, 100)
    await applyJobOp({ type: 'job.renew', id: k, at: 5200 }, worker, writer, view, member, false, noop, 5101)
    expect((view.map.get(`job/${k}`) as JobRecord).claim?.renewed).toBeUndefined()
    const other = id()
    await applyJobOp({ type: 'job.claim', id: k, at: 50 }, other, id(), view, member, false, noop, 5101)
    expect((view.map.get(`job/${k}`) as JobRecord).claim?.by).toBe(other)
    // A device behind the group's clock claims as of the group's clock.
    expect((view.map.get(`job/${k}`) as JobRecord).claim).toMatchObject({ at: 50, start: 5101 })
    await applyJobOp({ type: 'job.cancel', id: k, at: 5200 }, poster, id(), view, member, false)

    // A claim dated far ahead holds its job no longer than a lease past the
    // group's clock.
    const far = jobId()
    await applyJobOp({ type: 'job.post', job: { id: far, spec: { text: 'f' }, to: null, lease: 5000 }, at: 0 }, poster, id(), view, member, false, noop, 1000)
    await applyJobOp({ type: 'job.claim', id: far, at: 9e15 }, worker, writer, view, member, false, noop, 1000)
    expect((view.map.get(`job/${far}`) as JobRecord).claim).toMatchObject({ at: 9e15, start: 6000 })
    await applyJobOp({ type: 'job.claim', id: far, at: 11_001 }, other, id(), view, member, false, noop, 11_001)
    expect((view.map.get(`job/${far}`) as JobRecord).claim?.by).toBe(other)
    await applyJobOp({ type: 'job.cancel', id: far, at: 11_002 }, poster, id(), view, member, false)
    expect(view.map.has(`jobs/claimed/${j}`)).toBe(false)

    // Past MAX_ENDED_JOBS ended jobs, the first to end go, whatever the
    // times their ops claim (a far-future time prunes nothing early).
    await applyJobOp({ type: 'job.post', job: { id: jobId(), spec: { text: 'y' }, to: null, lease: null }, at: 9e15 }, poster, id(), view, member, false)
    expect(view.map.has(`job/${j}`)).toBe(true)
    for (let i = 0; i < MAX_ENDED_JOBS; i++) {
      const k = jobId()
      await applyJobOp({ type: 'job.post', job: { id: k, spec: { text: 'z' }, to: null, lease: null }, at: i }, poster, id(), view, member, false)
      await applyJobOp({ type: 'job.cancel', id: k, at: i }, poster, id(), view, member, false)
    }
    await applyJobOp({ type: 'job.post', job: { id: jobId(), spec: { text: 'w' }, to: null, lease: null }, at: 0 }, poster, id(), view, member, false)
    expect(view.map.has(`job/${j}`)).toBe(false)
    expect([...view.map.values()].includes(j)).toBe(false)
    expect((view.map.get('jobs-ended') as { count: number }).count).toBe(MAX_ENDED_JOBS)
  })
})

describe('limits', () => {
  function memView () {
    const map = new Map<string, unknown>()
    return {
      map,
      get: async (k: string) => map.has(k) ? { value: map.get(k) } : null,
      put: async (k: string, v: unknown) => { map.set(k, v) },
      del: async (k: string) => { map.delete(k) },
      createReadStream: async function * ({ gt, lt }: { gt: string, lt: string }) {
        for (const k of [...map.keys()].sort()) if (k > gt && k < lt) yield { key: k, value: map.get(k) }
      }
    }
  }
  const member = { roles: ['member'], until: null }
  const noop = async (): Promise<void> => {}

  it('tries a failed job again after a doubling backoff, until its retries run out', async () => {
    const view = memView()
    const [poster, worker, writer] = [id(), id(), id()]
    const j = jobId()
    const job = (): JobRecord => view.map.get(`job/${j}`) as JobRecord
    await applyJobOp({ type: 'job.post', job: { id: j, spec: { text: 'x' }, to: null, lease: null, retries: 2, backoff: 1000 }, at: 0 }, poster, id(), view, member, false, noop, 0)
    const attempt = async (clock: number): Promise<void> => {
      await applyJobOp({ type: 'job.claim', id: j, at: clock }, worker, writer, view, member, false, noop, clock)
      await applyJobOp({ type: 'job.done', id: j, state: 'failed', result: `boom ${clock}`, ref: null, at: clock }, worker, writer, view, member, false, noop, clock)
    }
    await attempt(10)
    expect(job()).toMatchObject({ state: 'open', attempt: 1, notBefore: 1010, lastError: 'boom 10' })
    // Not before the wait is over.
    await applyJobOp({ type: 'job.claim', id: j, at: 500 }, worker, writer, view, member, false, noop, 500)
    expect(job().state).toBe('open')
    await attempt(1010)
    expect(job()).toMatchObject({ state: 'open', attempt: 2, notBefore: 3010 })
    await attempt(3010)
    expect(job()).toMatchObject({ state: 'failed', attempt: 3, result: 'boom 3010' })

    // Giving a job back doesn't use up an attempt; a report from a device
    // other than the claim's doesn't count.
    const k = jobId()
    const kj = (): JobRecord => view.map.get(`job/${k}`) as JobRecord
    await applyJobOp({ type: 'job.post', job: { id: k, spec: { text: 'k' }, to: null, lease: null, retries: 0 }, at: 0 }, poster, id(), view, member, false, noop, 5000)
    await applyJobOp({ type: 'job.claim', id: k, at: 5000 }, worker, writer, view, member, false, noop, 5000)
    await applyJobOp({ type: 'job.release', id: k, at: 5001 }, worker, writer, view, member, false, noop, 5001)
    expect(kj()).toMatchObject({ state: 'open', attempt: 0 })
    await applyJobOp({ type: 'job.claim', id: k, at: 5002 }, worker, writer, view, member, false, noop, 5002)
    await applyJobOp({ type: 'job.done', id: k, state: 'done', result: 'stale', ref: null, at: 5003 }, worker, id(), view, member, false, noop, 5003)
    expect(kj().state).toBe('claimed')
    await applyJobOp({ type: 'job.done', id: k, state: 'done', result: 'ok', ref: null, at: 5004 }, worker, writer, view, member, false, noop, 5004)
    expect(kj()).toMatchObject({ state: 'done', attempt: 1, result: 'ok' })
  })

  it('loses an attempt past its timeout, fails a job past its deadline, and counts lapsed leases', async () => {
    const view = memView()
    const [poster, worker, writer] = [id(), id(), id()]
    const ended: string[] = []
    const sweep = async (clock: number): Promise<void> => { await sweepJobs(view, clock, async (jb) => { ended.push(jb.id) }) }
    // A timeout with no retries: the job fails.
    const t = jobId()
    await applyJobOp({ type: 'job.post', job: { id: t, spec: { text: 't' }, to: null, lease: null, timeout: 5000 }, at: 0 }, poster, id(), view, member, false, noop, 0)
    await applyJobOp({ type: 'job.claim', id: t, at: 100 }, worker, writer, view, member, false, noop, 100)
    await sweep(5100)
    expect((view.map.get(`job/${t}`) as JobRecord).state).toBe('claimed')
    await sweep(5101)
    expect(view.map.get(`job/${t}`)).toMatchObject({ state: 'failed', result: 'timed out after 5 s' })
    // With a retry: open again.
    const r = jobId()
    await applyJobOp({ type: 'job.post', job: { id: r, spec: { text: 'r' }, to: null, lease: null, timeout: 5000, retries: 1 }, at: 0 }, poster, id(), view, member, false, noop, 6000)
    await applyJobOp({ type: 'job.claim', id: r, at: 6000 }, worker, writer, view, member, false, noop, 6000)
    await sweep(11_001)
    expect(view.map.get(`job/${r}`)).toMatchObject({ state: 'open', lastError: 'timed out after 5 s' })
    // A deadline: the job fails whatever its state.
    const d = jobId()
    await applyJobOp({ type: 'job.post', job: { id: d, spec: { text: 'd' }, to: null, lease: null, deadline: 2000 }, at: 20_000 }, poster, id(), view, member, false, noop, 20_000)
    await sweep(22_001)
    expect(view.map.get(`job/${d}`)).toMatchObject({ state: 'failed' })
    expect((view.map.get(`job/${d}`) as JobRecord).result).toMatch(/missed its deadline/)
    expect(ended).toEqual([t, d])
    // A lapsed lease with no retries left: taking it over fails the job.
    const l = jobId()
    await applyJobOp({ type: 'job.post', job: { id: l, spec: { text: 'l' }, to: null, lease: 5000, retries: 0 }, at: 30_000 }, poster, id(), view, member, false, noop, 30_000)
    await applyJobOp({ type: 'job.claim', id: l, at: 30_000 }, worker, writer, view, member, false, noop, 30_000)
    await applyJobOp({ type: 'job.claim', id: l, at: 36_000 }, id(), id(), view, member, false, noop, 36_000)
    expect(view.map.get(`job/${l}`)).toMatchObject({ state: 'failed' })
    // With retries left, the next attempt is told why the last was lost.
    const m = jobId()
    await applyJobOp({ type: 'job.post', job: { id: m, spec: { text: 'm' }, to: null, lease: 5000, retries: 1 }, at: 40_000 }, poster, id(), view, member, false, noop, 40_000)
    await applyJobOp({ type: 'job.claim', id: m, at: 40_000 }, worker, writer, view, member, false, noop, 40_000)
    await applyJobOp({ type: 'job.claim', id: m, at: 46_000 }, id(), id(), view, member, false, noop, 46_000)
    expect(view.map.get(`job/${m}`)).toMatchObject({ state: 'claimed', attempt: 2, lastError: 'the worker stopped renewing its lease' })
    // Without retries, lapses are taken over up to MAX_LAPSES claims; the
    // next takeover fails the job.
    const p = jobId()
    await applyJobOp({ type: 'job.post', job: { id: p, spec: { text: 'p' }, to: null, lease: 5000 }, at: 50_000 }, poster, id(), view, member, false, noop, 50_000)
    for (let i = 0; i <= MAX_LAPSES; i++) {
      const at = 50_000 + i * 6000
      await applyJobOp({ type: 'job.claim', id: p, at }, id(), id(), view, member, false, noop, at)
      if (i < MAX_LAPSES) expect(view.map.get(`job/${p}`)).toMatchObject({ state: 'claimed', attempt: i + 1 })
    }
    expect(view.map.get(`job/${p}`)).toMatchObject({ state: 'failed', attempt: MAX_LAPSES, result: `gave up after ${MAX_LAPSES} attempt(s): the worker stopped renewing its lease` })
    // Limits are checked.
    const post = (j: object) => parseJobOp({ type: 'job.post', job: { id: jobId(), spec: { text: 'hi' }, to: null, lease: null, ...j } })
    expect(post({ timeout: 1000 })).toBeNull()
    expect(post({ retries: 21 })).toBeNull()
    expect(post({ deadline: 60_000, retries: 3, backoff: 2000, timeout: 10_000 })).not.toBeNull()
  })
})

describe('questions', () => {
  it('lets the claiming device ask, in turn, and the poster or an admin answer, once', async () => {
    const map = new Map<string, unknown>()
    const view = {
      get: async (k: string) => map.has(k) ? { value: map.get(k) } : null,
      put: async (k: string, v: unknown) => { map.set(k, v) },
      del: async (k: string) => { map.delete(k) },
      createReadStream: async function * () {}
    }
    const [poster, worker, writer, stranger] = [id(), id(), id(), id()]
    const member = { roles: ['member'], until: null }
    const j = jobId()
    const job = (): JobRecord => map.get(`job/${j}`) as JobRecord
    await applyJobOp({ type: 'job.post', job: { id: j, spec: { text: 'paint' }, to: null, lease: null }, at: 0 }, poster, id(), view, member, false)
    // Not while open, and only the claiming device.
    await applyJobOp({ type: 'job.ask', id: j, n: 1, text: 'color?', at: 1 }, worker, writer, view, member, false)
    expect(job().question ?? null).toBeNull()
    await applyJobOp({ type: 'job.claim', id: j, at: 1 }, worker, writer, view, member, false)
    await applyJobOp({ type: 'job.ask', id: j, n: 1, text: 'color?', at: 1 }, worker, id(), view, member, false)
    expect(job().question).toBeNull()
    await applyJobOp({ type: 'job.ask', id: j, n: 2, text: 'skip?', at: 1 }, worker, writer, view, member, false)
    await applyJobOp({ type: 'job.ask', id: j, n: 1, text: 'color?', at: 1 }, worker, writer, view, member, false)
    expect(job().question).toMatchObject({ n: 1, text: 'color?', answer: null })
    // No second question before the first is answered.
    await applyJobOp({ type: 'job.ask', id: j, n: 2, text: 'size?', at: 1 }, worker, writer, view, member, false)
    expect(job().question?.n).toBe(1)
    // Someone else can't answer; the poster can, once.
    await applyJobOp({ type: 'job.answer', id: j, n: 1, text: 'red', at: 1 }, stranger, id(), view, member, false)
    expect(job().question?.answer).toBeNull()
    await applyJobOp({ type: 'job.answer', id: j, n: 1, text: 'blue', at: 1 }, poster, id(), view, member, false)
    await applyJobOp({ type: 'job.answer', id: j, n: 1, text: 'green', at: 1 }, poster, id(), view, member, false)
    expect(job().question).toMatchObject({ answer: 'blue', by: poster })
    await applyJobOp({ type: 'job.ask', id: j, n: 2, text: 'size?', at: 1 }, worker, writer, view, member, false)
    await applyJobOp({ type: 'job.answer', id: j, n: 2, text: 'big', at: 1 }, stranger, id(), view, member, true) // an admin
    expect(job().question).toMatchObject({ n: 2, answer: 'big', by: stranger })
    // A new claim starts over.
    await applyJobOp({ type: 'job.release', id: j, at: 2 }, worker, writer, view, member, false)
    expect(job().question).toBeNull()
  })
})

describe('job board', () => {
  const { agent, tempdir, bootstrap } = useTestnet()

  // `identity`: the agent's one group (the job board's API is the group's).
  async function admin (handler?: (m: Message) => Promise<Message>): Promise<{ pai: Pai, identity: GroupMembership }> {
    const storage = await tempdir('admin')
    const keyPair = await loadKeyPair(storage)
    const keys = await createIdentity({ storage, keyPair, name: 'admin' })
    const entry = await createGroup({ storage, keys, keyPair, name: 'team', member: 'admin' })
    const identity = new GroupIdentity({ storage, keys, groups: [entry] })
    const pai = await agent('admin', { storage, identity, ...(handler ? { handler } : {}) })
    return { pai, identity: identity.group() }
  }

  async function joiner (boss: GroupMembership, name: string, roles: string[], handler: (m: Message, task: TaskHandle) => Promise<Message | void>): Promise<{ pai: Pai, identity: GroupMembership }> {
    const { code } = await boss.invite({ roles })
    const storage = await tempdir(name)
    const keyPair = await loadKeyPair(storage)
    const keys = await createIdentity({ storage, keyPair, name })
    const entry = await joinGroup({ storage, keyPair, keys, code, name, bootstrap: bootstrap(), timeout: 20_000 })
    const identity = new GroupIdentity({ storage, keys, groups: [entry] })
    const pai = await agent(name, { storage, identity, handler })
    return { pai, identity: identity.group() }
  }

  it('posts a job for a role; one worker with it claims, runs and reports it', async () => {
    const boss = await admin()
    // Streams its answer in chunks, which the result joins as they came.
    const upper = async (m: Message, task: TaskHandle): Promise<void> => {
      await task.update('TASK_STATE_WORKING')
      let append = false
      for (const chunk of (firstText(m) ?? '').toUpperCase().match(/.{1,3}/g) ?? []) {
        await task.artifact({ artifactId: 'out', parts: [{ text: chunk }] }, { append })
        append = true
      }
      await task.update('TASK_STATE_COMPLETED')
    }
    const writer = await joiner(boss.identity, 'writer', ['writer'], upper)
    const critic = await joiner(boss.identity, 'critic', ['critic'], async () => agentText('should not run'))
    await waitFor(() => writer.identity.base.writable && critic.identity.base.writable, 20_000)
    const workers = [new JobWorker(writer.pai, writer.identity), new JobWorker(critic.pai, critic.identity)]
    for (const w of workers) w.start()
    try {
      const posted = await boss.identity.postJob({ text: 'draft this' }, { to: 'role:writer' })
      expect(posted.state).toBe('open')
      const done = await boss.identity.waitJob(posted.id, { timeout: 30_000 })
      expect(done).toMatchObject({ state: 'done', result: 'DRAFT THIS', claim: { by: writer.identity.self } })
      // The task ran as the poster's: it can read it like its own.
      const task = await boss.pai.getTaskOf(Buffer.from(writer.identity.self, 'hex'), done!.ref!)
      expect(task.status.state).toBe('TASK_STATE_COMPLETED')

      // Canceling: only the poster or an admin, and only while it's open
      // or claimed.
      const nobody = await critic.identity.postJob({ text: 'for nobody' }, { to: 'role:editor' })
      await waitFor(async () => (await boss.identity.getJob(nobody.id)) !== null, 20_000)
      await expect(writer.identity.cancelJob(nobody.id)).rejects.toThrow(/poster or an admin/)
      expect((await boss.identity.cancelJob(nobody.id)).state).toBe('canceled')
      await expect(boss.identity.cancelJob(done!.id)).rejects.toThrow(/already/)
    } finally {
      for (const w of workers) await w.close()
    }
  }, 90_000)

  it('signs a claim well before the ack timer', async () => {
    const boss = await admin()
    const writer = await joiner(boss.identity, 'writer', ['writer'], async () => agentText('unused'))
    await waitFor(() => writer.identity.base.writable, 20_000)
    // The timer acks after 1 to 2 s; a claim gets one within a few tens of ms.
    for (let i = 0; i < 3; i++) {
      const posted = await boss.identity.postJob({ text: `job ${i}` }, { to: 'role:writer' })
      await waitFor(async () => (await writer.identity.getJob(posted.id)) !== null, 20_000)
      const t0 = Date.now()
      await writer.identity.claimJob(posted.id)
      await waitFor(async () => (await writer.identity.getJob(posted.id, { signed: true }))?.claim?.by === writer.identity.self, 5000)
      expect(Date.now() - t0).toBeLessThan(700)
    }
  }, 60_000)

  it('respects policy, hands a job over when its lease runs out, and gives jobs back on close', async () => {
    const boss = await admin()
    let release: () => void = () => {}
    const stuck = new Promise<void>((resolve) => { release = resolve })
    const slow = async (m: Message): Promise<Message> => { await stuck; return agentText(`slow: ${firstText(m) ?? ''}`) }
    const fast = async (m: Message): Promise<Message> => agentText(`fast: ${firstText(m) ?? ''}`)
    const a = await joiner(boss.identity, 'a', ['writer'], slow)
    const b = await joiner(boss.identity, 'b', ['writer'], fast)
    const c = await joiner(boss.identity, 'c', ['writer'], fast) // runs no worker
    await waitFor(() => a.identity.base.writable && b.identity.base.writable && c.identity.base.writable, 20_000)

    // Policy: nobody may call the writers, so their workers take nothing.
    await boss.identity.act({ type: 'policy.set', rule: { name: 'quiet', from: '*', to: 'role:writer', allow: false } })
    const wa = new JobWorker(a.pai, a.identity)
    wa.start()
    // Nor may anyone post jobs for them; a job for anyone they don't take.
    await expect(boss.identity.postJob({ text: 'refused' }, { to: 'role:writer' })).rejects.toThrow(/policy doesn't let you post jobs for role:writer/)
    const blocked = await boss.identity.postJob({ text: 'blocked' })
    await waitFor(() => a.identity.base.roster.policy.length === 1 && a.identity.base.roster.members.length === 4, 20_000)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await boss.identity.getJob(blocked.id))?.state).toBe('open')
    await boss.identity.cancelJob(blocked.id)
    await boss.identity.act({ type: 'policy.remove', name: 'quiet' })

    // A's worker takes a leased job and is still at it: it renews the
    // lease, so B can't take the job over.
    const kept = await boss.identity.postJob({ text: 'kept' }, { to: 'role:writer', lease: 5000 })
    await waitFor(async () => (await boss.identity.getJob(kept.id))?.claim?.by === a.identity.self, 20_000)
    const wb = new JobWorker(b.pai, b.identity)
    wb.start()
    await new Promise((resolve) => setTimeout(resolve, 9000))
    expect((await boss.identity.getJob(kept.id))?.claim?.by).toBe(a.identity.self)
    await boss.identity.cancelJob(kept.id)

    // A claimant that went quiet (C, which runs no worker, claims by hand
    // and never renews): B takes the job over when the lease runs out, with
    // no other change. A is busy with its own.
    await wb.close()
    const busy = await boss.identity.postJob({ text: 'busy' }, { to: a.identity.self })
    await waitFor(async () => (await boss.identity.getJob(busy.id))?.state === 'claimed', 20_000)
    const leased = await boss.identity.postJob({ text: 'leased' }, { to: 'role:writer', lease: 5000 })
    await waitFor(async () => (await c.identity.getJob(leased.id)) !== null, 20_000)
    await c.identity.claimJob(leased.id)
    await waitFor(async () => (await boss.identity.getJob(leased.id))?.state === 'claimed', 20_000)
    const wb2 = new JobWorker(b.pai, b.identity)
    wb2.start()
    const done = await boss.identity.waitJob(leased.id, { timeout: 30_000 })
    expect(done).toMatchObject({ state: 'done', result: 'fast: leased', claim: { by: b.identity.self } })
    await wb2.close()

    // A closes while it holds a job: the job goes back to the board.
    await wa.close()
    release()
    await waitFor(async () => (await boss.identity.getJob(busy.id))?.state === 'open', 20_000)
  }, 90_000)

  it('asks the poster when a run needs input, and takes other jobs meanwhile', async () => {
    const boss = await admin()
    // Asks which color, then paints with the answer; 'quick' needs nothing.
    const painter = async (m: Message, task: TaskHandle): Promise<void> => {
      await task.update('TASK_STATE_WORKING')
      if (firstText(m) === 'quick') return void await task.update('TASK_STATE_COMPLETED', agentText('quick done'))
      if ((task.task.history?.length ?? 0) <= 1) return void await task.update('TASK_STATE_INPUT_REQUIRED', agentText('Which color?'))
      await task.update('TASK_STATE_COMPLETED', agentText(`painted ${firstText(m) ?? ''}`))
    }
    const worker = await joiner(boss.identity, 'painter', ['painter'], painter)
    const other = await joiner(boss.identity, 'other', ['member'], async () => agentText('no'))
    await waitFor(() => worker.identity.base.writable && other.identity.base.writable, 20_000)
    const events: string[] = []
    const w = new JobWorker(worker.pai, worker.identity, { onJob: (_, e) => { events.push(e) } })
    w.start()
    try {
      const fence = await boss.identity.postJob({ text: 'paint the fence' }, { to: 'role:painter' })
      const asked = await boss.identity.waitJobWhere(fence.id, (j) => j?.question !== undefined && j?.question !== null, { timeout: 30_000 })
      expect(asked?.question).toMatchObject({ n: 1, text: 'Which color?', answer: null })
      expect((await boss.identity.inbox()).questions.map((j) => j.id)).toEqual([fence.id])
      // Waiting for the answer leaves the worker free for another job.
      const quick = await boss.identity.postJob({ text: 'quick' }, { to: 'role:painter' })
      expect(await boss.identity.waitJob(quick.id, { timeout: 30_000 })).toMatchObject({ state: 'done', result: 'quick done' })
      // Only the poster (or an admin) answers.
      await waitFor(async () => (await other.identity.getJob(fence.id))?.question != null, 20_000)
      await expect(other.identity.answerJob(fence.id, 'red')).rejects.toThrow(/poster or an admin/)
      await boss.identity.answerJob(fence.id, 'blue')
      expect(await boss.identity.waitJob(fence.id, { timeout: 30_000 })).toMatchObject({ state: 'done', result: 'painted blue', question: { answer: 'blue' } })
      expect(events).toContain('asked')
      expect(events).toContain('answered')
      // Canceled while it waits: the run stops, asking nothing more.
      const gate = await boss.identity.postJob({ text: 'paint the gate' }, { to: 'role:painter' })
      await boss.identity.waitJobWhere(gate.id, (j) => j?.question != null, { timeout: 30_000 })
      await boss.identity.cancelJob(gate.id)
      await new Promise((resolve) => setTimeout(resolve, 2000))
      expect(events.filter((e) => e === 'asked')).toHaveLength(2)
      expect((await boss.identity.getJob(gate.id))?.question?.n).toBe(1)
    } finally {
      await w.close()
    }
  }, 90_000)

  it('gives up on a question nobody answers in time, freeing the slot', async () => {
    const boss = await admin()
    const asker = async (m: Message, task: TaskHandle): Promise<void> => {
      await task.update('TASK_STATE_WORKING')
      if (firstText(m) === 'quick') return void await task.update('TASK_STATE_COMPLETED', agentText('quick done'))
      await task.update('TASK_STATE_INPUT_REQUIRED', agentText('Which color?'))
    }
    const worker = await joiner(boss.identity, 'painter', ['painter'], asker)
    await waitFor(() => worker.identity.base.writable, 20_000)
    // One waiting slot: it's held by the question until it gives up.
    expect(() => new JobWorker(worker.pai, worker.identity, { answerWithin: Number.NaN })).toThrow(/answerWithin/)
    expect(() => new JobWorker(worker.pai, worker.identity, { answerWithin: 0 })).toThrow(/answerWithin/)
    const w = new JobWorker(worker.pai, worker.identity, { answerWithin: 2500, maxWaiting: 1 })
    w.start()
    try {
      const fence = await boss.identity.postJob({ text: 'paint the fence' }, { to: 'role:painter' })
      const out = await boss.identity.waitJob(fence.id, { timeout: 30_000 })
      expect(out).toMatchObject({ state: 'failed', result: 'No answer within 2.5 s to: Which color?' })
      const task = await boss.pai.getTaskOf(Buffer.from(worker.identity.self, 'hex'), out!.ref!)
      expect(task.status.state).toBe('TASK_STATE_CANCELED')
      const quick = await boss.identity.postJob({ text: 'quick' }, { to: 'role:painter' })
      expect(await boss.identity.waitJob(quick.id, { timeout: 30_000 })).toMatchObject({ state: 'done' })
    } finally {
      await w.close()
    }
  }, 90_000)

  it('lets a person take a job by hand and report it', async () => {
    const boss = await admin()
    const person = await joiner(boss.identity, 'person', ['reviewer'], async () => agentText('auto'))
    await waitFor(() => person.identity.base.writable, 20_000)
    const review = await boss.identity.postJob({ text: 'review the draft' }, { to: 'role:reviewer', lease: 5000 })
    await waitFor(async () => (await person.identity.inbox()).open.some((j) => j.id === review.id), 20_000)
    const taken = await person.identity.takeJob(review.id)
    expect(taken.mine).toBe(true)
    expect((await person.identity.inbox()).held.map((j) => j.id)).toEqual([review.id])
    // A worker on the same agent leaves it to the person, and the agent
    // keeps the lease while they work on it.
    const w = new JobWorker(person.pai, person.identity)
    w.start()
    try {
      await new Promise((resolve) => setTimeout(resolve, 8000))
      expect(await boss.identity.getJob(review.id)).toMatchObject({ state: 'claimed', claim: { by: person.identity.self, hand: true } })
      await person.identity.finishJob(review.id, { state: 'done', result: 'looks good', ref: null })
      expect(await boss.identity.waitJob(review.id, { timeout: 20_000 })).toMatchObject({ state: 'done', result: 'looks good' })
    } finally {
      await w.close()
    }
  }, 90_000)

  it('fails a job nobody takes by its deadline, once an admin says what time it is', async () => {
    const boss = await admin()
    const job = await boss.identity.postJob({ text: 'for nobody' }, { to: 'role:nobody', deadline: 2000 })
    const out = await boss.identity.waitJob(job.id, { timeout: 20_000 })
    expect(out?.state).toBe('failed')
    expect(out?.result).toMatch(/missed its deadline/)
  }, 30_000)

  it('attaches whole results by reference, tells a retry why, and keeps a named context', async () => {
    const boss = await admin()
    const seen: Message[] = []
    let failNext = false
    const handler = async (m: Message): Promise<Message> => {
      seen.push(m)
      if (failNext) { failNext = false; throw new Error('flaky') }
      if (firstText(m) === 'long') return agentText('L'.repeat(20_000))
      return agentText('ok')
    }
    // Returns a task (not a bare message), so the result is in a shared task.
    const worker = await joiner(boss.identity, 'worker', ['member'], async (m, task) => {
      await task.update('TASK_STATE_WORKING')
      const reply = await handler(m)
      await task.artifact({ artifactId: 'out', parts: reply.parts })
      await task.update('TASK_STATE_COMPLETED')
    })
    await waitFor(() => worker.identity.base.writable, 20_000)
    const w = new JobWorker(worker.pai, worker.identity)
    w.start()
    try {
      const long = await boss.identity.postJob({ text: 'long' })
      const done = await boss.identity.waitJob(long.id, { timeout: 30_000 })
      // The board keeps 16 KiB of it; the task has it all.
      expect(done?.result?.endsWith(RESULT_CUT_NOTE)).toBe(true)
      await expect(boss.identity.postJob({ text: 'x', attach: [jobId()] })).rejects.toThrow(/isn't on the board/)

      failNext = true
      const use = await boss.identity.postJob({ text: 'use it', attach: [long.id], context: 'c1' }, { retries: 1 })
      expect(await boss.identity.waitJob(use.id, { timeout: 30_000 })).toMatchObject({ state: 'done', result: 'ok', attempt: 2 })
      const [lost, run] = seen.slice(-2)
      for (const m of [lost!, run!]) {
        expect(m.contextId).toBe(`${boss.identity.self}:c1`)
        const attached = m.parts.find((p) => p.metadata?.['pai/attached'] === long.id)
        expect(attached && 'text' in attached ? attached.text : '').toBe(`--- Attached: the result of job ${long.id} ---\n${'L'.repeat(20_000)}`)
      }
      // The retry note comes last, after the attachments.
      expect(run!.parts.at(-1)).toMatchObject({ text: '(This is attempt 2 of 2. The last attempt was lost: flaky)' })
      expect(lost!.parts.some((p) => p.metadata?.['pai/retry'])).toBe(false)

      // A failed job's result (its error) attaches too, marked as such.
      failNext = true
      const broken = await boss.identity.postJob({ text: 'break' })
      expect(await boss.identity.waitJob(broken.id, { timeout: 30_000 })).toMatchObject({ state: 'failed' })
      const after = await boss.identity.postJob({ text: 'why?', attach: [broken.id] })
      expect(await boss.identity.waitJob(after.id, { timeout: 30_000 })).toMatchObject({ state: 'done' })
      expect(seen.at(-1)!.parts.at(-1)).toMatchObject({ text: `--- Attached: the result of job ${broken.id} ---\n(it failed)\nflaky` })
    } finally {
      await w.close()
    }
  }, 90_000)

  it('reports a run that throws as failed, with the error as its result', async () => {
    const boss = await admin()
    let fail = true
    const flaky = async (m: Message): Promise<Message> => {
      if (fail) throw new Error('boom')
      return agentText(`ok: ${firstText(m) ?? ''}`)
    }
    const worker = await joiner(boss.identity, 'worker', ['member'], flaky)
    await waitFor(() => worker.identity.base.writable, 20_000)
    const w = new JobWorker(worker.pai, worker.identity)
    w.start()
    try {
      const failed = await boss.identity.postJob({ text: 'try' })
      const out = await boss.identity.waitJob(failed.id, { timeout: 30_000 })
      expect(out).toMatchObject({ state: 'failed', result: 'boom' })
      fail = false
      const ok = await boss.identity.postJob({ text: 'again' })
      expect(await boss.identity.waitJob(ok.id, { timeout: 30_000 })).toMatchObject({ state: 'done', result: 'ok: again' })
    } finally {
      await w.close()
    }
  }, 90_000)
})
