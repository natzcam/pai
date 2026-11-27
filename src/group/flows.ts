// Workflows: a set of steps, each a job for a role or an agent (or a
// workflow of its own), where a step's text can use the workflow's input
// and the results of the steps it waits for. The group's rules run them:
// when a workflow starts, and whenever one of its jobs ends, apply posts
// the steps that are ready, so no member has to stay online to drive it,
// and every replica agrees on what runs next. Workers just see jobs
// (src/group/jobs.ts).

import { createHash } from 'node:crypto'
import { MAX_ATTACH, MIN_LEASE, RESULT_CUT_NOTE, dueAt, limitsProblem, postJob, specFits, isJobId, isJobTarget, isRulesJobId, putJob } from './jobs.js'
import type { JobLimits, JobRecord, JobSpec, JobView } from './jobs.js'

// A step can also set its job's limits (timeout, deadline from when it's
// posted, retries, backoff: see JobLimits). A step out of retries fails
// like any.
export interface FlowStep extends JobLimits {
  // Unique within the workflow: [a-z][a-z0-9_-]*, up to 32.
  name: string
  // Who may take the step's job: 'role:<role>', an identity, or anyone
  // (null). Required, except on a sub-workflow step, which has none.
  to?: string | null
  // The job's text (a sub-workflow step's: its workflow's input).
  // `{{input}}` is the workflow's input, `{{steps.<name>}}` the result of
  // an earlier step (one this step waits for), `{{prev.<name>}}` a step's
  // result in the last round of the repeat both are in ('' in the first).
  text: string
  // Steps that must be done first: only earlier ones, so there are no
  // cycles. Default none.
  after?: string[]
  lease?: number | null
  // Runs once per item of a list, in parallel: 'input' or 'steps.<name>'
  // (a step it waits for), as a JSON array (non-strings as JSON) or else
  // one item per non-empty line, up to MAX_ITEMS. `{{item}}` in the text
  // is the item.
  map?: string
  // Runs the same job this many times side by side (2 to MAX_COPIES);
  // `{{item}}` is the copy's number. For racing workers, or a vote.
  copies?: number
  // How a map or copies step ends (default 'all'):
  // - 'all': once every item is done; its result is their results as a
  //   JSON array, in order. An item that fails fails the step.
  // - 'first': once one is done, with its result; the rest are canceled.
  //   It fails once all have failed.
  // - { agree: k }: once k results are the same (trimmed, any case), with
  //   that result; the rest are canceled. It fails once k can't agree.
  settle?: Settle
  // Runs only if this holds of a step it waits for (else it's skipped):
  // that step's result `equals` or `contains` the text (trimmed, any case),
  // or that step `failed` (which then doesn't stop the workflow). `not`
  // turns the test around; a test of the result holds, either way, only
  // for a step that's done. Without it, a step runs once any step it waits for is
  // done (or at once, waiting for none), so it's skipped behind a branch
  // not taken, and a step after two branches runs after either.
  if?: FlowCondition
  // Runs the steps from `from` through this one again, until `until`
  // holds once they're all settled (it names one of them), for at most
  // `max` rounds in all; then the workflow goes on with the last round's
  // results. Steps after the loop wait for it to end. Repeats don't
  // overlap.
  repeat?: Repeat
  // A sub-workflow instead of a job: this workflow, or 'steps.<name>' (a
  // step it waits for, done) whose result is one, as JSON (a planner's).
  // Its input is this step's text, and its output this step's result;
  // it fails or is canceled with it. Workflows nest MAX_DEPTH deep.
  flow?: FlowSpec | string
}

export type Settle = 'all' | 'first' | { agree: number }

export interface Repeat {
  from: string
  until: FlowCondition
  max: number
}

export interface FlowCondition {
  step: string
  equals?: string
  contains?: string
  failed?: true
  not?: boolean
}

export interface FlowSpec {
  name?: string
  steps: FlowStep[]
}

export type FlowState = 'running' | 'done' | 'failed' | 'canceled'

export interface FlowRecord {
  // 16 bytes, hex. One a member started: random (first byte 00xxxxxx),
  // or from a start key (01xxxxxx, keyedFlowId). A sub-workflow or a
  // schedule's run: derived (top bit set).
  id: string
  // The identity that started it: its steps' jobs are posted as its.
  by: string
  name: string | null
  input: string
  steps: FlowStep[]
  state: FlowState
  // Each started step's job id (a map or copies step's names its result,
  // never a job: its items' are under "<step>#<i>"; a sub-workflow step's
  // is its workflow's id), and the steps done (their results are kept
  // apart: `flow-result/<id>/<step>`; readFlow puts them back). In a
  // repeat, the current round's.
  jobs: Record<string, string>
  done: string[]
  // Steps skipped (a condition that didn't hold, or a branch not taken),
  // and steps that failed where a step tests for it (their results kept
  // like any).
  skipped: string[]
  failed: string[]
  // Steps whose text had to be cut to fit in a job.
  cut: string[]
  // Map and copies steps once started: how many items, and how many are
  // done and failed.
  items?: Record<string, { n: number, done: number, failed?: number }>
  // Each repeat (by its last step): the round it's on (from 0), and
  // whether it's over.
  loops?: Record<string, { round: number, over: boolean }>
  // A sub-workflow: the workflow and step it runs for, and how deep.
  parent?: { id: string, step: string }
  depth?: number
  // A schedule's run: the schedule's name.
  schedule?: string
  // Once done: the final steps' result (the steps nothing waits for; with
  // more than one, each under its name). Once stopped: why.
  output: string | null
  // The step whose failure or cancel stopped it, if one did.
  stopped?: string
  at: number
  updated: number
}

// A workflow with its steps' results, as readers get it.
export type FlowView = FlowRecord & { results: Record<string, string> }

// A line about a workflow, for lists.
// `failed`: steps that failed on a branch (the workflow went on).
export interface FlowSummary { id: string, by: string, name: string | null, state: FlowState, steps: number, done: number, skipped: number, failed: number, parent: string | null, schedule: string | null, at: number, updated: number }

export function summarize (f: FlowRecord): FlowSummary {
  return { id: f.id, by: f.by, name: f.name, state: f.state, steps: f.steps.length, done: f.done.length, skipped: f.skipped.length, failed: f.failed.length, parent: f.parent?.id ?? null, schedule: f.schedule ?? null, at: f.at, updated: f.updated }
}

// A workflow the group starts by itself, every `every` ms from `start`
// (a time; default a period after it's set).
export interface Schedule {
  name: string
  flow: FlowSpec
  input: string
  every: number
  start?: number
}

