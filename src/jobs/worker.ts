import type { Message, Task } from '../a2a/types.js'
import { MAX_JOB_RESULT, RESULT_CUT_NOTE, leaseFrom, partsText, taskResultText } from '../group/jobs.js'
import type { JobRecord } from '../group/jobs.js'
import type { GroupMembership } from '../group/membership.js'
import type { Pai } from '../pai.js'
import { isTerminal } from '../task/task.js'
import { hex } from '../util/replica.js'

export interface JobWorkerOptions {
  // How many jobs run at once. Default 1.
  concurrency?: number
  // How many more it may hold while their runs wait for answers (which
  // don't count against concurrency). Default 8.
  maxWaiting?: number
  // How long (ms) a run waits for the answer to its question, from when it
  // was asked, before it gives up and the attempt fails (so questions
  // nobody answers don't hold the worker's waiting slots for good).
  // Default a day; Infinity: no limit.
  answerWithin?: number
  // Told about each job as it's claimed, starts and ends (for logs).
  onJob? (job: JobRecord, event: 'claimed' | 'started' | 'asked' | 'answered' | 'done' | 'failed' | 'lost' | 'released'): void
}

interface Claim {
  // The claim's time: the job runs under this claim only.
  at: number
  running: boolean
  // Stopped for input, waiting for the poster's answer: it doesn't count
  // against the worker's concurrency meanwhile.
  waiting: boolean
  taskId: string | null
  // Renews the claim's lease from the moment it's made (signing can take
  // a while) until it's given up.
  renew: NodeJS.Timeout | null
  // When this worker first saw each question go unanswered, by its own
  // clock (the board's times follow the group's): question n → ms.
  asked?: Map<number, number>
}

type Outcome = { state: 'done' | 'failed', result: string | null, ref: string | null }

const DAY = 24 * 60 * 60 * 1000

// The longest a lease timer waits before looking again (Node's timer limit
// is about 24.8 days).
const MAX_WAKE = 2 ** 31 - 1

// Takes jobs off one group's board and runs them through this agent's own
// handler, as if the job's poster had sent the message: the poster can read
// and cancel the task like any of its own. A worker claims open jobs it's
// allowed to (addressed to its identity, one of its roles, or anyone; from
// a poster the group's policy lets call it), starts one only once its claim
// is signed (so no reordering can hand it to someone else), and reports the
// result to the board. Closing gives back what it holds.
export class JobWorker {
  readonly #pai: Pai
  readonly #identity: GroupMembership
  readonly #options: JobWorkerOptions
  // Jobs this device has claimed, by id: until signed, then while running.
  readonly #mine = new Map<string, Claim>()
  // Claims this worker has reported on ("<job id> <claim time>"), so a
  // board read from before the report doesn't take the job up again.
  readonly #reported = new Set<string>()
  readonly #runs = new Set<Promise<void>>()
  #pass: Promise<void> = Promise.resolve()
  #queued = false
  #stop: (() => void) | null = null
  #wake: NodeJS.Timeout | null = null
  #closed = false
  // Aborted on close: wakes runs waiting for an answer.
  readonly #closing = new AbortController()
  // Runs waiting for a slot to resume in (see #takeSlot).
  readonly #slotWaiters = new Set<() => void>()

  constructor (pai: Pai, identity: GroupMembership, options: JobWorkerOptions = {}) {
    if (options.answerWithin !== undefined && !(options.answerWithin > 0)) throw new Error('answerWithin is a number of ms above 0 (Infinity: no limit)')
    this.#pai = pai
    this.#identity = identity
    this.#options = options
  }

