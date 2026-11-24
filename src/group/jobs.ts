// The job board: work items any member posts to the group, and members
// whose roles fit claim, run and report. Like the rest of the group's
// state, these are ops in the Autobase folded by a deterministic apply
// (see state.ts); this file holds the job ops' shapes and rules.

import type { Message, Part, Task } from '../a2a/types.js'

// What to do: the text of the message a worker runs, and optional
// structured data sent along as a data part. `attach`: jobs whose whole
// results the worker reads from their tasks (shared with the group) and
// sends along, so long context goes by reference instead of through the
// board. `context`: a name that puts the jobs a poster gives it in one A2A
// context on each worker (see jobContextId), for handlers that keep a
// conversation per context.
export interface JobSpec {
  text: string
  data?: unknown
  attach?: string[]
  context?: string
}

export type JobState = 'open' | 'claimed' | 'done' | 'failed' | 'canceled'

export const JOB_STATES: readonly JobState[] = ['open', 'claimed', 'done', 'failed', 'canceled']

// Whether a job has ended: done, failed or canceled.
export function isEnded (job: { state: JobState } | null): boolean {
  return job !== null && (job.state === 'done' || job.state === 'failed' || job.state === 'canceled')
}

export interface JobRecord {
  // 16 random bytes, hex.
  id: string
  // The identity that posted it.
  by: string
  spec: JobSpec
  // Who may claim it: 'role:<role>', an identity, or anyone (null).
  to: string | null
  // A claim lapses this long (ms) after it's made, and anyone allowed may
  // claim the job again; null: never.
  lease: number | null
  state: JobState
  // `at`: the claim op's own time (what names the claim: a reordering
  // can't change it). `start`: when its lease started, by the group's
  // clock (see applyJobOp). `renewed`: when the claimant last said it's
  // still at it (job.renew). The lease runs from the later of the two.
  claim: { by: string, writer: string, at: number, start?: number, renewed?: number, hand?: true } | null
  // When done or failed: the result's text (up to MAX_JOB_RESULT bytes),
  // and the task on the worker identity (claim.by) that ran it.
  result: string | null
  ref: string | null
  at: number
  updated: number
  // A workflow's step (src/group/flows.ts), or one item of a map or
  // copies step, in a round of a repeat (from 1; absent: the first):
  // posted by the group's rules.
  flow?: { id: string, step: string, item?: number, round?: number }
  // What the job's task asked, stopped for input (A2A input-required), and
  // the answer once the poster (or an admin) gives one. `n` counts the
  // questions under this claim; a new claim starts over.
  question?: Question | null
  // Limits (see JobLimits): how long an attempt may run (ms, from its
  // claim), when the job must have ended (by the group's clock), how many
  // times a lost attempt is tried again, and the first wait before that
  // (doubling each time). `attempt` counts the claims so far; `notBefore`:
  // when it may be claimed again after a retry; `lastError`: why the last
  // attempt was lost.
  timeout?: number | null
  due?: number | null
  retries?: number | null
  backoff?: number | null
  attempt?: number
  notBefore?: number | null
  lastError?: string | null
}

// What a poster may ask of a job's running (all optional). `retries`
// null (unset): a failure ends the job, and a lapsed lease can be taken
// over any number of times; set: failures, timeouts and lapses each use
// one up, and the job fails once they're gone.
export interface JobLimits {
  timeout?: number | null
  deadline?: number | null
  retries?: number | null
  backoff?: number | null
}

const DAY = 24 * 60 * 60 * 1000
export const MAX_RETRIES = 20
const MAX_BACKOFF = 60 * 60 * 1000

// Why `l` isn't a valid set of limits, or null.
// `names`: what to call each field in the message (the CLI's flags, say),
// and `unit` what times are given in.
export function limitsProblem (l: JobLimits, names: Partial<Record<keyof JobLimits, string>> = {}, unit: 'ms' | 's' = 'ms'): string | null {
  const int = (v: unknown, lo: number, hi: number): boolean => v === undefined || v === null || (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi)
  const name = (k: keyof JobLimits): string => names[k] ?? k
  const per = unit === 'ms' ? ', in ms' : ', in seconds'
  if (!int(l.timeout, MIN_LEASE, 30 * DAY)) return `${name('timeout')} is ${MIN_LEASE / 1000} s to 30 days${per}`
  if (!int(l.deadline, 1000, 365 * DAY)) return `${name('deadline')} is 1 s to 365 days from posting${per}`
  if (!int(l.retries, 0, MAX_RETRIES)) return `${name('retries')} is 0 to ${MAX_RETRIES}`
  if (!int(l.backoff, 0, MAX_BACKOFF)) return `${name('backoff')} is 0 to 1 hour${per}`
  return null
}