export interface ScheduleRecord {
  name: string
  // Who set it: its runs are theirs.
  by: string
  flow: FlowSpec
  input: string
  every: number
  start: number
  // When it runs next, by the group's clock; how many times it has; and
  // its last run's workflow id.
  next: number
  runs: number
  last: string | null
  at: number
}

export type FlowOp =
  // With `key`, the id is keyedFlowId(group, author, key) (the rules check).
  | { type: 'flow.start', flow: { id: string, key?: string, name?: string, input: string, steps: FlowStep[] } }
  | { type: 'flow.cancel', id: string }
  | { type: 'schedule.set', schedule: Schedule }
  | { type: 'schedule.drop', name: string }

export const MAX_STEPS = 32
// The most items a map step runs, and copies a copies step.
export const MAX_ITEMS = 32
export const MAX_COPIES = 8
// The most rounds a repeat runs, and how deep workflows nest.
export const MAX_ROUNDS = 10
export const MAX_DEPTH = 3
// The largest workflow (as JSON, in bytes) and its input.
export const MAX_FLOW = 32 * 1024
export const MAX_FLOW_INPUT = 16 * 1024
// A start key's length, in bytes.
export const MAX_FLOW_KEY = 200

// The id of a workflow started with a key: from the group (its base's
// key, hex), the starter and the key, so a repeat start has the same id
// and the rules ignore it. Its first byte is 01xxxxxx: the rules' own ids
// have the top bit set, and members' random ids start 00, so nobody can
// take another member's keyed id first.
export function keyedFlowId (group: string, by: string, key: string): string {
  const raw = createHash('sha256').update(`pai flow key\0${group}\0${by}\0${key}`).digest().subarray(0, 16)
  raw[0] = (raw[0]! & 0x3f) | 0x40
  return raw.toString('hex')
}

export function isKeyedFlowId (id: string): boolean {
  const top = parseInt(id[0]!, 16)
  return top >= 4 && top < 8
}

export function isFlowKey (v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= MAX_FLOW_KEY
}
// How many ended workflows the group keeps (see jobs' MAX_ENDED_JOBS).
export const MAX_ENDED_FLOWS = 1000
// How many schedules a group keeps, and how often one may run.
export const MAX_SCHEDULES = 64
export const MIN_EVERY = 60_000
export const MAX_EVERY = 366 * 24 * 60 * 60 * 1000
const PRUNE_BATCH = 8

const own = (o: object, k: string): boolean => Object.hasOwn(o, k)
// Sets o[k] as an own property, whatever k is ('constructor', say).
const put = <T>(o: Record<string, T>, k: string, v: T): void => { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }) }

const STEP_NAME = /^[a-z][a-z0-9_-]{0,31}$/
const MAX_CONDITION = 1024
const REF = /\{\{\s*(input|item|steps\.([a-z][a-z0-9_-]{0,31})|prev\.([a-z][a-z0-9_-]{0,31}))\s*\}\}/g
const FROM_STEP = /^steps\.([a-z][a-z0-9_-]{0,31})$/
const LIMITS = ['timeout', 'deadline', 'retries', 'backoff'] as const

export function isFlowState (v: unknown): v is FlowState {
  return v === 'running' || v === 'done' || v === 'failed' || v === 'canceled'
}

// Why `spec` isn't a valid workflow, or null. `depth`: how deep it would
// run (0 for one a member starts).
export function flowProblem (spec: FlowSpec, depth = 0): string | null {
  if (typeof spec !== 'object' || spec === null || !Array.isArray(spec.steps)) return 'a workflow has steps: [...]'
  if (spec.name !== undefined && (typeof spec.name !== 'string' || spec.name.length > 200)) return 'name is text, up to 200 characters'
  if (spec.steps.length === 0 || spec.steps.length > MAX_STEPS) return `a workflow has 1 to ${MAX_STEPS} steps`
  const seen = new Set<string>()
  const loops: Array<{ from: number, to: number }> = []
  for (const [i, step] of spec.steps.entries()) {
    if (typeof step !== 'object' || step === null) return 'each step is an object'
    if (typeof step.name !== 'string' || !STEP_NAME.test(step.name)) return `step names are lowercase (a-z, 0-9, - and _), up to 32: ${String(step?.name)}`
    if (seen.has(step.name)) return `two steps are named ${step.name}`
    if (typeof step.text !== 'string' || step.text.length === 0) return `step ${step.name}: text is required`
    const after = step.after ?? []
    if (!Array.isArray(after) || !after.every((a) => typeof a === 'string' && seen.has(a))) return `step ${step.name}: after names only earlier steps`
    const problem = step.flow !== undefined ? subflowProblem(step, after, depth) : jobStepProblem(step, after)
    if (problem) return `step ${step.name}: ${problem}`
    if (step.if !== undefined) {
      const p = conditionProblem(step.if, after, 'if', 'a step it waits for (after)')
      if (p) return `step ${step.name}: ${p}`
    }
    for (const [, what, ref] of step.text.matchAll(REF)) {
      if (ref !== undefined && !after.includes(ref)) return `step ${step.name} uses {{steps.${ref}}} but doesn't wait for it (after)`
      if (what === 'item' && step.map === undefined && step.copies === undefined) return `step ${step.name} uses {{item}} but isn't a map or copies step`
    }
    if (step.repeat !== undefined) {
      const r = step.repeat
      if (typeof r !== 'object' || r === null) return `step ${step.name}: repeat is { from, until, max }`
      const from = spec.steps.findIndex((s) => s?.name === r.from)
      if (typeof r.from !== 'string' || from < 0 || from > i) return `step ${step.name}: repeat's from is this step or an earlier one`
      if (!Number.isInteger(r.max) || r.max < 2 || r.max > MAX_ROUNDS) return `step ${step.name}: repeat's max is 2 to ${MAX_ROUNDS} rounds`
      const p = conditionProblem(r.until, spec.steps.slice(from, i + 1).map((s) => s.name), 'until', 'a step in the repeat')
      if (p) return `step ${step.name}: ${p}`
      if (loops.some((l) => l.to >= from)) return `step ${step.name}: its repeat overlaps another`
      loops.push({ from, to: i })
    }
    seen.add(step.name)
  }
  // {{prev.<name>}}: only within one repeat.
  for (const [i, step] of spec.steps.entries()) {
    for (const [, , , prev] of step.text.matchAll(REF)) {
      if (prev === undefined) continue
      const j = spec.steps.findIndex((s) => s.name === prev)
      if (!loops.some((l) => l.from <= i && i <= l.to && l.from <= j && j <= l.to)) return `step ${step.name} uses {{prev.${prev}}}, but only a step in the same repeat can`
    }
  }
  if (Buffer.byteLength(JSON.stringify(spec)) > MAX_FLOW) return `a workflow is at most ${MAX_FLOW / 1024} KiB as JSON`
  return null
}

