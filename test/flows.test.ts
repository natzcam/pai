import { describe, expect, it } from 'vitest'
import { MAX_ITEMS, applyFlowOp, flowJobEnded, flowProblem, itemsOf, keyedFlowId, parseFlowOp, readFlow, render, runSchedule, scheduleProblem, specOf, stepJobId } from '../src/group/flows.js'
import type { FlowStep, MayPost, ScheduleRecord } from '../src/group/flows.js'
import { RESULT_CUT_NOTE, applyJobOp, sweepJobs } from '../src/group/jobs.js'
import type { JobRecord } from '../src/group/jobs.js'
import { randomBytes } from 'node:crypto'
import type { FlowSpec } from '../src/group/flows.js'
import { GroupIdentity, createGroup, createIdentity, joinGroup } from '../src/identity/group.js'
import type { GroupMembership } from '../src/group/membership.js'
import { JobWorker } from '../src/jobs/worker.js'
import { loadKeyPair } from '../src/store/key-file.js'
import type { Pai } from '../src/pai.js'
import type { TaskHandle } from '../src/server.js'
import type { Message } from '../src/a2a/types.js'
import { agentText, firstText, useTestnet, waitFor } from './helpers.js'

const team: FlowSpec = {
  name: 'team',
  steps: [
    { name: 'draft', to: 'role:writer', text: 'draft: {{input}}' },
    { name: 'review', to: 'role:critic', after: ['draft'], text: 'review: {{ steps.draft }}' },
    { name: 'final', to: 'role:writer', after: ['draft', 'review'], text: 'final: {{steps.draft}} + {{steps.review}}' }
  ]
}