// Copies the limits that are set.
export function limitsOf (l: JobLimits): JobLimits {
  const out: JobLimits = {}
  for (const k of ['timeout', 'deadline', 'retries', 'backoff'] as const) if (l[k] !== undefined && l[k] !== null) out[k] = l[k]
  return out
}

export interface Question {
  n: number
  text: string
  at: number
  answer: string | null
  // The identity that answered.
  by: string | null
}

export type JobOp =
  | { type: 'job.post', job: { id: string, spec: JobSpec, to: string | null, lease: number | null } & JobLimits }
  // `hand`: taken by a person (pai job take), not a worker.
  | { type: 'job.claim', id: string, hand?: true }
  | { type: 'job.release', id: string }
  | { type: 'job.renew', id: string }
  | { type: 'job.done', id: string, state: 'done' | 'failed', result: string | null, ref: string | null }
  | { type: 'job.cancel', id: string }
  | { type: 'job.ask', id: string, n: number, text: string }
  | { type: 'job.answer', id: string, n: number, text: string }

// The largest spec (as JSON) and inline result a job carries.
export const MAX_JOB_SPEC = 16 * 1024
export const MAX_JOB_RESULT = 16 * 1024

// How a worker marks a result it had to cut to MAX_JOB_RESULT: the task
// (the job's ref) has all of it.
export const RESULT_CUT_NOTE = '\n…(truncated: the task has it all)'

// How many jobs' results one job may attach.
export const MAX_ATTACH = 8
const CONTEXT = /^[A-Za-z0-9._:-]{1,64}$/

// How many ended jobs the board keeps: past that, the ones that ended
// first (in the log's order, not by anyone's clock) go, a few per job op.
export const MAX_ENDED_JOBS = 1000
const PRUNE_BATCH = 16

// Why an attempt whose lease lapsed was lost.
const LAPSED = 'the worker stopped renewing its lease'
// How many claims a job without `retries` may have its lease lapse under
// before taking it over fails it instead: a job that crashes or hangs each
// worker that takes it doesn't go on to the next one for good.
export const MAX_LAPSES = 5

// How many questions a job may ask under one claim.
export const MAX_QUESTIONS = 100

// The shortest lease a job may have (ms): a worker renews a few times per
// lease, and every renewal is an op every member keeps.
export const MIN_LEASE = 5000
const JOB_ID = /^[0-9a-f]{32}$/
const HEX32 = /^[0-9a-f]{64}$/
const ROLE = /^role:[a-z][a-z0-9_-]{0,31}$/

// Whether a job's spec is within MAX_JOB_SPEC bytes as JSON.
export function specFits (spec: JobSpec): boolean {
  return Buffer.byteLength(JSON.stringify(spec)) <= MAX_JOB_SPEC
}

// Why `spec` isn't a valid job spec, or null.
export function specProblem (spec: JobSpec): string | null {
  if (typeof spec !== 'object' || spec === null || typeof spec.text !== 'string') return 'a job has text'
  if (spec.attach !== undefined && !(Array.isArray(spec.attach) && spec.attach.length >= 1 && spec.attach.length <= MAX_ATTACH && spec.attach.every(isJobId) && new Set(spec.attach).size === spec.attach.length)) {
    return `attach names 1 to ${MAX_ATTACH} different job ids`
  }
  if (spec.context !== undefined && !(typeof spec.context === 'string' && CONTEXT.test(spec.context))) return 'context is 1 to 64 letters, digits, and . _ : -'
  if (!specFits(spec)) return 'a job is up to 16 KiB as JSON'
  return null
}

export function isJobId (v: unknown): v is string {
  return typeof v === 'string' && JOB_ID.test(v)
}

// Whether `id` is one the group's rules post (a workflow's steps: the top
// bit of its first byte set). Members' jobs have it clear, so no member
// can post a job under a step's id first.
export function isRulesJobId (id: string): boolean {
  return parseInt(id[0]!, 16) >= 8
}

// Whether `v` names who may claim a job: a role or an identity.
export function isJobTarget (v: unknown): v is string {
  return typeof v === 'string' && (ROLE.test(v) || HEX32.test(v))
}