function jobStepProblem (step: FlowStep, after: string[]): string | null {
  if (step.to === undefined || (step.to !== null && !isJobTarget(step.to))) return 'to is role:<role>, an agent id, or null'
  if (step.lease !== undefined && step.lease !== null && !(Number.isInteger(step.lease) && step.lease >= MIN_LEASE)) return `lease is at least ${MIN_LEASE} ms`
  const limits = limitsProblem(step)
  if (limits) return limits
  if (step.map !== undefined) {
    const from = typeof step.map === 'string' ? FROM_STEP.exec(step.map)?.[1] : undefined
    if (step.map !== 'input' && (from === undefined || !after.includes(from))) return 'map is "input" or "steps.<name>" of a step it waits for'
    if (![...step.text.matchAll(REF)].some(([, what]) => what === 'item')) return 'it maps over items but its text has no {{item}}'
    if (step.copies !== undefined) return 'a step has map or copies, not both'
  }
  if (step.copies !== undefined && !(Number.isInteger(step.copies) && step.copies >= 2 && step.copies <= MAX_COPIES)) return `copies is 2 to ${MAX_COPIES}`
  if (step.settle !== undefined) {
    if (step.map === undefined && step.copies === undefined) return 'settle is for a map or copies step'
    const s = step.settle
    const most = step.copies ?? MAX_ITEMS
    const agree = typeof s === 'object' && s !== null && Object.keys(s).length === 1 && Number.isInteger(s.agree) && s.agree >= 2 && s.agree <= most
    if (s !== 'all' && s !== 'first' && !agree) return `settle is "all", "first" or { agree: 2 to ${most} }`
  }
  return null
}

function subflowProblem (step: FlowStep, after: string[], depth: number): string | null {
  if (step.to !== undefined || step.lease !== undefined || step.map !== undefined || step.copies !== undefined || step.settle !== undefined || LIMITS.some((k) => step[k] !== undefined)) {
    return 'a sub-workflow step has no to, lease, limits, map, copies or settle'
  }
  if (typeof step.flow === 'string') {
    const from = FROM_STEP.exec(step.flow)?.[1]
    return from !== undefined && after.includes(from) ? null : 'flow is a workflow, or "steps.<name>" of a step it waits for'
  }
  if (depth + 1 > MAX_DEPTH) return `workflows nest at most ${MAX_DEPTH} deep`
  const p = flowProblem(step.flow!, depth + 1)
  return p ? `its workflow: ${p}` : null
}

function conditionProblem (c: FlowCondition, names: string[], what: string, among: string): string | null {
  if (typeof c !== 'object' || c === null) return `${what} is { step, equals | contains | failed, not? }`
  if (typeof c.step !== 'string' || !names.includes(c.step)) return `${what} names ${among}`
  const tests = [c.equals !== undefined, c.contains !== undefined, c.failed !== undefined].filter(Boolean).length
  if (tests !== 1) return `${what} has one of equals, contains or failed`
  for (const t of [c.equals, c.contains]) {
    if (t !== undefined && (typeof t !== 'string' || Buffer.byteLength(t) > MAX_CONDITION)) return `${what}'s text is up to ${MAX_CONDITION} bytes`
  }
  if (c.contains !== undefined && fold(c.contains) === '') return `${what} contains: some text (not only spaces)`
  if (c.failed !== undefined && c.failed !== true) return `${what} failed: true`
  if (c.not !== undefined && typeof c.not !== 'boolean') return `${what} not: true or false`
  return null
}

// Who a workflow's steps are for, its sub-workflows' too: what the
// policy has to let its starter post for.
export function flowTargets (spec: FlowSpec): Array<string | null> {
  return flowTargetSteps(spec).map((t) => t.to)
}

// The same, with each step's path (a sub-workflow's as "<step>/<its step>").
export function flowTargetSteps (spec: FlowSpec, where = ''): Array<{ step: string, to: string | null }> {
  return spec.steps.flatMap((s) => {
    const step = where ? `${where}/${s.name}` : s.name
    if (typeof s.flow === 'object') return flowTargetSteps(s.flow, step)
    return s.flow !== undefined ? [] : [{ step, to: s.to ?? null }]
  })
}

// Why `s` isn't a valid schedule, or null.
export function scheduleProblem (s: Schedule): string | null {
  if (typeof s !== 'object' || s === null) return 'a schedule is { name, flow, input, every, start? }'
  if (typeof s.name !== 'string' || !STEP_NAME.test(s.name)) return 'a schedule\'s name is lowercase (a-z, 0-9, - and _), up to 32'
  if (typeof s.input !== 'string' || Buffer.byteLength(s.input) > MAX_FLOW_INPUT) return `a schedule's input is text, up to ${MAX_FLOW_INPUT / 1024} KiB`
  if (!Number.isInteger(s.every) || s.every < MIN_EVERY || s.every > MAX_EVERY) return 'every is 1 minute to 366 days, in ms'
  if (s.start !== undefined && !(Number.isSafeInteger(s.start) && s.start >= 0)) return 'start is a time, in ms'
  const p = flowProblem(s.flow)
  return p ? `its workflow: ${p}` : null
}

export function parseFlowOp (v: Record<string, any>): FlowOp | null {
  switch (v.type) {
    case 'flow.start': {
      const f = v.flow
      // The top bit clear (set: the rules' own); 01xxxxxx exactly when keyed.
      if (typeof f !== 'object' || f === null || !isJobId(f.id) || isRulesJobId(f.id)) return null
      if (f.key !== undefined ? !isFlowKey(f.key) || !isKeyedFlowId(f.id) : isKeyedFlowId(f.id)) return null
      if (typeof f.input !== 'string' || Buffer.byteLength(f.input) > MAX_FLOW_INPUT) return null
      return flowProblem({ ...(f.name !== undefined ? { name: f.name } : {}), steps: f.steps }) === null ? v as FlowOp : null
    }
    case 'flow.cancel':
      return isJobId(v.id) ? v as FlowOp : null
    case 'schedule.set':
      return scheduleProblem(v.schedule) === null ? v as FlowOp : null
    case 'schedule.drop':
      return typeof v.name === 'string' && STEP_NAME.test(v.name) ? v as FlowOp : null
    default:
      return null
  }
}

// A step's job id: fixed by the workflow and the step, so every replica
// posts the same job.
// The top bit is set: no member's job.post can use it (see isRulesJobId).
export function stepJobId (flow: string, step: string): string {
  return rulesId(`pai/flow/${flow}/${step}`)
}

function rulesId (name: string): string {
  const h = createHash('sha256').update(name).digest('hex').slice(0, 32)
  return (parseInt(h[0]!, 16) | 8).toString(16) + h.slice(1)
}