  // Starts watching the board; the group must be open (after
  // pai.ready()).
  start (): void {
    if (this.#stop || this.#closed) return
    const group = this.#identity.base
    const onChange = (): void => { this.#schedule() }
    group.on('change', onChange)
    this.#stop = () => { group.off('change', onChange) }
    this.#schedule()
  }

  // Stops taking jobs, cancels the ones running, and gives every job it
  // holds back to the board for other workers.
  async close (): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#closing.abort()
    this.#freeSlot()
    this.#stop?.()
    this.#stop = null
    if (this.#wake) clearTimeout(this.#wake)
    await this.#pass
    for (const [id, claim] of this.#mine) {
      stopRenewing(claim)
      if (claim.taskId) await this.#pai.cancelLocal(claim.taskId).catch(() => {})
      await this.#identity.releaseJob(id).catch(() => {})
      const job = await this.#identity.getJob(id).catch(() => null)
      if (job) this.#options.onJob?.(job, 'released')
    }
    await Promise.allSettled([...this.#runs])
    this.#mine.clear()
  }

  // One pass at a time; changes while one is queued share it.
  #schedule (): void {
    if (this.#queued || this.#closed) return
    this.#queued = true
    this.#pass = this.#pass.then(async () => {
      this.#queued = false
      if (!this.#closed) await this.#step()
    }).catch(() => {})
  }

  async #step (): Promise<void> {
    const identity = this.#identity
    const group = identity.base
    if (!group.writable) return
    const writer = hex(group.writerKey)
    // From one snapshot: what's still in play (indexed, so a long board
    // costs nothing) and this worker's own jobs, oldest first (jobs are
    // taken in the order they were posted). The signed board only for
    // claims still waiting on it.
    const mine = [...this.#mine.keys()]
    const { active, named } = await identity.activeJobs({ ids: mine })
    const waiting = mine.filter((id) => !this.#mine.get(id)!.running)
    const signed = waiting.length ? (await identity.activeJobs({ signed: true, ids: waiting })).named : new Map<string, JobRecord | null>()
    let nextLease = Infinity

    // A job of this worker's that's gone from the board (pruned) is lost.
    for (const [id, job] of named) {
      const claim = this.#mine.get(id)
      if (job !== null || !claim) continue
      this.#mine.delete(id)
      this.#freeSlot()
      stopRenewing(claim)
      if (claim.taskId) await this.#pai.cancelLocal(claim.taskId).catch(() => {})
    }
    const jobs = [...active, ...[...named.values()].filter((j): j is JobRecord => j !== null && !active.some((a) => a.id === j.id))]

    for (const job of jobs) {
      if (this.#closed) return
      const claim = this.#mine.get(job.id)
      const here = job.state === 'claimed' && job.claim?.writer === writer
      if (claim) {
        if (here && job.claim!.at === claim.at) {
          // Only once the claim is signed: before that, a reordering could
          // still hand the job to another claim.
          const settled = signed.get(job.id)
          if (!claim.running && settled?.state === 'claimed' && settled.claim?.writer === writer && settled.claim.at === claim.at) {
            claim.running = true
            this.#track(this.#run(job, claim))
          }
        } else if (!this.#reported.has(`${job.id} ${claim.at}`)) {
          // Taken by another claim (the log's order, or a lease that ran
          // out), released, or canceled: stop.
          this.#mine.delete(job.id)
          this.#freeSlot()
          stopRenewing(claim)
          if (claim.taskId) await this.#pai.cancelLocal(claim.taskId).catch(() => {})
          this.#options.onJob?.(job, 'lost')
        }
        continue
      }
      // Claimed by this device before a restart: run it again. Under the
      // same claim its message gets the task it started (which the restart
      // failed), and that's what it reports.
      // (Not one a person took by hand: theirs to finish.)
      if (here && job.claim!.hand !== true && !this.#reported.has(`${job.id} ${job.claim!.at}`)) {
        this.#mine.set(job.id, { at: job.claim!.at, running: false, waiting: false, taskId: null, renew: this.#renewing(job) })
        this.#schedule()
        continue
      }
      // A lease runs out by the group's clock, which an admin moves on once
      // it has run out by its own (a change to the board). Until then, a
      // wake-up when it should, in case that comes as no change here.
      if (job.state === 'claimed' && job.lease !== null && job.claim !== null && !here) {
        const end = leaseFrom(job.claim) + job.lease + 1
        if (end > Date.now()) nextLease = Math.min(nextLease, end)
      }
      const concurrency = this.#options.concurrency ?? 1
      // Runs waiting to resume (#takeSlot) go before new jobs.
      const busy = [...this.#mine.values()].filter((c) => !c.waiting).length
      if (this.#slotWaiters.size > 0 || busy >= concurrency || this.#mine.size >= concurrency + (this.#options.maxWaiting ?? 8) || !identity.claimable(job)) continue
      try {
        await identity.claimJob(job.id)
        const claimed = (await identity.getJob(job.id))?.claim
        // (A person's hand claim from this device isn't the worker's.)
        if (claimed?.writer === writer && claimed.hand !== true) {
          this.#mine.set(job.id, { at: claimed.at, running: false, waiting: false, taskId: null, renew: this.#renewing(job) })
          this.#options.onJob?.(job, 'claimed')
        }
      } catch {}
    }
    this.#wakeAt(nextLease)
  }

  // Renews a leased job's claim three times per lease, from now on, until
  // the claim gives up renewing (stopRenewing) or it isn't this worker's.
  #renewing (job: JobRecord): NodeJS.Timeout | null {
    if (job.lease === null) return null
    return this.#identity.renewing(job.id, job.lease, (j) => this.#mine.has(job.id) && j?.state === 'claimed' && j.claim?.hand !== true)
  }

  #wakeAt (at: number): void {
    if (this.#wake) clearTimeout(this.#wake)
    this.#wake = null
    if (at === Infinity || this.#closed) return
    this.#wake = setTimeout(() => { this.#wake = null; this.#schedule() }, Math.min(Math.max(0, at - Date.now()), MAX_WAKE))
    this.#wake.unref()
  }

  #track (run: Promise<void>): void {
    this.#runs.add(run)
    void run.finally(() => { this.#runs.delete(run) })
  }

  async #run (job: JobRecord, claim: Claim): Promise<void> {
    this.#options.onJob?.(job, 'started')
    let outcome: Outcome
    try {
      const res = await this.#converse(job, claim, await this.#pai.runLocal(await this.#identity.jobInput(job), job.by, (t: Task) => { claim.taskId = t.id }))
      if (res === null) return // lost, or closing
      outcome = outcomeOf(res)
    } catch (err) {
      outcome = { state: 'failed', result: fit((err as Error).message ?? String(err)), ref: claim.taskId }
    }
    // Lost meanwhile, or closing (which gives the job back instead).
    if (this.#closed || this.#mine.get(job.id) !== claim) return
    this.#reported.add(`${job.id} ${claim.at}`)
    stopRenewing(claim)
    try {
      await this.#identity.finishJob(job.id, outcome)
      this.#options.onJob?.(job, outcome.state)
    } catch {}
    this.#mine.delete(job.id)
    this.#freeSlot()
    this.#schedule()
  }

  // While the job's task stops for input, asks the poster on the board,
  // waits for the answer, and sends it on as the poster's next message.
  // Null if the job is lost (or the worker closes) meanwhile.
  //
  // After a restart the same claim's messages get their tasks again (their
  // ids are fixed), so an answer already on the board is sent again
  // harmlessly, and a question already asked isn't asked twice.
  async #converse (job: JobRecord, claim: Claim, res: Task | Message): Promise<Task | Message | null> {
    let sent = 0
    while ('status' in res && res.status.state === 'TASK_STATE_INPUT_REQUIRED') {
      const task: Task = res
      const now = await this.#identity.getJob(job.id)
      if (this.#closed || this.#mine.get(job.id) !== claim || now?.state !== 'claimed' || now.claim?.at !== claim.at) return null
      const q = now.question ?? null
      if (q !== null && q.answer !== null && q.n > sent) {
        sent = q.n
        this.#options.onJob?.(now, 'answered')
        // Resumes only in a free slot, as a new run would.
        if (!await this.#takeSlot(claim)) return null
        res = await this.#pai.runLocal(answerMessage(job, claim.at, q.n, q.answer, task), job.by)
        continue
      }
      let pending = q
      if (q === null || q.answer !== null) {
        const n = (q?.n ?? 0) + 1
        await this.#identity.askJob(job.id, n, fit(partsText(task.status.message?.parts ?? []) || 'The task needs input.'))
        // The group's rules can drop it (this agent's membership lapsed,
        // say): then nobody can answer, and asking again would only fill
        // the log.
        pending = (await this.#identity.getJob(job.id))?.question ?? null
        if (pending?.n !== n) throw new Error('The board took no question from this worker (is it still a member?)')
        this.#options.onJob?.(now, 'asked')
      }
      // Not past the time the question may wait for its answer, from when
      // this worker first saw it waiting (by its own clock).
      claim.asked ??= new Map()
      const since = claim.asked.get(pending!.n) ?? Date.now()
      claim.asked.set(pending!.n, since)
      const within = this.#options.answerWithin ?? DAY
      const left = since + within - Date.now()
      if (left <= 0) {
        // One last look: an answer that just came in still counts.
        const last = await this.#identity.getJob(job.id)
        if (last?.state === 'claimed' && last.claim?.at === claim.at && last.question?.n === pending!.n && last.question.answer !== null) continue
        await this.#pai.cancelLocal(task.id, job.by).catch(() => {})
        throw new Error(`No answer within ${duration(within)} to: ${pending!.text.slice(0, 200)}`)
      }
      // Waiting for the answer frees this worker's slot for other jobs.
      claim.waiting = true
      this.#freeSlot()
      this.#schedule()
      await this.#identity.waitJobWhere(job.id, (j) => this.#mine.get(job.id) !== claim || j?.state !== 'claimed' || j.claim?.at !== claim.at || (j.question?.answer ?? null) !== null, { signal: this.#closing.signal, ...(Number.isFinite(left) ? { timeout: left } : {}) })
    }
    if (claim.waiting && !await this.#takeSlot(claim)) return null
    return res
  }

  // Waits for a free slot for a run that waited for an answer; false if
  // the job is lost or the worker closes meanwhile.
  async #takeSlot (claim: Claim): Promise<boolean> {
    const concurrency = this.#options.concurrency ?? 1
    while (!this.#closed && [...this.#mine.values()].includes(claim)) {
      if (!claim.waiting) return true
      if ([...this.#mine.values()].filter((c) => !c.waiting).length < concurrency) {
        claim.waiting = false
        return true
      }
      await new Promise<void>((resolve) => { this.#slotWaiters.add(resolve) })
    }
    return false
  }

  #freeSlot (): void {
    const waiters = [...this.#slotWaiters]
    this.#slotWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

// The poster's answer to question `n`, as its next message to the task.
// Its id is fixed by the claim and the question, so sending it again gets
// the task it already went to.
function answerMessage (job: JobRecord, claimAt: number, n: number, answer: string, task: Task): Message {
  return { role: 'ROLE_USER', messageId: `job-${job.id}-${claimAt}-answer-${n}`, taskId: task.id, contextId: task.contextId, parts: [{ text: answer }], metadata: { 'pai/job': job.id } }
}

function stopRenewing (claim: Claim): void {
  if (claim.renew) clearInterval(claim.renew)
  claim.renew = null
}

// What a finished task (or a stateless reply) reports to the board: its
// artifacts' text (or its status message's), and the task as reference.
function outcomeOf (res: Task | Message): Outcome {
  if (!('status' in res)) return { state: 'done', result: fit(partsText(res.parts)), ref: null }
  const text = taskResultText(res)
  if (res.status.state === 'TASK_STATE_COMPLETED') return { state: 'done', result: fit(text), ref: res.id }
  // Failed, canceled, or stopped for something nobody on the board can
  // give (auth-required, say: questions go to the poster, see #converse).
  const why = isTerminal(res.status.state) ? text : `${text}${text ? '\n' : ''}(stopped: ${res.status.state})`
  return { state: 'failed', result: fit(why), ref: res.id }
}

// "90 s", "2 h", "1 day".
function duration (ms: number): string {
  if (ms % DAY === 0) return `${ms / DAY} day${ms === DAY ? '' : 's'}`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`
  if (ms % 60_000 === 0) return `${ms / 60_000} min`
  return `${ms / 1000} s`
}

// Inline results are capped; past that, the task (ref) has it all.
function fit (text: string): string {
  if (Buffer.byteLength(text) <= MAX_JOB_RESULT) return text
  return Buffer.from(text).subarray(0, MAX_JOB_RESULT - 64).toString('utf-8').replace(/�+$/, '') + RESULT_CUT_NOTE
}