export function parseJobOp (v: Record<string, any>): JobOp | null {
  switch (v.type) {
    case 'job.post': {
      const j = v.job
      if (typeof j !== 'object' || j === null || !isJobId(j.id) || isRulesJobId(j.id)) return null
      if (specProblem(j.spec) !== null) return null
      if (j.to !== null && !isJobTarget(j.to)) return null
      if (j.lease !== null && !(Number.isInteger(j.lease) && j.lease >= MIN_LEASE)) return null
      if (limitsProblem(j) !== null) return null
      return v as JobOp
    }
    case 'job.claim':
    case 'job.release':
    case 'job.renew':
    case 'job.cancel':
      return isJobId(v.id) ? v as JobOp : null
    case 'job.ask':
    case 'job.answer': {
      if (!isJobId(v.id) || !Number.isInteger(v.n) || v.n < 1 || v.n > MAX_QUESTIONS || typeof v.text !== 'string') return null
      return Buffer.byteLength(v.text) <= (v.type === 'job.ask' ? MAX_JOB_RESULT : MAX_JOB_SPEC) ? v as JobOp : null
    }
    case 'job.done': {
      if (!isJobId(v.id) || (v.state !== 'done' && v.state !== 'failed')) return null
      if (v.result !== null && (typeof v.result !== 'string' || Buffer.byteLength(v.result) > MAX_JOB_RESULT)) return null
      if (v.ref !== null && (typeof v.ref !== 'string' || v.ref.length === 0 || v.ref.length > 200)) return null
      return v as JobOp
    }
    default:
      return null
  }
}

// Whether `member` (an identity, with `roles`) may claim `job` at `now`:
// it's addressed to it, and open, or claimed under a lease that ran out.
export function canClaim (job: JobRecord, member: string, roles: string[], now: number): boolean {
  if (job.to !== null && job.to !== member && !(job.to.startsWith('role:') && roles.includes(job.to.slice(5)))) return false
  // Not before a retry's wait is over.
  if (job.state === 'open') return now >= (job.notBefore ?? 0)
  return job.state === 'claimed' && job.lease !== null && job.claim !== null && now > leaseFrom(job.claim) + job.lease
}

// When a claim's lease started running: at the claim, or its last renewal.
export function leaseFrom (claim: { at: number, start?: number, renewed?: number }): number {
  return Math.max(claim.start ?? claim.at, claim.renewed ?? 0)
}

// When an op counts as made: its time, but never before the group's clock,
// so a backdated op gets a lapsed member nowhere, and a device a little
// behind the admins isn't behind the group.
export function madeAt (at: number, clock: number): number {
  return Math.max(at, clock)
}

// Where the view indexes jobs: open and claimed ones by state (what
// workers read), ended ones in the order they ended (what pruning reads):
// `jobs-ended/<sequence>`, with the sequence and count in `jobs-ended`.
export function activeKey (state: JobState, id: string): string {
  return `jobs/${state}/${id}`
}

function endedKey (seq: number): string {
  return `jobs-ended/${String(seq).padStart(16, '0')}`
}

interface EndedCounter { next: number, count: number }

// The A2A message a worker runs for `job` under its current claim. Its id
// is the job's and the claim's, so running it again under the same claim
// (after a restart) gets the task it already started, while a new claim
// runs it afresh.
// Another attempt says which, and why the last one was lost, so the
// worker needn't repeat it: as the last part. Attached results
// (spec.attach) are added before it by whoever runs the job
// (GroupIdentity.jobInput), since they're read from tasks.
export function jobMessage (job: JobRecord): Message {
  const parts: Message['parts'] = [{ text: job.spec.text }]
  if (job.spec.data !== undefined) parts.push({ data: job.spec.data })
  const attempt = job.attempt ?? 1
  const retry = attempt > 1 && job.lastError != null
  if (retry) {
    const of = job.retries != null ? ` of ${job.retries + 1}` : ''
    parts.push({ text: `(This is attempt ${attempt}${of}. The last attempt was lost: ${job.lastError})`, metadata: { 'pai/retry': true } })
  }
  const contextId = jobContextId(job)
  return {
    role: 'ROLE_USER',
    messageId: `job-${job.id}-${job.claim?.at ?? 0}`,
    ...(contextId ? { contextId } : {}),
    parts,
    metadata: { 'pai/job': job.id, ...(retry ? { 'pai/attempt': attempt, 'pai/last-error': job.lastError } : {}) }
  }
}