// A step's key in a round of its repeat: what its ids are derived from.
// Round 0's is the name alone.
export function roundKey (step: string, round: number): string {
  return round > 0 ? `${step}@${round}` : step
}

const CUT_NOTE = '\n…(cut to fit in a job)'

// Fills in a step's text from the workflow's input and results, as a job's
// spec. A result goes inline if it fits; one the worker had to cut, and
// the biggest while the text is too big, are attached instead (by their step's
// job, `jobOf`: the worker reads them whole from their tasks). If even
// that's too big, the text is cut, and says so. `context`: the spec's.
// `prev`: the last round's results, for {{prev.<name>}} (inline only).
export function render (text: string, input: string, results: Record<string, string>, opts: { jobOf?: (step: string) => string, context?: string, item?: string, prev?: Record<string, string> } = {}): { spec: JobSpec, cut: boolean } {
  const { jobOf, context, item = '', prev = {} } = opts
  const refs = [...new Set([...text.matchAll(REF)].flatMap((m) => m[2] !== undefined && own(results, m[2]) && results[m[2]] !== '' ? [m[2]] : []))]
  const specOf = (t: string, attached: Set<string>): JobSpec => ({
    text: t,
    ...(attached.size && jobOf ? { attach: [...attached].map(jobOf) } : {}),
    ...(context ? { context } : {})
  })
  const fill = (attached: Set<string>): string => text.replace(REF, (_, what: string, step?: string, last?: string) => {
    if (what === 'item') return item
    if (last !== undefined) return own(prev, last) ? prev[last]! : ''
    if (step === undefined) return input
    if (!own(results, step)) return ''
    return attached.has(step) ? `[the result of step ${step}: attached]` : results[step]!
  })
  let attached: Set<string> = new Set(jobOf ? refs.filter((r) => wasCut(results[r]!)).slice(0, MAX_ATTACH) : [])
  let out = fill(attached)
  // Then the biggest, one by one, until the text fits.
  for (const r of jobOf ? [...refs].sort((a, b) => results[b]!.length - results[a]!.length) : []) {
    if (specFits(specOf(out, attached)) || attached.size >= MAX_ATTACH) break
    if (attached.has(r)) continue
    attached = new Set([...attached, r])
    out = fill(attached)
  }
  const fits = (t: string): boolean => specFits(specOf(t, attached))
  if (fits(out)) return { spec: specOf(out, attached), cut: false }
  let lo = 0
  let hi = out.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(out.slice(0, mid) + CUT_NOTE)) lo = mid
    else hi = mid - 1
  }
  return { spec: specOf(out.slice(0, lo).replace(/[\uD800-\uDBFF]$/, '') + CUT_NOTE, attached), cut: true }
}

// Whether a result was cut by its worker: a step's own, or any item's in
// a map step's JSON array.
const CUT_IN_JSON = JSON.stringify(RESULT_CUT_NOTE).slice(1, -1)
function wasCut (result: string): boolean {
  return result.endsWith(RESULT_CUT_NOTE) || result.includes(CUT_IN_JSON)
}