describe('workflow rules', () => {
  it('checks a workflow\'s shape', () => {
    expect(flowProblem(team)).toBeNull()
    expect(flowProblem({ steps: [] })).toMatch(/1 to 32 steps/)
    expect(flowProblem({ steps: [{ name: 'A', to: null, text: 'x' }] })).toMatch(/lowercase/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'x' }, { name: 'a', to: null, text: 'y' }] })).toMatch(/two steps/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'x', after: ['b'] }, { name: 'b', to: null, text: 'y' }] })).toMatch(/earlier steps/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'x' }, { name: 'b', to: null, text: '{{steps.a}}' }] })).toMatch(/doesn't wait/)
    expect(flowProblem({ steps: [{ name: 'a', to: 'writer', text: 'x' }] })).toMatch(/role:<role>/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'x', lease: 100 }] })).toMatch(/lease/)
  })

  it('takes the example workflows', async () => {
    const { readFile, readdir } = await import('node:fs/promises')
    const dir = new URL('../examples/model-team/', import.meta.url)
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThanOrEqual(5)
    for (const f of files) expect([f, flowProblem(JSON.parse(await readFile(new URL(f, dir), 'utf-8')) as FlowSpec)]).toEqual([f, null])
  })

  it('fills in templates, and gives each step a fixed job id', () => {
    expect(render('{{input}} / {{ steps.a }} / {{steps.b}}', 'in', { a: 'A' })).toEqual({ spec: { text: 'in / A / ' }, cut: false })
    // Without job ids to attach by, too much is cut.
    const big = render('{{steps.a}}{{steps.b}}', '', { a: 'x'.repeat(12_000), b: '"'.repeat(5_000) })
    expect(big.cut).toBe(true)
    expect(big.spec.text.endsWith('…(cut to fit in a job)')).toBe(true)
    expect(JSON.stringify(big.spec).length).toBeLessThanOrEqual(16 * 1024)
    const wide = render('{{input}}', '€'.repeat(6000), {})
    expect(wide.cut).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(wide.spec))).toBeLessThanOrEqual(16 * 1024)
    // With them, results that don't fit (the biggest first) or that their
    // worker cut are attached instead, and the context goes along.
    const jobOf = (s: string): string => s.repeat(32).slice(0, 32)
    const attached = render('{{steps.a}} {{steps.b}} {{steps.c}}', '', { a: 'x'.repeat(12_000), b: 'y'.repeat(5_000), c: 'short' }, { jobOf, context: 'flow-1' })
    expect(attached).toEqual({ spec: { text: `[the result of step a: attached] ${'y'.repeat(5_000)} short`, attach: [jobOf('a')], context: 'flow-1' }, cut: false })
    const workerCut = render('{{steps.a}}', '', { a: `partial${RESULT_CUT_NOTE}` }, { jobOf })
    expect(workerCut.spec).toEqual({ text: '[the result of step a: attached]', attach: [jobOf('a')] })
    expect(stepJobId('f'.repeat(32), 'a')).toBe(stepJobId('f'.repeat(32), 'a'))
    expect(stepJobId('f'.repeat(32), 'a')).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('workflow apply', () => {
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
  const hex = (n: number): string => randomBytes(n).toString('hex')
  const member = { roles: ['member'], until: null }

  // Runs a step's job to the end, as its worker would.
  async function finish (view: ReturnType<typeof memView>, flow: string, step: string, result: string, state: 'done' | 'failed' = 'done', mayPost?: MayPost): Promise<void> {
    const id = stepJobId(flow, step)
    const worker = hex(32)
    const writer = hex(32)
    const end = async (job: JobRecord): Promise<void> => { await flowJobEnded(view, job, 2, mayPost) }
    await applyJobOp({ type: 'job.claim', id, at: 1 }, worker, writer, view, member, false, end)
    await applyJobOp({ type: 'job.done', id, state, result, ref: null, at: 2 }, worker, writer, view, member, false, end)
  }

  it('start one run per key, even once that run is pruned', async () => {
    const view = memView()
    const by = hex(32)
    await view.put(`member/${by}`, { id: by, until: null })
    const id = keyedFlowId('g', by, 'k')
    const op = { type: 'flow.start' as const, flow: { id, key: 'k', input: '', steps: [{ name: 'a', to: null, text: 'x' }] }, at: 0 }
    await applyFlowOp(op, by, view, false)
    expect(await readFlow(view, id)).not.toBeNull()
    await view.del(`flow/${id}`)
    await applyFlowOp(op, by, view, false)
    expect(await readFlow(view, id)).toBeNull()
  })

  it('takes any step name, reserves step ids, and ends with the final steps\' results', async () => {
    const view = memView()
    const by = hex(32)
    await view.put(`member/${by}`, { id: by, until: null })
    const id = hex(16)
    const steps = [
      { name: 'constructor', to: null, text: 'a {{input}}' },
      { name: 'tostring', to: null, text: 'b {{steps.constructor}}', after: ['constructor'] },
      { name: 'side', to: null, text: 'c' }
    ]
    expect(flowProblem({ steps })).toBeNull()
    await applyFlowOp({ type: 'flow.start', flow: { id, input: 'in', steps }, at: 0 }, by, view, false)
    // Someone posting a later step's job id first gets nowhere.
    const squat = stepJobId(id, 'tostring')
    await applyJobOp({ type: 'job.post', job: { id: squat, spec: { text: 'mine' }, to: null, lease: null }, at: 0 }, hex(32), hex(32), view, member, false)
    expect(view.map.has(`job/${squat}`)).toBe(false)
    let flow = await readFlow(view, id)
    expect(Object.keys(flow!.jobs).sort()).toEqual(['constructor', 'side'])
    await finish(view, id, 'constructor', 'A')
    await finish(view, id, 'side', 'C')
    expect((view.map.get(`job/${squat}`) as JobRecord).spec.text).toBe('b A')
    await finish(view, id, 'tostring', 'B')
    flow = await readFlow(view, id)
    expect(flow).toMatchObject({ state: 'done', results: { constructor: 'A', side: 'C', tostring: 'B' }, output: '## tostring\nB\n\n## side\nC' })
  })

  it('maps a step over a list: one job per item, the results in order as a JSON array', async () => {
    expect(itemsOf('["a", 2, {"c": 1}]')).toEqual(['a', '2', '{"c":1}'])
    expect(itemsOf(' one\n\n  two \n')).toEqual(['one', 'two'])
    expect(itemsOf('[not json')).toEqual(['[not json'])
    expect(itemsOf('Here you go:\n```json\n[\n  "a",\n  "",\n  "b"\n]\n```')).toEqual(['a', 'b'])
    expect(itemsOf('1. first\n- second\n```\n* third')).toEqual(['first', 'second', 'third'])
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'same each time', map: 'input' }] })).toMatch(/no \{\{item\}\}/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: '{{item}}' }] })).toMatch(/isn't a map or copies step/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'x' }, { name: 'b', to: null, text: '{{item}}', map: 'steps.a' }] })).toMatch(/map is "input" or "steps/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: '{{item}}', map: 'input' }] })).toBeNull()

    const view = memView()
    const by = hex(32)
    await view.put(`member/${by}`, { id: by, until: null })
    const id = hex(16)
    const steps: FlowStep[] = [
      { name: 'list', to: null, text: 'list {{input}}' },
      { name: 'each', to: null, text: 'do {{item}} for {{input}}', after: ['list'], map: 'steps.list' },
      { name: 'sum', to: null, text: 'sum {{steps.each}}', after: ['each'] }
    ]
    await applyFlowOp({ type: 'flow.start', flow: { id, input: 'x', steps }, at: 0 }, by, view, false)
    // Item ids are reserved too.
    const squat = stepJobId(id, 'each#1')
    await applyJobOp({ type: 'job.post', job: { id: squat, spec: { text: 'mine' }, to: null, lease: null }, at: 0 }, hex(32), hex(32), view, member, false)
    expect(view.map.has(`job/${squat}`)).toBe(false)
    await finish(view, id, 'list', '["a", "b", {"c": 1}]')
    const texts = [0, 1, 2].map((i) => (view.map.get(`job/${stepJobId(id, `each#${i}`)}`) as JobRecord))
    expect(texts.map((j) => j.spec.text)).toEqual(['do a for x', 'do b for x', 'do {"c":1} for x'])
    expect(texts[1]!.flow).toEqual({ id, step: 'each', item: 1 })
    // Each item in a context of its own; ids the rules' own (top bit set).
    expect(new Set(texts.map((j) => j.spec.context)).size).toBe(3)
    expect(texts.every((j) => parseInt(j.id[0]!, 16) >= 8)).toBe(true)
    expect((await readFlow(view, id))?.items).toEqual({ each: { n: 3, done: 0 } })
    await finish(view, id, 'each#2', 'C')
    await finish(view, id, 'each#0', 'A')
    expect((await readFlow(view, id))?.items).toEqual({ each: { n: 3, done: 2 } })
    expect(view.map.has(`job/${stepJobId(id, 'sum')}`)).toBe(false)
    await finish(view, id, 'each#1', 'B')
    expect((view.map.get(`job/${stepJobId(id, 'sum')}`) as JobRecord).spec.text).toBe('sum ["A","B","C"]')
    expect([...view.map.keys()].some((k) => k.startsWith(`flow-item/${id}/`))).toBe(false)
    await finish(view, id, 'sum', 'ABC')
    expect(await readFlow(view, id)).toMatchObject({ state: 'done', output: 'ABC', results: { each: '["A","B","C"]' } })

    // An item that fails fails the step, and the other items are canceled.
    const f2 = hex(16)
    await applyFlowOp({ type: 'flow.start', flow: { id: f2, input: 'p\nq\nr', steps: [{ name: 'each', to: null, text: '{{item}}', map: 'input' }] }, at: 0 }, by, view, false)
    await finish(view, f2, 'each#1', 'boom', 'failed')
    expect(await readFlow(view, f2)).toMatchObject({ state: 'failed', output: 'step each failed: item 2 of 3: boom' })
    expect((view.map.get(`job/${stepJobId(f2, 'each#0')}`) as JobRecord).state).toBe('canceled')

    // Over a step that failed on a branch: skipped, not run over its error.
    const f5 = hex(16)
    await applyFlowOp({ type: 'flow.start', flow: { id: f5, input: '', steps: [
      { name: 'a', to: null, text: 'a' },
      { name: 'b', to: null, text: 'b' },
      { name: 'oops', to: null, text: 'oops', after: ['a'], if: { step: 'a', failed: true } },
      { name: 'each', to: null, text: '{{item}}', after: ['a', 'b'], map: 'steps.a' }
    ] }, at: 0 }, by, view, false)
    await finish(view, f5, 'b', 'B')
    await finish(view, f5, 'a', 'line 1\nline 2', 'failed')
    expect((await readFlow(view, f5))?.skipped).toContain('each')

    // No items: done at once, with []; too many: the workflow fails.
    const f3 = hex(16)
    await applyFlowOp({ type: 'flow.start', flow: { id: f3, input: '  ', steps: [{ name: 'each', to: null, text: '{{item}}', map: 'input' }, { name: 'then', to: null, text: 'got {{steps.each}}', after: ['each'] }] }, at: 0 }, by, view, false)
    expect((view.map.get(`job/${stepJobId(f3, 'then')}`) as JobRecord).spec.text).toBe('got []')
    const f4 = hex(16)
    await applyFlowOp({ type: 'flow.start', flow: { id: f4, input: Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `i${i}`).join('\n'), steps: [{ name: 'each', to: null, text: '{{item}}', map: 'input' }] }, at: 0 }, by, view, false)
    expect(await readFlow(view, f4)).toMatchObject({ state: 'failed', output: `step each has ${MAX_ITEMS + 1} items: a map step takes at most ${MAX_ITEMS}` })
  })

  it('checks the policy as each step is posted: one it now refuses fails the workflow', async () => {
    const view = memView()
    const by = hex(32)
    await view.put(`member/${by}`, { id: by, until: null })
    const id = hex(16)
    let denied = ''
    const mayPost: MayPost = async (_, to) => to !== denied
    await applyFlowOp({ type: 'flow.start', flow: { id, input: '', steps: [{ name: 'a', to: null, text: 'x' }, { name: 'b', to: 'role:ops', text: 'y', after: ['a'] }] }, at: 0 }, by, view, false, mayPost)
    denied = 'role:ops' // an admin adds a rule meanwhile
    await finish(view, id, 'a', 'A', 'done', mayPost)
    const flow = await readFlow(view, id)
    expect(flow).toMatchObject({ state: 'failed', output: 'the group\'s policy doesn\'t let its starter post step b for role:ops' })
    expect(view.map.has(`job/${stepJobId(id, 'b')}`)).toBe(false)
  })

  it('branches on a step\'s result or failure, skips branches not taken, and joins after either', async () => {
    const start = async (steps: FlowStep[]): Promise<{ view: ReturnType<typeof memView>, id: string }> => {
      const view = memView()
      const by = hex(32)
      await view.put(`member/${by}`, { id: by, until: null })
      const id = hex(16)
      expect(flowProblem({ steps })).toBeNull()
      await applyFlowOp({ type: 'flow.start', flow: { id, input: 'in', steps }, at: 0 }, by, view, false)
      return { view, id }
    }
    const steps: FlowStep[] = [
      { name: 'review', to: null, text: 'review {{input}}' },
      { name: 'publish', to: null, text: 'publish', after: ['review'], if: { step: 'review', equals: 'Approved' } },
      { name: 'revise', to: null, text: 'revise: {{steps.review}}', after: ['review'], if: { step: 'review', equals: 'approved', not: true } },
      { name: 'escalate', to: null, text: 'escalate: {{steps.review}}', after: ['review'], if: { step: 'review', failed: true } },
      { name: 'tell', to: null, text: 'tell', after: ['publish', 'revise'] }
    ]
    // Approved: publish runs, revise and escalate are skipped, tell joins.
    let { view, id } = await start(steps)
    await finish(view, id, 'review', '  approved\n')
    let flow = await readFlow(view, id)
    expect(Object.keys(flow!.jobs).sort()).toEqual(['publish', 'review'])
    expect(flow!.skipped?.sort()).toEqual(['escalate', 'revise'])
    await finish(view, id, 'publish', 'live')
    await finish(view, id, 'tell', 'told')
    flow = await readFlow(view, id)
    expect(flow).toMatchObject({ state: 'done', output: 'told' })

    // Changes asked for: revise runs with the review in its text.
    ;({ view, id } = await start(steps))
    await finish(view, id, 'review', 'needs work')
    expect((view.map.get(`job/${stepJobId(id, 'revise')}`) as JobRecord).spec.text).toBe('revise: needs work')
    expect((await readFlow(view, id))!.skipped?.sort()).toEqual(['escalate', 'publish'])

    // Rejected (the step failed): escalate runs; the workflow goes on.
    ;({ view, id } = await start(steps))
    await finish(view, id, 'review', 'no way', 'failed')
    flow = await readFlow(view, id)
    expect(flow).toMatchObject({ state: 'running', failed: ['review'] })
    expect((view.map.get(`job/${stepJobId(id, 'escalate')}`) as JobRecord).spec.text).toBe('escalate: no way')
    // publish and revise are skipped (nothing done to run after), so tell is too.
    await finish(view, id, 'escalate', 'escalated')
    flow = await readFlow(view, id)
    expect(flow).toMatchObject({ state: 'done', output: 'escalated' })
    expect(flow!.skipped?.sort()).toEqual(['publish', 'revise', 'tell'])

    // A failure nothing tests for still stops the workflow.
    ;({ view, id } = await start([{ name: 'a', to: null, text: 'a' }, { name: 'b', to: null, text: 'b', after: ['a'] }]))
    await finish(view, id, 'a', 'broke', 'failed')
    expect(await readFlow(view, id)).toMatchObject({ state: 'failed', output: 'step a failed: broke' })

    // "Didn't fail" doesn't make a failure a branch, and a test behind a
    // skipped step doesn't hold.
    ;({ view, id } = await start([
      { name: 'a', to: null, text: 'a' },
      { name: 'b', to: null, text: 'b', after: ['a'], if: { step: 'a', failed: true, not: true } }
    ]))
    await finish(view, id, 'a', 'broke', 'failed')
    expect(await readFlow(view, id)).toMatchObject({ state: 'failed' })
    ;({ view, id } = await start([
      { name: 'a', to: null, text: 'a' },
      { name: 'b', to: null, text: 'b', after: ['a'], if: { step: 'a', contains: 'YES' } },
      { name: 'c', to: null, text: 'c', after: ['b'], if: { step: 'b', failed: true, not: true } }
    ]))
    await finish(view, id, 'a', 'no')
    // Ends on a branch not taken: a's result is the output.
    expect(await readFlow(view, id)).toMatchObject({ state: 'done', skipped: ['b', 'c'], output: 'no' })

    // Conditions are checked.
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'a' }, { name: 'b', to: null, text: 'b', if: { step: 'a', equals: 'x' } }] })).toMatch(/waits for/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'a' }, { name: 'b', to: null, text: 'b', after: ['a'], if: { step: 'a', equals: 'x', contains: 'y' } }] })).toMatch(/one of/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'a' }, { name: 'b', to: null, text: 'b', after: ['a'], if: { step: 'a', contains: '  ' } }] })).toMatch(/not only spaces/)
  })

  it('stops when its starter is no longer a member', async () => {
    const view = memView()
    const by = hex(32)
    await view.put(`member/${by}`, { id: by, until: null })
    const id = hex(16)
    await applyFlowOp({ type: 'flow.start', flow: { id, input: '', steps: [{ name: 'a', to: null, text: 'x' }, { name: 'b', to: null, text: 'y', after: ['a'] }] }, at: 0 }, by, view, false)
    await view.del(`member/${by}`)
    await finish(view, id, 'a', 'A')
    const flow = await readFlow(view, id)
    expect(flow).toMatchObject({ state: 'failed', output: 'its starter is no longer a member' })
    expect(Object.keys(flow!.jobs)).toEqual(['a'])
  })
})