// What a task reports as its result: its artifacts' text (an artifact's
// parts are chunks of one stream, joined as they came), or else its
// status message's.
export function taskResultText (task: Pick<Task, 'artifacts' | 'status'>): string {
  return task.artifacts?.length ? task.artifacts.map((a) => partsText(a.parts, '')).join('') : partsText(task.status.message?.parts ?? [])
}

// The text parts' text, joined.
export function partsText (parts: Part[], separator = '\n'): string {
  return parts.map((p) => 'text' in p ? p.text : '').filter(Boolean).join(separator)
}

// The A2A context a job's task runs in, if its spec names one: under its
// poster's identity, so no poster can join another's context on a worker.
export function jobContextId (job: Pick<JobRecord, 'by' | 'spec'>): string | null {
  return job.spec.context ? `${job.by}:${job.spec.context}` : null
}

// The view as the job rules use it (state.ts's View).
export interface JobView {
  get (key: string): Promise<{ value: any } | null>
  put (key: string, value: unknown): Promise<void>
  del (key: string): Promise<void>
  createReadStream (range: { gt: string, lt: string }): AsyncIterable<{ key: string, value: any }>
}

// Writes a job, keeping the indexes in step. (An ended job never changes
// again, so it only ever enters the ended index once.)
export async function putJob (view: JobView, prev: JobRecord | null, next: JobRecord): Promise<void> {
  if (prev !== null && !isEnded(prev)) await view.del(activeKey(prev.state, prev.id))
  await view.put(`job/${next.id}`, next)
  if (!isEnded(next)) {
    await view.put(activeKey(next.state, next.id), null)
    return
  }
  const counter: EndedCounter = (await view.get('jobs-ended'))?.value ?? { next: 0, count: 0 }
  await view.put(endedKey(counter.next), next.id)
  await view.put('jobs-ended', { next: counter.next + 1, count: counter.count + 1 })
}

// Drops a few of the jobs that ended first, while more than
// MAX_ENDED_JOBS have.
async function prune (view: JobView): Promise<void> {
  const counter: EndedCounter | undefined = (await view.get('jobs-ended'))?.value
  if (!counter || counter.count <= MAX_ENDED_JOBS) return
  const over = Math.min(PRUNE_BATCH, counter.count - MAX_ENDED_JOBS)
  const old: Array<{ key: string, id: string }> = []
  for await (const { key, value } of view.createReadStream({ gt: 'jobs-ended/', lt: 'jobs-ended0' })) {
    old.push({ key, id: value })
    if (old.length >= over) break
  }
  for (const { key, id } of old) {
    await view.del(key)
    await view.del(`job/${id}`)
  }
  await view.put('jobs-ended', { ...counter, count: counter.count - old.length })
}