// A map step's items: the elements of a JSON array (non-strings as JSON),
// found as the whole text or as the text from its first '[' to its last
// ']' (so a reply in a code block, or with a line before it, still
// counts); or else the lines, without list markers. Blank items are left
// out either way.
export function itemsOf (text: string): string[] {
  const t = text.trim()
  const from = t.indexOf('[')
  const to = t.lastIndexOf(']')
  for (const candidate of from >= 0 && to > from ? [t, t.slice(from, to + 1)] : [t]) {
    try {
      const v: unknown = JSON.parse(candidate)
      if (Array.isArray(v)) return v.map((x) => typeof x === 'string' ? x.trim() : JSON.stringify(x)).filter(Boolean)
    } catch {}
  }
  return t.split('\n').map((l) => l.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim()).filter((l) => l !== '' && !/^```/.test(l))
}

// A workflow written by a step (a planner's): JSON, as the whole text or
// from its first '{' to its last '}' (a reply in a code block counts); a
// bare array of steps counts too. Else why not.
export function specOf (text: string): FlowSpec | string {
  const t = text.trim()
  const candidates = [t]
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const from = t.indexOf(open)
    const to = t.lastIndexOf(close)
    if (from >= 0 && to > from) candidates.push(t.slice(from, to + 1))
  }
  // A workflow ({ steps }) or a bare array of steps, whichever slice
  // holds one: a lone step's braces alone aren't a workflow.
  let other: FlowSpec | null = null
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c)
      if (Array.isArray(v)) return { steps: v as FlowStep[] }
      if (typeof v === 'object' && v !== null) {
        if (Object.hasOwn(v, 'steps')) return v as FlowSpec
        other ??= v as FlowSpec
      }
    } catch {}
  }
  return other ?? 'it isn\'t a workflow as JSON'
}

// The context a workflow's jobs run in: a worker that keeps a
// conversation per context sees the steps it ran before (and a repeat's
// earlier rounds). A map or copies step's items each get their own, so
// they stay independent (and can run side by side on one worker).
export function flowContext (id: string, item?: { step: string, i: number, round?: number }): string {
  if (!item) return `flow-${id}`
  return `item-${createHash('sha256').update(`${id}/${roundKey(item.step, item.round ?? 0)}#${item.i}`).digest('hex').slice(0, 32)}`
}

// Folds a workflow op by `author` (a current member) into the view.
// Whether the group's policy lets `by` post a job for `to` now (state.ts).
export type MayPost = (by: string, to: string | null) => Promise<boolean>
const anyPost: MayPost = async () => true

export async function applyFlowOp (op: FlowOp & { at: number }, author: string, view: JobView, admin: boolean, mayPost: MayPost = anyPost): Promise<void> {
  switch (op.type) {
    case 'flow.start':
      // A key starts one run, ever: its marker outlasts the run's pruning,
      // so a late repeat can't start a second under the same id.
      if (op.flow.key !== undefined) {
        if (await view.get(`flow-key/${op.flow.id}`) !== null) return
        await view.put(`flow-key/${op.flow.id}`, op.at)
      }
      await startFlow(view, { id: op.flow.id, by: author, name: op.flow.name ?? null, input: op.flow.input, steps: op.flow.steps }, op.at, mayPost)
      return
    case 'flow.cancel': {
      const flow = (await view.get(`flow/${op.id}`))?.value as FlowRecord | undefined
      if (!flow) return
      if (flow.state !== 'running' || (flow.by !== author && !admin)) return
      await stop(view, { ...flow, state: 'canceled', output: 'canceled', updated: op.at }, op.at, mayPost)
      return
    }
    case 'schedule.set': {
      // A new one, while there's room; another's, only by an admin.
      const s = op.schedule
      const existing = (await view.get(`schedule/${s.name}`))?.value as ScheduleRecord | undefined
      if (existing && existing.by !== author && !admin) return
      if (!existing && await countSchedules(view) >= MAX_SCHEDULES) return
      const start = s.start ?? op.at + s.every
      const next = nextRun(start, s.every, op.at)
      await view.put(`schedule/${s.name}`, { name: s.name, by: author, flow: s.flow, input: s.input, every: s.every, start, next, runs: existing?.runs ?? 0, last: existing?.last ?? null, at: op.at } satisfies ScheduleRecord)
      await dueAt(view, next, s.name, 'schedule')
      return
    }
    case 'schedule.drop': {
      const existing = (await view.get(`schedule/${op.name}`))?.value as ScheduleRecord | undefined
      if (existing && (existing.by === author || admin)) await view.del(`schedule/${op.name}`)
    }
  }
}

// The first run of a schedule at or after `from`.
function nextRun (start: number, every: number, from: number): number {
  return start >= from ? start : start + every * Math.ceil((from - start) / every)
}

async function countSchedules (view: Pick<JobView, 'createReadStream'>): Promise<number> {
  let n = 0
  for await (const _ of view.createReadStream({ gt: 'schedule/', lt: 'schedule0' })) n++
  return n
}

export async function readSchedules (view: Pick<JobView, 'createReadStream'>): Promise<ScheduleRecord[]> {
  const out: ScheduleRecord[] = []
  for await (const { value } of view.createReadStream({ gt: 'schedule/', lt: 'schedule0' })) out.push(value as ScheduleRecord)
  return out
}

// A schedule's run, due at `due` (swept once the group's clock is past
// it): its workflow starts, unless its last run is still going (runs
// don't pile up), and its next is set. One whose setter has left the
// group goes.
export async function runSchedule (view: JobView, name: string, due: number, clock: number, mayPost: MayPost = anyPost): Promise<void> {
  const rec = (await view.get(`schedule/${name}`))?.value as ScheduleRecord | undefined
  if (!rec || rec.next !== due) return
  if (!await stillMember(view, rec.by, clock)) {
    await view.del(`schedule/${name}`)
    return
  }
  const next = nextRun(rec.start, rec.every, clock + 1)
  const last = rec.last ? (await view.get(`flow/${rec.last}`))?.value as FlowRecord | undefined : undefined
  const busy = last?.state === 'running'
  const id = busy ? rec.last : rulesId(`pai/schedule/${name}/${rec.at}/${rec.runs}`)
  await view.put(`schedule/${name}`, { ...rec, next, runs: busy ? rec.runs : rec.runs + 1, last: id } satisfies ScheduleRecord)
  await dueAt(view, next, name, 'schedule')
  if (!busy) await startFlow(view, { id: id!, by: rec.by, name: rec.flow.name ?? name, input: rec.input, steps: rec.flow.steps, schedule: name }, clock, mayPost)
}

type NewFlow = Pick<FlowRecord, 'id' | 'by' | 'name' | 'input' | 'steps'> & Partial<Pick<FlowRecord, 'parent' | 'depth' | 'schedule'>>

async function startFlow (view: JobView, f: NewFlow, at: number, mayPost: MayPost): Promise<void> {
  if (await view.get(`flow/${f.id}`) !== null) return
  const flow: FlowRecord = { ...f, state: 'running', jobs: {}, done: [], skipped: [], failed: [], cut: [], output: null, at, updated: at }
  await advance(view, flow, at, mayPost)
}

// A workflow with its results.
export async function readFlow (view: Pick<JobView, 'get' | 'createReadStream'>, id: string): Promise<FlowView | null> {
  const rec = (await view.get(`flow/${id}`))?.value as FlowRecord | undefined
  if (!rec) return null
  return { ...rec, results: await readPrefix(view, `flow-result/${id}/`) }
}

// The keys under `prefix` (one ending '/'), by the rest of their key.
async function readPrefix (view: Pick<JobView, 'createReadStream'>, prefix: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for await (const { key, value } of view.createReadStream({ gt: prefix, lt: `${prefix.slice(0, -1)}0` })) {
    put(out, key.slice(prefix.length), value as string)
  }
  return out
}

// Told that a job ended: moves its workflow on, if it's one's step.
export async function flowJobEnded (view: JobView, job: JobRecord, at: number, mayPost: MayPost = anyPost): Promise<void> {
  if (!job.flow) return
  const flow = (await view.get(`flow/${job.flow.id}`))?.value as FlowRecord | undefined
  if (!flow) return
  const step = job.flow.step
  const item = job.flow.item
  const key = item === undefined ? step : itemKey(step, item)
  // Only the current round's job counts.
  if (flow.state !== 'running' || !own(flow.jobs, key) || flow.jobs[key] !== job.id) return
  if (item !== undefined) return await itemEnded(view, flow, job, step, item, at, mayPost)
  if (job.state === 'done') {
    await view.put(`flow-result/${flow.id}/${step}`, job.result ?? '')
    await advance(view, { ...flow, done: [...flow.done, step], updated: at }, at, mayPost)
    return
  }
  await stepLost(view, flow, step, job.state === 'canceled' ? null : job.result ?? '', at, mayPost)
}

// A sub-workflow ended: its step is done with its output, or lost.
async function childEnded (view: JobView, child: FlowRecord, at: number, mayPost: MayPost): Promise<void> {
  if (!child.parent) return
  const parent = (await view.get(`flow/${child.parent.id}`))?.value as FlowRecord | undefined
  const step = child.parent.step
  if (!parent || parent.state !== 'running' || !own(parent.jobs, step) || parent.jobs[step] !== child.id) return
  if (child.state === 'done') {
    await view.put(`flow-result/${parent.id}/${step}`, child.output ?? '')
    await advance(view, { ...parent, done: [...parent.done, step], updated: at }, at, mayPost)
    return
  }
  await stepLost(view, parent, step, child.state === 'canceled' ? null : child.output ?? 'failed', at, mayPost)
}

// A map or copies step's item ended: the step is done or lost once its
// `settle` says so.
async function itemEnded (view: JobView, flow: FlowRecord, job: JobRecord, step: string, item: number, at: number, mayPost: MayPost): Promise<void> {
  const m = flow.items?.[step]
  const def = flow.steps.find((s) => s.name === step)
  if (!m || !def) return
  const settle = def.settle ?? 'all'
  const prefix = `flow-item/${flow.id}/${step}/`
  const counts = (done: number, failed: number): Record<string, { n: number, done: number, failed?: number }> => ({ ...flow.items, [step]: { n: m.n, done, ...(failed ? { failed } : {}) } })
  // The step's result: the rest of its items stop.
  const settled = async (result: string, done: number, failed: number): Promise<void> => {
    await cancelItems(view, flow, step, m.n, at)
    await dropItems(view, flow.id, step)
    await view.put(`flow-result/${flow.id}/${step}`, result)
    await advance(view, { ...flow, items: counts(done, failed), done: [...flow.done, step], updated: at }, at, mayPost)
  }
  const lost = async (why: string | null, what?: string): Promise<void> => {
    await cancelItems(view, flow, step, m.n, at)
    await dropItems(view, flow.id, step)
    await stepLost(view, flow, step, why, at, mayPost, what)
  }
  // With { agree }, whether k can still agree (`top`: the most that
  // agree so far, if counted); else the step fails.
  const undecided = async (done: number, failed: number, top?: number): Promise<void> => {
    if (typeof settle === 'object') {
      top ??= (await tally(view, prefix))[0]?.count ?? 0
      if (top + (m.n - done - failed) < settle.agree) return await lost(`no ${settle.agree} of ${m.n} agreed`)
    } else if (settle === 'first' && done + failed >= m.n) {
      return await lost(`all ${m.n} failed; the last: ${job.result ?? 'failed'}`)
    }
    await view.put(`flow/${flow.id}`, { ...flow, items: counts(done, failed), updated: at })
  }
  const failed = m.failed ?? 0
  if (job.state === 'done') {
    const done = m.done + 1
    if (settle === 'first') return await settled(job.result ?? '', done, failed)
    await view.put(`${prefix}${String(item).padStart(4, '0')}`, job.result ?? '')
    if (typeof settle === 'object') {
      const top = (await tally(view, prefix))[0]
      if (top && top.count >= settle.agree) return await settled(top.text, done, failed)
      return await undecided(done, failed, top?.count ?? 0)
    }
    if (done < m.n) {
      await view.put(`flow/${flow.id}`, { ...flow, items: counts(done, failed), updated: at })
      return
    }
    const results: string[] = []
    for await (const { value } of view.createReadStream({ gt: prefix, lt: `flow-item/${flow.id}/${step}0` })) results.push(value as string)
    return await settled(JSON.stringify(results), done, failed)
  }
  const what = `item ${item + 1} of ${m.n}`
  if (job.state === 'canceled') return await lost(null, what)
  if (settle === 'all') return await lost(`${what}: ${job.result ?? 'failed'}`, what)
  await undecided(m.done, failed + 1)
}

// A map or copies step's results so far, grouped as conditions compare
// them, most first (ties: the first to come, in item order).
async function tally (view: Pick<JobView, 'createReadStream'>, prefix: string): Promise<Array<{ text: string, count: number }>> {
  const groups = new Map<string, { text: string, count: number }>()
  for await (const { value } of view.createReadStream({ gt: prefix, lt: `${prefix.slice(0, -1)}0` })) {
    const k = fold(value as string)
    const g = groups.get(k)
    if (g) g.count++
    else groups.set(k, { text: value as string, count: 1 })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

// Cancels a map or copies step's items still open or claimed.
async function cancelItems (view: JobView, flow: FlowRecord, step: string, n: number, at: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const id = flow.jobs[itemKey(step, i)]
    const other = id ? (await view.get(`job/${id}`))?.value as JobRecord | undefined : undefined
    if (other && (other.state === 'open' || other.state === 'claimed')) await putJob(view, other, { ...other, state: 'canceled', updated: at })
  }
}

// Whether a failure of `step` is one the workflow goes on from: a step
// runs on it, or a repeat tests for it: one that ends on it, or one that
// goes round again on it with rounds left (on its last round, a failure
// it was retrying is the workflow's).
function branchesOnFailure (flow: Pick<FlowRecord, 'steps' | 'loops'>, step: string): boolean {
  return flow.steps.some((s) => {
    if (s.if?.step === step && s.if.failed === true && s.if.not !== true) return true
    const u = s.repeat?.until
    return u?.step === step && u.failed === true && (u.not !== true || (flow.loops?.[s.name]?.round ?? 0) + 1 < s.repeat!.max)
  })
}

// A step that failed (`why`; null: canceled): a branch if the workflow
// goes on from it, else the end of the workflow.
async function stepLost (view: JobView, flow: FlowRecord, step: string, why: string | null, at: number, mayPost: MayPost, what?: string): Promise<void> {
  if (why !== null && branchesOnFailure(flow, step)) {
    await view.put(`flow-result/${flow.id}/${step}`, why)
    await advance(view, { ...flow, failed: [...flow.failed, step], updated: at }, at, mayPost)
    return
  }
  const output = why === null ? `step ${step}${what ? ` (${what})` : ''} was canceled` : `step ${step} failed${why ? `: ${why}` : ''}`
  await stop(view, { ...flow, state: why === null ? 'canceled' : 'failed', output, stopped: step, updated: at }, at, mayPost)
}

// Drops a map step's item results, once its own result (or failure) has
// them.
async function dropItems (view: JobView, flow: string, step: string): Promise<void> {
  const keys: string[] = []
  for await (const { key } of view.createReadStream({ gt: `flow-item/${flow}/${step}/`, lt: `flow-item/${flow}/${step}0` })) keys.push(key)
  for (const key of keys) await view.del(key)
}

// A map step's item, as a key of FlowRecord.jobs.
function itemKey (step: string, item: number): string {
  return `${step}#${item}`
}

// Whether a step is settled: done, failed on a branch, or skipped.
function isSettled (f: Pick<FlowRecord, 'done' | 'failed' | 'skipped'>, name: string): boolean {
  return f.done.includes(name) || f.failed.includes(name) || f.skipped.includes(name)
}

// A repeat: its last step (that has `repeat`) and its steps, in order.
export interface Loop { end: string, names: string[], repeat: Repeat }

export function loopsOf (steps: FlowStep[]): Loop[] {
  return steps.flatMap((s, i) => s.repeat ? [{ end: s.name, names: steps.slice(steps.findIndex((x) => x.name === s.repeat!.from), i + 1).map((x) => x.name), repeat: s.repeat }] : [])
}

// Posts every step that's ready and not yet posted, as long as its starter
// is still a member, and settles repeats whose round is over; ends the
// workflow once every step is settled. The policy is checked as each step
// is posted (it may have changed since the start): a step it refuses
// fails the workflow.
async function advance (view: JobView, flow: FlowRecord, at: number, mayPost: MayPost): Promise<void> {
  if (flow.state !== 'running') return
  if (!await stillMember(view, flow.by, at)) {
    await stop(view, { ...flow, state: 'failed', output: 'its starter is no longer a member', updated: at }, at, mayPost)
    return
  }
  const w: Working = { ...flow, jobs: { ...flow.jobs }, cut: [...flow.cut], skipped: [...flow.skipped], done: [...flow.done], failed: [...flow.failed], items: { ...flow.items }, loops: { ...flow.loops } }
  const loops = loopsOf(flow.steps)
  const results = await readPrefix(view, `flow-result/${flow.id}/`)
  const prev = loops.length ? await readPrefix(view, `flow-prev/${flow.id}/`) : {}
  for (;;) {
    if (await postReady(view, w, loops, results, prev, at, mayPost) === 'elsewhere') return
    if (!await nextRounds(view, w, loops, results, prev)) break
  }
  const next = tidy(w)
  if (w.steps.every((s) => isSettled(w, s.name)) && loops.every((l) => w.loops[l.end]?.over === true)) {
    await end(view, { ...next, state: 'done', output: finalOutput(next, results), updated: at }, mayPost)
    return
  }
  await view.put(`flow/${flow.id}`, next)
}

// A workflow being advanced: its optional maps there to change.
type Working = FlowRecord & { items: NonNullable<FlowRecord['items']>, loops: NonNullable<FlowRecord['loops']> }

function tidy (w: Working): FlowRecord {
  const { items, loops, ...rest } = w
  return { ...rest, ...(Object.keys(items).length ? { items } : {}), ...(Object.keys(loops).length ? { loops } : {}) }
}

// One pass over the steps, in order (a step waits only for earlier ones,
// so one pass settles every skip), posting those that are ready.
// 'elsewhere': the workflow was written and moved on (or stopped) by
// another path; this pass's caller is done.
async function postReady (view: JobView, w: Working, loops: Loop[], results: Record<string, string>, prev: Record<string, string>, at: number, mayPost: MayPost): Promise<'ok' | 'elsewhere'> {
  const loopOf = (name: string): Loop | undefined => loops.find((l) => l.names.includes(name))
  // A step in a repeat is settled for a step outside it once it's over.
  const settledFor = (name: string, asker: string): boolean => {
    if (!isSettled(w, name)) return false
    const l = loopOf(name)
    return l === undefined || l === loopOf(asker) || w.loops[l.end]?.over === true
  }
  const jobOf = (name: string): string => own(w.jobs, name) ? w.jobs[name]! : stepJobId(w.id, name)
  const fail = async (step: string, output: string): Promise<'elsewhere'> => {
    await stop(view, { ...tidy(w), state: 'failed', output, stopped: step, updated: at }, at, mayPost)
    return 'elsewhere'
  }
  for (const step of w.steps) {
    if (own(w.jobs, step.name) || isSettled(w, step.name)) continue
    if (!(step.after ?? []).every((a) => settledFor(a, step.name))) continue
    // A map or planned step runs over a step that's done (not one that
    // failed on a branch: its result is why).
    const source = step.map !== undefined && step.map !== 'input' ? step.map.slice('steps.'.length) : typeof step.flow === 'string' ? step.flow.slice('steps.'.length) : null
    if (!runs(step, w.done, w.failed, results) || (source !== null && !w.done.includes(source))) {
      w.skipped.push(step.name)
      continue
    }
    const l = loopOf(step.name)
    const round = l ? w.loops[l.end]?.round ?? 0 : 0
    const key = roundKey(step.name, round)

    if (step.flow !== undefined) {
      const depth = (w.depth ?? 0) + 1
      const spec = typeof step.flow === 'object' ? step.flow : specOf(own(results, source!) ? results[source!]! : '')
      const problem = typeof spec === 'string' ? spec : depth > MAX_DEPTH ? `workflows nest at most ${MAX_DEPTH} deep` : flowProblem(spec, depth)
      if (problem !== null) {
        // A plan that isn't a workflow fails its step.
        const why = `the workflow from step ${source!} won't run: ${problem}`
        if (!branchesOnFailure(w, step.name)) return await fail(step.name, `step ${step.name} failed: ${why}`)
        await view.put(`flow-result/${w.id}/${step.name}`, why)
        put(results, step.name, why)
        w.failed.push(step.name)
        continue
      }
      const child = (spec as FlowSpec)
      const id = stepJobId(w.id, key)
      put(w.jobs, step.name, id)
      const input = render(step.text, w.input, results, { prev })
      if (input.cut && !w.cut.includes(step.name)) w.cut.push(step.name)
      // Written first: the sub-workflow may end at once, and move this
      // one on from what's stored.
      await view.put(`flow/${w.id}`, tidy(w))
      await startFlow(view, { id, by: w.by, name: child.name ?? step.name, input: input.spec.text, steps: child.steps, parent: { id: w.id, step: step.name }, depth }, at, mayPost)
      // Ended at once: its end moved this workflow on already.
      if (((await view.get(`flow/${id}`))?.value as FlowRecord | undefined)?.state !== 'running') return 'elsewhere'
      continue
    }

    if (!await mayPost(w.by, step.to ?? null)) return await fail(step.name, `the group's policy doesn't let its starter post step ${step.name} for ${step.to ?? 'anyone'}`)
    // A map or copies step's own id is never a job's: it names its result.
    put(w.jobs, step.name, stepJobId(w.id, key))
    const list = step.map !== undefined
      ? itemsOf(source === null ? w.input : own(results, source) ? results[source]! : '')
      : step.copies !== undefined ? Array.from({ length: step.copies }, (_, i) => String(i + 1)) : [null]
    if (list.length > MAX_ITEMS) return await fail(step.name, `step ${step.name} has ${list.length} items: a map step takes at most ${MAX_ITEMS}`)
    if (step.map !== undefined || step.copies !== undefined) {
      put(w.items, step.name, { n: list.length, done: 0 })
      if (list.length === 0) {
        await view.put(`flow-result/${w.id}/${step.name}`, '[]')
        put(results, step.name, '[]')
        w.done.push(step.name)
        continue
      }
    }
    for (const [i, item] of list.entries()) {
      const id = item === null ? stepJobId(w.id, key) : stepJobId(w.id, itemKey(key, i))
      if (item !== null) put(w.jobs, itemKey(step.name, i), id)
      const text = render(step.text, w.input, results, {
        jobOf,
        context: flowContext(w.id, item === null ? undefined : { step: step.name, i, round }),
        prev,
        ...(item !== null ? { item } : {})
      })
      if (text.cut && !w.cut.includes(step.name)) w.cut.push(step.name)
      await postJob(view, {
        id,
        by: w.by,
        spec: text.spec,
        to: step.to ?? null,
        lease: step.lease ?? null,
        state: 'open',
        claim: null,
        result: null,
        ref: null,
        at,
        updated: at,
        flow: { id: w.id, step: step.name, ...(item !== null ? { item: i } : {}), ...(round > 0 ? { round } : {}) }
      }, step)
    }
  }
  return 'ok'
}

// Repeats whose steps are all settled: over, if `until` holds or that was
// the last round; else their steps start over, with this round's results
// kept for {{prev.<name>}}. Whether any changed.
async function nextRounds (view: JobView, w: Working, loops: Loop[], results: Record<string, string>, prev: Record<string, string>): Promise<boolean> {
  let changed = false
  for (const l of loops) {
    const state = w.loops[l.end] ?? { round: 0, over: false }
    if (state.over || !l.names.every((n) => isSettled(w, n))) continue
    changed = true
    // Over too when none of its steps ran (behind a branch not taken):
    // another round would only skip them again.
    const ran = l.names.some((n) => w.done.includes(n) || w.failed.includes(n))
    if (!ran || holds(l.repeat.until, w.done, w.failed, results) || state.round + 1 >= l.repeat.max) {
      put(w.loops, l.end, { ...state, over: true })
      continue
    }
    for (const name of l.names) {
      if (own(results, name)) {
        await view.put(`flow-prev/${w.id}/${name}`, results[name])
        put(prev, name, results[name]!)
        await view.del(`flow-result/${w.id}/${name}`)
        delete results[name]
      } else if (own(prev, name)) {
        await view.del(`flow-prev/${w.id}/${name}`)
        delete prev[name]
      }
      for (const k of Object.keys(w.jobs)) if (k === name || k.startsWith(`${name}#`)) delete w.jobs[k]
      delete w.items[name]
      for (const list of [w.done, w.skipped, w.failed, w.cut]) {
        const at = list.indexOf(name)
        if (at >= 0) list.splice(at, 1)
      }
    }
    put(w.loops, l.end, { round: state.round + 1, over: false })
  }
  return changed
}

// Whether a step whose steps are all settled runs (see FlowStep.if).
function runs (step: FlowStep, done: string[], failed: string[], results: Record<string, string>): boolean {
  const after = step.after ?? []
  if (step.if === undefined) return after.length === 0 || after.some((a) => done.includes(a))
  return holds(step.if, done, failed, results)
}

// Whether a test holds. Only a step that ran (done, or failed on a
// branch) passes a test, or its `not`: behind a skipped one, nothing runs.
function holds (c: FlowCondition, done: string[], failed: string[], results: Record<string, string>): boolean {
  if (c.failed === true) return (done.includes(c.step) || failed.includes(c.step)) && failed.includes(c.step) !== (c.not === true)
  if (!done.includes(c.step)) return false
  return resultMeets(c, own(results, c.step) ? results[c.step]! : '')
}

// Whether a done step's result passes an equals or contains test (with
// its `not`). Apps use it too, to say what a result would start.
export function resultMeets (c: FlowCondition, result: string): boolean {
  const r = fold(result)
  const match = c.equals !== undefined ? r === fold(c.equals) : r.includes(fold(c.contains ?? ''))
  return match !== (c.not === true)
}

// Text as conditions compare it: trimmed, in lower case. ASCII only, so
// every replica folds alike whatever Unicode version its runtime has.
function fold (text: string): string {
  return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').replace(/[A-Z]/g, (ch) => ch.toLowerCase())
}

// The result of the final steps that ran: done, with no done step waiting
// for them (so a run that ends on a branch not taken keeps its last
// result). One alone as it is, several each under its name.
function finalOutput (flow: FlowRecord, results: Record<string, string>): string {
  const ran = flow.steps.filter((s) => flow.done.includes(s.name))
  // A step that failed on a branch ran too: what it waited for isn't final.
  const failed = flow.failed
  const waitedFor = new Set(flow.steps.filter((s) => flow.done.includes(s.name) || failed.includes(s.name)).flatMap((s) => s.after ?? []))
  const result = (name: string): string => own(results, name) ? results[name]! : ''
  const sinks = ran.filter((s) => !waitedFor.has(s.name))
  if (sinks.length === 1) return result(sinks[0]!.name)
  return sinks.map((s) => `## ${s.name}\n${result(s.name)}`).join('\n\n')
}

// Whether `id` is still a member (not lapsed at `at`), or an admin.
async function stillMember (view: Pick<JobView, 'get'>, id: string, at: number): Promise<boolean> {
  if (await view.get(`admin/${id}`) !== null) return true
  const m = (await view.get(`member/${id}`))?.value as { until: number | null } | undefined
  return m !== undefined && (m.until === null || m.until > at)
}

// Ends a workflow early: its steps still open or claimed are canceled,
// and its sub-workflows still running stop.
async function stop (view: JobView, flow: FlowRecord, at: number, mayPost: MayPost): Promise<void> {
  await end(view, flow, mayPost)
  for (const id of Object.values(flow.jobs)) {
    const job = (await view.get(`job/${id}`))?.value as JobRecord | undefined
    if (job && (job.state === 'open' || job.state === 'claimed')) await putJob(view, job, { ...job, state: 'canceled', updated: at })
    const child = job ? undefined : (await view.get(`flow/${id}`))?.value as FlowRecord | undefined
    if (child?.state === 'running' && child.parent?.id === flow.id) await stop(view, { ...child, state: 'canceled', output: 'its parent workflow stopped', updated: at }, at, mayPost)
  }
}

// Records a workflow as ended, in the order workflows end, and prunes the
// first to end past MAX_ENDED_FLOWS (with their results). A sub-workflow's
// end moves its parent on.
async function end (view: JobView, flow: FlowRecord, mayPost: MayPost): Promise<void> {
  await view.put(`flow/${flow.id}`, flow)
  const counter: { next: number, count: number } = (await view.get('flows-ended'))?.value ?? { next: 0, count: 0 }
  await view.put(`flows-ended/${String(counter.next).padStart(16, '0')}`, flow.id)
  let count = counter.count + 1
  const old: Array<{ key: string, id: string }> = []
  if (count > MAX_ENDED_FLOWS) {
    for await (const { key, value } of view.createReadStream({ gt: 'flows-ended/', lt: 'flows-ended0' })) {
      old.push({ key, id: value })
      if (old.length >= Math.min(PRUNE_BATCH, count - MAX_ENDED_FLOWS)) break
    }
  }
  for (const { key, id } of old) {
    await view.del(key)
    await view.del(`flow/${id}`)
    const keys: string[] = []
    for (const prefix of ['flow-result', 'flow-item', 'flow-prev']) {
      for await (const { key: r } of view.createReadStream({ gt: `${prefix}/${id}/`, lt: `${prefix}/${id}0` })) keys.push(r)
    }
    for (const r of keys) await view.del(r)
    count--
  }
  await view.put('flows-ended', { next: counter.next + 1, count })
  if (flow.parent) await childEnded(view, flow, flow.updated, mayPost)
}