describe('workflow loops, races, sub-workflows and schedules', () => {
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
  type View = ReturnType<typeof memView>
  const hex = (n: number): string => randomBytes(n).toString('hex')
  const member = { roles: ['member'], until: null }
  const job = (view: View, flow: string, key: string): JobRecord | undefined => view.map.get(`job/${stepJobId(flow, key)}`) as JobRecord | undefined

  async function finish (view: View, flow: string, key: string, result: string, state: 'done' | 'failed' = 'done'): Promise<void> {
    const id = stepJobId(flow, key)
    const worker = hex(32)
    const writer = hex(32)
    const end = async (j: JobRecord): Promise<void> => { await flowJobEnded(view, j, 2) }
    await applyJobOp({ type: 'job.claim', id, at: 1 }, worker, writer, view, member, false, end)
    await applyJobOp({ type: 'job.done', id, state, result, ref: null, at: 2 }, worker, writer, view, member, false, end)
  }

  async function start (steps: FlowStep[], input = 'in'): Promise<{ view: View, id: string, by: string }> {
    const view = memView()
    const by = hex(32)
    await view.put(`member/${by}`, { id: by, until: null })
    const id = hex(16)
    expect(flowProblem({ steps })).toBeNull()
    await applyFlowOp({ type: 'flow.start', flow: { id, input, steps }, at: 0 }, by, view, false)
    return { view, id, by }
  }

  it('repeats steps until a test holds, with the last round\'s results, for at most max rounds', async () => {
    const loop: FlowStep[] = [
      { name: 'draft', to: null, text: 'draft {{input}}; notes: {{prev.review}}' },
      { name: 'review', to: null, text: 'review {{steps.draft}}', after: ['draft'], repeat: { from: 'draft', until: { step: 'review', equals: 'approved' }, max: 3 } },
      { name: 'publish', to: null, text: 'publish {{steps.draft}}', after: ['draft', 'review'] }
    ]
    let { view, id } = await start(loop)
    expect(job(view, id, 'draft')!.spec.text).toBe('draft in; notes: ')
    await finish(view, id, 'draft', 'D1')
    await finish(view, id, 'review', 'shorter please')
    // Round 2: the steps run again, under ids of their own, with the notes.
    let flow = await readFlow(view, id)
    expect(flow).toMatchObject({ state: 'running', loops: { review: { round: 1, over: false } }, done: [], results: {} })
    expect(job(view, id, 'draft@1')).toMatchObject({ state: 'open', spec: { text: 'draft in; notes: shorter please' }, flow: { id, step: 'draft', round: 1 } })
    expect(job(view, id, 'publish')).toBeUndefined()
    // An earlier round's job ending late changes nothing.
    await finish(view, id, 'draft@1', 'D2')
    await finish(view, id, 'review@1', ' Approved ')
    flow = await readFlow(view, id)
    expect(flow!.loops).toEqual({ review: { round: 1, over: true } })
    expect(job(view, id, 'publish')!.spec.text).toBe('publish D2')
    await finish(view, id, 'publish', 'P')
    expect(await readFlow(view, id)).toMatchObject({ state: 'done', output: 'P' })

    // Never approved: after max rounds it goes on with the last round's.
    ;({ view, id } = await start(loop.map((s) => s.name === 'review' ? { ...s, repeat: { ...s.repeat!, max: 2 } } : s)))
    await finish(view, id, 'draft', 'D1')
    await finish(view, id, 'review', 'no')
    await finish(view, id, 'draft@1', 'D2')
    await finish(view, id, 'review@1', 'still no')
    expect(job(view, id, 'draft@2')).toBeUndefined()
    expect(job(view, id, 'publish')!.spec.text).toBe('publish D2')

    // Until a step stops failing: its failure loops instead of stopping.
    ;({ view, id } = await start([
      { name: 'fix', to: null, text: 'fix; last test: {{prev.test}}' },
      { name: 'test', to: null, text: 'test', after: ['fix'], repeat: { from: 'fix', until: { step: 'test', failed: true, not: true }, max: 5 } }
    ]))
    await finish(view, id, 'fix', 'F1')
    await finish(view, id, 'test', '2 failing', 'failed')
    expect(job(view, id, 'fix@1')!.spec.text).toBe('fix; last test: 2 failing')
    await finish(view, id, 'fix@1', 'F2')
    await finish(view, id, 'test@1', 'all pass')
    expect(await readFlow(view, id)).toMatchObject({ state: 'done', output: 'all pass' })

    // Out of rounds still failing: the workflow fails, not done.
    ;({ view, id } = await start([
      { name: 'x', to: null, text: 'x', repeat: { from: 'x', until: { step: 'x', failed: true, not: true }, max: 2 } },
      { name: 'y', to: null, text: 'y', after: ['x'] }
    ]))
    await finish(view, id, 'x', 'no', 'failed')
    await finish(view, id, 'x@1', 'still no', 'failed')
    expect(await readFlow(view, id)).toMatchObject({ state: 'failed', output: 'step x failed: still no' })

    // A loop behind a branch not taken is over at once, not run to max.
    ;({ view, id } = await start([
      { name: 'r', to: null, text: 'r' },
      { name: 'redo', to: null, text: 'redo', after: ['r'], if: { step: 'r', equals: 'redo' }, repeat: { from: 'redo', until: { step: 'redo', equals: 'ok' }, max: 10 } }
    ]))
    await finish(view, id, 'r', 'fine')
    expect(await readFlow(view, id)).toMatchObject({ state: 'done', loops: { redo: { round: 0, over: true } } })

    // Checked: the range, max, until, overlaps, and {{prev}} outside.
    const a = { name: 'a', to: null, text: 'a' }
    expect(flowProblem({ steps: [a, { name: 'b', to: null, text: 'b', after: ['a'], repeat: { from: 'c', until: { step: 'b', equals: 'x' }, max: 2 } }] })).toMatch(/this step or an earlier one/)
    expect(flowProblem({ steps: [a, { name: 'b', to: null, text: 'b', repeat: { from: 'a', until: { step: 'b', equals: 'x' }, max: 11 } }] })).toMatch(/2 to 10 rounds/)
    expect(flowProblem({ steps: [a, { name: 'b', to: null, text: 'b', repeat: { from: 'b', until: { step: 'a', equals: 'x' }, max: 2 } }] })).toMatch(/until names a step in the repeat/)
    expect(flowProblem({ steps: [{ ...a, repeat: { from: 'a', until: { step: 'a', equals: 'x' }, max: 2 } }, { name: 'b', to: null, text: 'b', repeat: { from: 'a', until: { step: 'b', equals: 'x' }, max: 2 } }] })).toMatch(/overlaps/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: '{{prev.a}}' }] })).toMatch(/same repeat/)
  })

  it('races copies of a step, or settles on the first k that agree', async () => {
    // The first done wins; the rest are canceled.
    let { view, id } = await start([
      { name: 'race', to: null, text: 'answer (try {{item}})', copies: 3, settle: 'first' },
      { name: 'then', to: null, text: 'got {{steps.race}}', after: ['race'] }
    ])
    expect([0, 1, 2].map((i) => job(view, id, `race#${i}`)!.spec.text)).toEqual(['answer (try 1)', 'answer (try 2)', 'answer (try 3)'])
    await finish(view, id, 'race#2', 'oops', 'failed')
    expect((await readFlow(view, id))!.items).toEqual({ race: { n: 3, done: 0, failed: 1 } })
    await finish(view, id, 'race#1', 'B')
    expect(job(view, id, 'race#0')!.state).toBe('canceled')
    expect(job(view, id, 'then')!.spec.text).toBe('got B')

    // All failed: so does the step.
    ;({ view, id } = await start([{ name: 'race', to: null, text: 'x', copies: 2, settle: 'first' }]))
    await finish(view, id, 'race#0', 'no', 'failed')
    await finish(view, id, 'race#1', 'nope', 'failed')
    expect(await readFlow(view, id)).toMatchObject({ state: 'failed', output: 'step race failed: all 2 failed; the last: nope' })

    // A vote: 2 of 3 the same (as conditions compare).
    ;({ view, id } = await start([{ name: 'vote', to: null, text: 'ship it?', copies: 3, settle: { agree: 2 } }]))
    await finish(view, id, 'vote#0', 'Yes')
    await finish(view, id, 'vote#1', 'no')
    expect((await readFlow(view, id))!.state).toBe('running')
    await finish(view, id, 'vote#2', ' yes\n')
    expect(await readFlow(view, id)).toMatchObject({ state: 'done', output: 'Yes', results: { vote: 'Yes' } })

    // Once k can't agree, it fails; a map step can vote too.
    ;({ view, id } = await start([{ name: 'vote', to: null, text: '{{item}}', map: 'input', settle: { agree: 3 } }], 'a\nb\nc'))
    await finish(view, id, 'vote#0', 'x')
    await finish(view, id, 'vote#1', 'y')
    expect(await readFlow(view, id)).toMatchObject({ state: 'failed', output: 'step vote failed: no 3 of 3 agreed' })
    expect(job(view, id, 'vote#2')!.state).toBe('canceled')

    // Copies with 'all' (the default): every result, for a judge to pick.
    ;({ view, id } = await start([{ name: 'n', to: null, text: 'x', copies: 2 }, { name: 'judge', to: null, text: 'best of {{steps.n}}', after: ['n'] }]))
    await finish(view, id, 'n#1', 'B')
    await finish(view, id, 'n#0', 'A')
    expect(job(view, id, 'judge')!.spec.text).toBe('best of ["A","B"]')

    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'x', copies: 9 }] })).toMatch(/copies is 2 to 8/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'x', settle: 'first' }] })).toMatch(/map or copies step/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'x', copies: 2, settle: { agree: 3 } }] })).toMatch(/agree: 2 to 2/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: '{{item}}', copies: 2, map: 'input' }] })).toMatch(/map or copies, not both/)
  })

  it('runs a step as a sub-workflow: written in, or planned by an earlier step', async () => {
    const inner: FlowSpec = { name: 'inner', steps: [{ name: 'x', to: null, text: 'x {{input}}' }, { name: 'y', to: null, text: 'y {{steps.x}}', after: ['x'] }] }
    let { view, id } = await start([
      { name: 'sub', text: 'for {{input}}', flow: inner },
      { name: 'after', to: null, text: 'got {{steps.sub}}', after: ['sub'] }
    ])
    const child = stepJobId(id, 'sub')
    expect(await readFlow(view, child)).toMatchObject({ state: 'running', name: 'inner', input: 'for in', parent: { id, step: 'sub' }, depth: 1 })
    expect(job(view, child, 'x')!.spec.text).toBe('x for in')
    await finish(view, child, 'x', 'X')
    await finish(view, child, 'y', 'Y')
    expect(await readFlow(view, child)).toMatchObject({ state: 'done', output: 'Y' })
    expect(job(view, id, 'after')!.spec.text).toBe('got Y')

    // Planned: the plan's JSON (in a code block, say) is the workflow.
    const planned: FlowStep[] = [
      { name: 'plan', to: null, text: 'plan {{input}}' },
      { name: 'do', text: '{{input}}', after: ['plan'], flow: 'steps.plan' }
    ]
    ;({ view, id } = await start(planned))
    await finish(view, id, 'plan', 'Here:\n```json\n{"steps":[{"name":"one","to":null,"text":"one {{input}}"}]}\n```')
    const run = stepJobId(id, 'do')
    expect(job(view, run, 'one')!.spec.text).toBe('one in')
    // Canceling the workflow stops its sub-workflow and that one's jobs.
    await applyFlowOp({ type: 'flow.cancel', id, at: 3 }, (await readFlow(view, id))!.by, view, false)
    expect(await readFlow(view, run)).toMatchObject({ state: 'canceled', output: 'its parent workflow stopped' })
    expect(job(view, run, 'one')!.state).toBe('canceled')

    // A one-step bare array in a code block is a plan too.
    expect(specOf('```json\n[{"name":"a","to":null,"text":"x"}]\n```')).toEqual({ steps: [{ name: 'a', to: null, text: 'x' }] })
    expect(specOf('{"name":"a","to":null,"text":"x"}')).toEqual({ name: 'a', to: null, text: 'x' })

    // A plan that isn't a workflow fails its step; a sub-workflow's
    // failure fails its step too.
    ;({ view, id } = await start(planned))
    await finish(view, id, 'plan', 'I would rather not')
    expect(await readFlow(view, id)).toMatchObject({ state: 'failed', output: 'step do failed: the workflow from step plan won\'t run: it isn\'t a workflow as JSON' })
    ;({ view, id } = await start([{ name: 'sub', text: 'go', flow: inner }]))
    await finish(view, stepJobId(id, 'sub'), 'x', 'broke', 'failed')
    expect(await readFlow(view, id)).toMatchObject({ state: 'failed', output: 'step sub failed: step x failed: broke' })

    const nest = (d: number): FlowSpec => ({ steps: [d === 0 ? { name: 'a', to: null, text: 'a' } : { name: 'a', text: 'a', flow: nest(d - 1) }] })
    expect(flowProblem(nest(3))).toBeNull()
    expect(flowProblem(nest(4))).toMatch(/nest at most 3 deep/)
    expect(flowProblem({ steps: [{ name: 'a', to: null, text: 'a', flow: inner }] })).toMatch(/no to, lease/)
  })

  it('starts a schedule\'s runs by the group\'s clock, skipping one while the last still runs', async () => {
    const view = memView()
    const by = hex(32)
    await view.put(`member/${by}`, { id: by, until: null })
    const flow: FlowSpec = { name: 'daily', steps: [{ name: 'a', to: null, text: 'report on {{input}}' }] }
    expect(scheduleProblem({ name: 'daily', flow, input: 'sales', every: 1000 })).toMatch(/1 minute/)
    await applyFlowOp({ type: 'schedule.set', schedule: { name: 'daily', flow, input: 'sales', every: 60_000, start: 5000 }, at: 1000 }, by, view, false)
    expect(view.map.get('schedule/daily')).toMatchObject({ next: 5000, runs: 0, last: null })
    // Someone else can't replace or drop it.
    await applyFlowOp({ type: 'schedule.drop', name: 'daily', at: 1000 }, hex(32), view, false)
    expect(view.map.has('schedule/daily')).toBe(true)

    const sweep = async (clock: number): Promise<void> => { await sweepJobs(view, clock, async () => {}, async (name, due) => { await runSchedule(view, name, due, clock) }) }
    await sweep(4999)
    expect(view.map.get('schedule/daily')).toMatchObject({ runs: 0 })
    await sweep(5001)
    const first = (view.map.get('schedule/daily') as ScheduleRecord)
    expect(first).toMatchObject({ next: 65_000, runs: 1 })
    expect(await readFlow(view, first.last!)).toMatchObject({ state: 'running', by, name: 'daily', schedule: 'daily', input: 'sales' })
    // Still running at the next: skipped, and the clock jumping past
    // several runs makes one.
    await sweep(200_000)
    expect(view.map.get('schedule/daily')).toMatchObject({ next: 245_000, runs: 1, last: first.last })
    await finish(view, first.last!, 'a', 'done')
    await sweep(245_000)
    const second = view.map.get('schedule/daily') as ScheduleRecord
    expect(second.runs).toBe(2)
    expect(second.last).not.toBe(first.last)
    // Its setter leaves: it goes.
    await view.del(`member/${by}`)
    await sweep(305_000)
    expect(view.map.has('schedule/daily')).toBe(false)
  })
})