// Folds a job op by `author` (an identity, through its writer `writer`)
// into the view. `member` is the author's roster record, or null; `admin`
// whether it's an admin. Ops that break a rule are skipped.
// `ended` hears of each job the op ends (workflows move on from it).
// `clock` is the group's clock (state.ts): what leases and memberships run
// out by, since an op's own time is only its author's word. (Without it,
// as in unit tests, the op's time.)
export async function applyJobOp (op: JobOp & { at: number }, author: string, writer: string, view: JobView, member: { roles: string[], until: number | null } | null, admin: boolean, ended: (job: JobRecord) => Promise<void> = async () => {}, clock: number = op.at): Promise<void> {
  const at = madeAt(op.at, clock)
  if (member === null || (member.until !== null && member.until <= at && !admin)) return
  await prune(view)
  if (op.type === 'job.post') {
    if (isRulesJobId(op.job.id) || await view.get(`job/${op.job.id}`) !== null) return
    await postJob(view, {
      id: op.job.id, by: author, spec: op.job.spec, to: op.job.to, lease: op.job.lease, state: 'open', claim: null, result: null, ref: null, at, updated: at
    }, op.job)
    return
  }
  const key = `job/${op.id}`
  const rec = await view.get(key)
  if (rec === null) return
  const job = rec.value as JobRecord
  switch (op.type) {
    case 'job.claim': {
      // The first claim in the log's order wins; a later one only once
      // the lease has run out by the group's clock.
      if (!canClaim(job, author, member.roles, clock)) return
      // Taking over a lapsed lease: that attempt was lost. Out of retries
      // (or, without retries, past MAX_LAPSES), the job fails instead.
      const lapsed = job.state === 'claimed'
      if (lapsed && (job.retries != null ? !canRetry(job) : (job.attempt ?? 1) >= MAX_LAPSES)) {
        const next: JobRecord = { ...job, state: 'failed', result: `gave up after ${job.attempt ?? 1} attempt(s): ${LAPSED}`, updated: at }
        await putJob(view, job, next)
        await ended(next)
        return
      }
      // The lease runs from no later than a lease past the group's clock:
      // a claim dated far ahead can't hold the job for good.
      const start = job.lease === null ? at : Math.min(at, clock + job.lease)
      const next: JobRecord = { ...job, state: 'claimed', claim: { by: author, writer, at: op.at, start, ...(op.hand === true ? { hand: true as const } : {}) }, question: null, attempt: (job.attempt ?? 0) + 1, ...(lapsed ? { lastError: LAPSED } : {}), updated: at }
      await putJob(view, job, next)
      if (job.timeout != null) await dueAt(view, start + job.timeout + 1, job.id, 'timeout', op.at)
      return
    }
    case 'job.renew': {
      // Only the claiming device, only forward in time, never more than a
      // couple of leases ahead (a clock far off can't hold a job for good),
      // and not once the lease has run out by the group's clock.
      if (job.state !== 'claimed' || job.claim?.by !== author || job.claim.writer !== writer || job.lease === null) return
      const from = leaseFrom(job.claim)
      if (at <= from || at > from + 2 * job.lease || clock > from + job.lease) return
      await view.put(key, { ...job, claim: { ...job.claim, renewed: at } })
      return
    }
    case 'job.release':
      if (job.state !== 'claimed' || job.claim?.by !== author) return
      // Given back: that attempt doesn't count.
      await putJob(view, job, { ...job, state: 'open', claim: null, question: null, attempt: Math.max(0, (job.attempt ?? 1) - 1), updated: at })
      return
    case 'job.ask': {
      // The claiming device, about its own run: the next question, once the
      // last is answered.
      if (job.state !== 'claimed' || job.claim?.by !== author || job.claim.writer !== writer) return
      const last = job.question ?? null
      if (op.n !== (last?.n ?? 0) + 1 || (last !== null && last.answer === null)) return
      await view.put(key, { ...job, question: { n: op.n, text: op.text, at, answer: null, by: null }, updated: at })
      return
    }
    case 'job.answer': {
      // The poster (whose task it is) or an admin, once.
      const q = job.question ?? null
      if (job.state !== 'claimed' || q === null || q.n !== op.n || q.answer !== null) return
      if (job.by !== author && !admin) return
      await view.put(key, { ...job, question: { ...q, answer: op.text, by: author }, updated: at })
      return
    }
    case 'job.done':
      // From the device whose claim it is: a late report from an earlier
      // attempt (timed out, the job since claimed again) doesn't count.
      if (job.state !== 'claimed' || job.claim?.by !== author || job.claim.writer !== writer) return
      // A failure with retries left: open again, after the backoff.
      if (op.state === 'failed' && canRetry(job)) {
        await reopen(view, job, clock, op.result ?? 'failed')
        return
      }
    {
      const next: JobRecord = { ...job, state: op.state, result: op.result, ref: op.ref, updated: at }
      await putJob(view, job, next)
      await ended(next)
      return
    }
    case 'job.cancel':
      if (job.state !== 'open' && job.state !== 'claimed') return
      if (job.by !== author && !admin) return
    {
      const next: JobRecord = { ...job, state: 'canceled', updated: at }
      await putJob(view, job, next)
      await ended(next)
    }
  }
}

// Which unanswered question a job shows, if any ("<claim time>:<n>"), so a
// waiting caller hears of each one once (n starts over under a new claim).
export function questionKey (j: JobRecord | null): string {
  const q = j?.question ?? null
  return j?.state === 'claimed' && q !== null && q.answer === null ? `${j.claim?.at ?? 0}:${q.n}` : ''
}

// ---- limits: retries, timeouts, deadlines ----

// Whether a lost attempt of `job` may be tried again.
function canRetry (job: JobRecord): boolean {
  return job.retries != null && (job.attempt ?? 1) <= job.retries
}