describe('workflows', () => {
  const { agent, tempdir, bootstrap } = useTestnet()

  // `identity`: the agent's one group (workflows are the group's).
  async function admin (): Promise<{ pai: Pai, identity: GroupMembership }> {
    const storage = await tempdir('admin')
    const keyPair = await loadKeyPair(storage)
    const keys = await createIdentity({ storage, keyPair, name: 'admin' })
    const entry = await createGroup({ storage, keys, keyPair, name: 'team', member: 'admin' })
    const identity = new GroupIdentity({ storage, keys, groups: [entry] })
    return { pai: await agent('admin', { storage, identity }), identity: identity.group() }
  }

  async function worker (boss: GroupMembership, name: string, role: string, handler: (m: Message, task: TaskHandle) => Promise<Message | void>): Promise<{ identity: GroupMembership, worker: JobWorker }> {
    const { code } = await boss.invite({ roles: [role] })
    const storage = await tempdir(name)
    const keyPair = await loadKeyPair(storage)
    const keys = await createIdentity({ storage, keyPair, name })
    const entry = await joinGroup({ storage, keyPair, keys, code, name, bootstrap: bootstrap(), timeout: 20_000 })
    const agentIdentity = new GroupIdentity({ storage, keys, groups: [entry] })
    const pai = await agent(name, { storage, identity: agentIdentity, handler })
    const identity = agentIdentity.group()
    await waitFor(() => identity.base.writable, 20_000)
    const w = new JobWorker(pai, identity)
    w.start()
    return { identity, worker: w }
  }

  it('runs its steps in order on the right roles, each with the results it waits for', async () => {
    const boss = await admin()
    const echo = async (m: Message): Promise<Message> => agentText(`<${firstText(m) ?? ''}>`)
    const writer = await worker(boss.identity, 'writer', 'writer', echo)
    const critic = await worker(boss.identity, 'critic', 'critic', echo)
    try {
      const started = await boss.identity.startFlow(team, 'nat')
      expect(started.state).toBe('running')
      expect(Object.keys(started.jobs)).toEqual(['draft']) // only what's ready
      const done = await boss.identity.waitFlow(started.id, { timeout: 60_000 })
      expect(done?.state).toBe('done')
      expect(done?.results).toEqual({ draft: '<draft: nat>', review: '<review: <draft: nat>>', final: '<final: <draft: nat> + <review: <draft: nat>>>' })
      expect(done?.output).toBe(done?.results.final)
      // Each step's job went to its role, posted as the starter's.
      const review = await boss.identity.getJob(done!.jobs.review!)
      expect(review).toMatchObject({ by: boss.identity.self, to: 'role:critic', claim: { by: critic.identity.self }, flow: { id: started.id, step: 'review' } })
      expect((await boss.identity.listFlows()).map((f) => f.id)).toEqual([started.id])
    } finally {
      await writer.worker.close()
      await critic.worker.close()
    }
  }, 90_000)

  it('runs a loop, a vote and a planned sub-workflow on real workers; keeps schedules', async () => {
    const boss = await admin()
    let drafts = 0
    const writer = await worker(boss.identity, 'writer', 'writer', async (m) => {
      const text = firstText(m) ?? ''
      if (text.startsWith('plan')) return agentText(JSON.stringify({ steps: [{ name: 'say', to: 'role:writer', text: 'say {{input}}' }] }))
      if (text.startsWith('say')) return agentText(text.toUpperCase())
      return agentText(`draft ${++drafts}`)
    })
    const critic = await worker(boss.identity, 'critic', 'critic', async (m) => agentText((firstText(m) ?? '').includes('draft 2') ? 'approved' : 'again'))
    try {
      const started = await boss.identity.startFlow({ steps: [
        { name: 'draft', to: 'role:writer', text: 'write; notes: {{prev.review}}' },
        { name: 'review', to: 'role:critic', text: 'review {{steps.draft}}', after: ['draft'], repeat: { from: 'draft', until: { step: 'review', equals: 'approved' }, max: 4 } },
        { name: 'vote', to: 'role:critic', text: 'ok? {{steps.draft}}', after: ['draft', 'review'], copies: 3, settle: { agree: 2 } },
        { name: 'plan', to: 'role:writer', text: 'plan for {{steps.draft}}', after: ['draft', 'vote'] },
        { name: 'do', text: 'hello', after: ['plan'], flow: 'steps.plan' }
      ] }, '')
      const done = await boss.identity.waitFlow(started.id, { timeout: 80_000 })
      expect(done).toMatchObject({ state: 'done', output: 'SAY HELLO', loops: { review: { round: 1, over: true } } })
      expect(done!.results).toMatchObject({ draft: 'draft 2', review: 'approved', vote: 'approved' })
      expect((await boss.identity.listFlows()).find((f) => f.parent === started.id)).toBeTruthy()

      // Schedules: set, listed, replaced by name, dropped.
      const flow: FlowSpec = { steps: [{ name: 'a', to: 'role:writer', text: 'x' }] }
      const set = await boss.identity.setSchedule({ name: 'nightly', flow, input: '', every: 86_400_000, start: Date.now() + 3_600_000 })
      expect(set).toMatchObject({ name: 'nightly', by: boss.identity.self, runs: 0 })
      await boss.identity.setSchedule({ name: 'nightly', flow, input: 'again', every: 3_600_000 })
      expect((await boss.identity.listSchedules()).map((x) => [x.name, x.input])).toEqual([['nightly', 'again']])
      await expect(writer.identity.dropSchedule('nightly')).rejects.toThrow(/another member's/)
      await boss.identity.dropSchedule('nightly')
      expect(await boss.identity.listSchedules()).toEqual([])
    } finally {
      await writer.worker.close()
      await critic.worker.close()
    }
  }, 120_000)

  it('attaches a result too big to inline, and runs every step in the workflow\'s context', async () => {
    const boss = await admin()
    const long = 'D'.repeat(20_000)
    const writer = await worker(boss.identity, 'writer', 'writer', async (_m, task) => {
      await task.update('TASK_STATE_WORKING')
      await task.artifact({ artifactId: 'out', parts: [{ text: long }] })
      await task.update('TASK_STATE_COMPLETED')
    })
    const seen: Message[] = []
    const critic = await worker(boss.identity, 'critic', 'critic', async (m) => { seen.push(m); return agentText('fine') })
    try {
      const started = await boss.identity.startFlow({ steps: [
        { name: 'draft', to: 'role:writer', text: 'Write.' },
        { name: 'review', to: 'role:critic', text: 'Review: {{steps.draft}}', after: ['draft'] }
      ] }, '')
      const done = await boss.identity.waitFlow(started.id, { timeout: 60_000 })
      expect(done).toMatchObject({ state: 'done', output: 'fine', cut: [] })
      const [m] = seen
      expect(m!.contextId).toBe(`${boss.identity.self}:flow-${started.id}`)
      expect(m!.parts.map((p) => 'text' in p ? p.text : '')).toEqual(['Review: [the result of step draft: attached]', `--- Attached: the result of step draft ---\n${long}`])
    } finally {
      await writer.worker.close()
      await critic.worker.close()
    }
  }, 90_000)

  it('maps a step over items, shared between workers with the role', async () => {
    const boss = await admin()
    const echo = async (m: Message): Promise<Message> => agentText(`<${firstText(m) ?? ''}>`)
    const one = await worker(boss.identity, 'one', 'writer', echo)
    const two = await worker(boss.identity, 'two', 'writer', echo)
    try {
      const started = await boss.identity.startFlow({ steps: [
        { name: 'each', to: 'role:writer', text: 'w {{item}}', map: 'input' },
        { name: 'all', to: 'role:writer', text: 'all {{steps.each}}', after: ['each'] }
      ] }, 'a\nb\nc\nd')
      const done = await boss.identity.waitFlow(started.id, { timeout: 60_000 })
      expect(done).toMatchObject({ state: 'done', results: { each: '["<w a>","<w b>","<w c>","<w d>"]' }, output: '<all ["<w a>","<w b>","<w c>","<w d>"]>', items: { each: { n: 4, done: 4 } } })
    } finally {
      await one.worker.close()
      await two.worker.close()
    }
  }, 90_000)

  it('stops when a step fails, canceling the rest; the starter can cancel one', async () => {
    const boss = await admin()
    const writer = await worker(boss.identity, 'writer', 'writer', async () => { throw new Error('no ink') })
    try {
      const both: FlowSpec = { steps: [{ name: 'a', to: 'role:writer', text: 'x' }, { name: 'b', to: 'role:editor', text: 'y' }, { name: 'c', to: null, text: 'z', after: ['a', 'b'] }] }
      const flow = await boss.identity.startFlow(both, '')
      const failed = await boss.identity.waitFlow(flow.id, { timeout: 60_000 })
      expect(failed).toMatchObject({ state: 'failed', output: 'step a failed: no ink', stopped: 'a' })
      // b (for an editor nobody runs) was canceled with it; c never posted.
      expect((await boss.identity.getJob(failed!.jobs.b!))?.state).toBe('canceled')
      expect(failed!.jobs.c).toBeUndefined()

      const waiting = await boss.identity.startFlow({ steps: [{ name: 'only', to: 'role:editor', text: 'wait' }] }, '')
      await expect(writer.identity.cancelFlow(waiting.id)).rejects.toThrow(/starter or an admin/)
      expect((await boss.identity.cancelFlow(waiting.id)).state).toBe('canceled')
      expect((await boss.identity.getJob(waiting.jobs.only!))?.state).toBe('canceled')
      await expect(boss.identity.startFlow({ steps: [] }, '')).rejects.toThrow(/steps/)
      // A field the rules would ignore is refused, from any client.
      await expect(boss.identity.startFlow({ steps: [{ name: 'a', to: null, text: 'x', depends_on: [] }] } as never, '')).rejects.toThrow(/did you mean after/)

      // A start key: a repeat gives the same run, posting its steps once.
      const once: FlowSpec = { steps: [{ name: 'only', to: 'role:editor', text: 'once' }] }
      const first = await boss.identity.startFlow(once, 'in', { key: 'k1' })
      const again = await boss.identity.startFlow(once, 'in', { key: 'k1' })
      expect(again.id).toBe(first.id)
      expect(again.jobs.only).toBe(first.jobs.only)
      expect((await boss.identity.listJobs()).filter((j) => j.spec.text === 'once')).toHaveLength(1)
      await expect(boss.identity.startFlow(once, 'other', { key: 'k1' })).rejects.toThrow(/different workflow/)
      expect((await boss.identity.startFlow(once, 'in', { key: 'k2' })).id).not.toBe(first.id)
      // The same key from another member is their own run.
      expect((await writer.identity.startFlow(once, 'in', { key: 'k1' })).id).not.toBe(first.id)
      await expect(boss.identity.startFlow(once, 'in', { key: '' })).rejects.toThrow(/start key/)
      // Nobody else can take a member's keyed id first: the rules ignore it.
      const group = Buffer.from(boss.identity.base.key).toString('hex')
      const squat = keyedFlowId(group, boss.identity.self, 'k3')
      await writer.identity.base.append({ type: 'flow.start', flow: { id: squat, key: 'k3', input: 'in', steps: once.steps } })
      await writer.identity.base.append({ type: 'flow.start', flow: { id: squat, input: 'in', steps: once.steps } })
      expect(await writer.identity.base.flow(squat)).toBeNull()
      expect((await boss.identity.startFlow(once, 'in', { key: 'k3' })).id).toBe(squat)
    } finally {
      await writer.worker.close()
    }
  }, 90_000)
})

describe('workflow start keys', () => {
  it('make an id per group, starter and key, in a range no other start can use', () => {
    const steps = [{ name: 'a', to: null, text: 'x' }]
    const id = keyedFlowId('g1', 'me', 'k')
    expect(keyedFlowId('g1', 'me', 'k')).toBe(id)
    expect(new Set([id, keyedFlowId('g2', 'me', 'k'), keyedFlowId('g1', 'you', 'k'), keyedFlowId('g1', 'me', 'k2')]).size).toBe(4)
    expect(parseFlowOp({ type: 'flow.start', flow: { id, key: 'k', input: '', steps } })).not.toBeNull()
    // Without its key, or with an unkeyed id: refused.
    expect(parseFlowOp({ type: 'flow.start', flow: { id, input: '', steps } })).toBeNull()
    expect(parseFlowOp({ type: 'flow.start', flow: { id: '0' + id.slice(1), key: 'k', input: '', steps } })).toBeNull()
    expect(parseFlowOp({ type: 'flow.start', flow: { id: '0' + id.slice(1), input: '', steps } })).not.toBeNull()
    expect(parseFlowOp({ type: 'flow.start', flow: { id, key: '', input: '', steps } })).toBeNull()
  })

})