// `job` open again for another attempt, after its backoff (doubling with
// each attempt, up to an hour), with `why` the last attempt was lost.
function retry (job: JobRecord, clock: number, why: string): JobRecord {
  const wait = Math.min((job.backoff ?? 0) * 2 ** ((job.attempt ?? 1) - 1), MAX_BACKOFF)
  return { ...job, state: 'open', claim: null, question: null, lastError: why.slice(0, 1000), notBefore: wait > 0 ? clock + wait : null, updated: clock }
}

// Reopens `job` for a retry, noting when its wait ends (so admins know
// when to move the clock on: see nextDue).
async function reopen (view: JobView, job: JobRecord, clock: number, why: string): Promise<void> {
  const next = retry(job, clock, why)
  await putJob(view, job, next)
  if (next.notBefore != null) await dueAt(view, next.notBefore, job.id, 'wait')
}

// Posts a new job with `limits`: its deadline counted from now.
export async function postJob (view: JobView, job: JobRecord, limits: JobLimits): Promise<void> {
  const l = limitsOf(limits)
  const due = l.deadline != null ? job.at + l.deadline : null
  await putJob(view, null, { ...job, timeout: l.timeout ?? null, due, retries: l.retries ?? null, backoff: l.backoff ?? null })
  if (due !== null) await dueAt(view, due + 1, job.id, 'deadline')
}

// Where the view keeps what falls due, by the first time it's past
// (`jobs-due/<time>/<id>/<kind>`), for sweepJobs: as with leases, a limit
// is past once the clock is beyond it. An entry no longer true by then is
// dropped. A schedule's run (src/group/flows.ts) is due at its time, under
// its name.
export async function dueAt (view: JobView, time: number, id: string, kind: 'deadline' | 'timeout' | 'wait' | 'schedule', claimAt?: number): Promise<void> {
  await view.put(`jobs-due/${String(time).padStart(16, '0')}/${id}/${kind}`, { claimAt: claimAt ?? null })
}

// Up to how many entries one clock move sweeps; the rest go with the next
// (an admin's device moves it on again while any are past: see nextDue).
const SWEEP_BATCH = 64

// The earliest time something falls due (an entry not yet swept), or null.
export async function nextDue (view: Pick<JobView, 'createReadStream'>): Promise<number | null> {
  for await (const { key } of view.createReadStream({ gt: 'jobs-due/', lt: 'jobs-due0' })) return Number(key.split('/')[1])
  return null
}

// Applies what fell due by `clock` (the group's): a job past its deadline
// fails; an attempt past its timeout is lost (tried again if retries are
// left, failed if not); a schedule's run goes to `scheduled`, with the
// time it was due. A few at a time; the rest on the next ops.
export async function sweepJobs (view: JobView, clock: number, ended: (job: JobRecord) => Promise<void>, scheduled: (name: string, due: number) => Promise<void> = async () => {}): Promise<void> {
  const due: Array<{ key: string, value: { claimAt: number | null } }> = []
  for await (const entry of view.createReadStream({ gt: 'jobs-due/', lt: `jobs-due/${String(clock + 1).padStart(16, '0')}` })) {
    due.push(entry)
    if (due.length >= SWEEP_BATCH) break
  }
  for (const { key, value } of due) {
    await view.del(key)
    const [, time, id, kind] = key.split('/')
    if (kind === 'schedule') {
      await scheduled(id!, Number(time))
      continue
    }
    const job = (await view.get(`job/${id}`))?.value as JobRecord | undefined
    if (!job || isEnded(job) || kind === 'wait') continue
    if (kind === 'deadline') {
      if (job.due == null || job.due >= clock) continue
      const next: JobRecord = { ...job, state: 'failed', result: `missed its deadline (${new Date(job.due).toISOString()})${job.lastError ? `; last error: ${job.lastError}` : ''}`, updated: clock }
      await putJob(view, job, next)
      await ended(next)
      continue
    }
    // A timeout: only for the claim it was set for, still running.
    if (job.state !== 'claimed' || job.claim === null || job.claim.at !== value?.claimAt || job.timeout == null) continue
    if ((job.claim.start ?? job.claim.at) + job.timeout >= clock) continue
    const why = `timed out after ${Math.round(job.timeout / 1000)} s`
    if (canRetry(job)) {
      await reopen(view, job, clock, why)
      continue
    }
    const next: JobRecord = { ...job, state: 'failed', result: job.retries != null ? `gave up after ${job.attempt ?? 1} attempt(s): ${why}` : why, updated: clock }
    await putJob(view, job, next)
    await ended(next)
  }
}
