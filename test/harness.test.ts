import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Artifact, Message, TaskState } from '../src/a2a/types.js'
import { harnessHandler, harnessName } from '../src/harness.js'
import type { HarnessName } from '../src/harness.js'
import type { TaskHandle } from '../src/server.js'

// Stand-ins for the harness CLIs: each prints what the real one streams.
// The prompt "sleep" runs until killed; a session "gone" can't be resumed;
// a prompt with "tool" talks, calls a tool, then answers.
const FAKE_CLAUDE = `#!/usr/bin/env node
const args = process.argv.slice(2)
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null
let prompt = ''
process.stdin.on('data', (d) => { prompt += d })
process.stdin.on('end', () => {
  if (resume === 'gone') { process.stderr.write('No conversation found'); process.exit(1) }
  const session = resume ?? 'claude-' + Math.random().toString(16).slice(2)
  const out = (e) => process.stdout.write(JSON.stringify({ ...e, session_id: session }) + '\\n')
  out({ type: 'system', subtype: 'init' })
  if (prompt.includes('sleep')) return setTimeout(() => {}, 30000)
  if (prompt.includes('flags')) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: args.join(' '), session_id: session })); return }
  if (prompt.includes('overloaded')) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API overloaded' }); process.exit(1) }
  const delta = (text) => out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  if (prompt.includes('tool')) { out({ type: 'stream_event', event: { type: 'message_start' } }); delta('Let me look.') }
  out({ type: 'stream_event', event: { type: 'message_start' } })
  const answer = 'said: ' + prompt + (resume ? ' (resumed ' + resume + ')' : '')
  delta(answer.slice(0, 5)); delta(answer.slice(5))
  out({ type: 'result', subtype: 'success', is_error: false, result: answer })
})
`
const FAKE_CODEX = `#!/usr/bin/env node
const args = process.argv.slice(2)
const resume = args[1] === 'resume' ? args[args.length - 2] : null
let prompt = ''
process.stdin.on('data', (d) => { prompt += d })
process.stdin.on('end', () => {
  const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n')
  if (!resume) out({ type: 'thread.started', thread_id: 'codex-1' })
  if (prompt.includes('fail')) { out({ type: 'turn.failed', error: { message: 'model refused' } }); process.exit(1) }
  if (prompt.includes('blip')) out({ type: 'error', message: 'Reconnecting... 1/5' })
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'thinking' } })
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'codex: ' + prompt + (resume ? ' @' + resume : '') + ' ' + args.filter((a) => a.includes('sandbox') || a === 'read-only' || a === 'workspace-write').join(',') } })
  out({ type: 'turn.completed' })
})
`
const FAKE_AGY = `#!/usr/bin/env node
const args = process.argv.slice(2)
const prompt = args.find((a) => a.startsWith('--print=')).slice(8)
const conv = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : 'agy-1'
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n')
out({ event: 'init', conversation_id: conv })
if (prompt.includes('flags')) { out({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: args.slice(0, -1).join(' ') + ' | ' + prompt } }); process.exit(0) }
out({ event: 'step_update', step_update: { conversation_id: conv, step_type: 'agent_response', text_delta: 'agy: ' } })
out({ event: 'step_update', step_update: { conversation_id: conv, step_type: 'agent_response', text_delta: prompt } })
out({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: 'agy: ' + prompt } })
`

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pai-harness-'))
  for (const [bin, src] of [['claude', FAKE_CLAUDE], ['codex', FAKE_CODEX], ['agy', FAKE_AGY]] as const) {
    await writeFile(join(dir, bin), src)
    await chmod(join(dir, bin), 0o755)
  }
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

// A task handle that records what the handler does.
function handle (contextId: string) {
  const states: TaskState[] = []
  const chunks: Array<{ text: string, append: boolean, last: boolean }> = []
  let failure = ''
  const abort = new AbortController()
  const task: TaskHandle = {
    task: { id: 't-' + Math.random(), contextId, status: { state: 'TASK_STATE_SUBMITTED' } } as TaskHandle['task'],
    signal: abort.signal,
    async update (state: TaskState, message?: Message) {
      states.push(state)
      if (message) failure = message.parts.map((p) => 'text' in p ? p.text : '').join('')
    },
    async artifact (a: Artifact, opts?: { append?: boolean, lastChunk?: boolean }) {
      chunks.push({ text: a.parts.map((p) => 'text' in p ? p.text : '').join(''), append: opts?.append === true, last: opts?.lastChunk === true })
    }
  }
  // The artifact as a client sees it, chunk by chunk.
  const output = (): string => chunks.reduce((s, c) => c.append ? s + c.text : c.text, '')
  return { task, states, chunks, output, abort, failure: () => failure }
}

const say = (text: string): Message => ({ role: 'ROLE_USER', messageId: 'm-' + Math.random(), parts: [{ text }] })

function make (name: HarnessName, extra: { instructions?: string, write?: boolean } = {}) {
  return harnessHandler(name, { cwd: dir, sessions: join(dir, `${name}-sessions.json`), env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir }, ...extra })
}

describe('harnesses', () => {
  it('knows the harnesses by their names', () => {
    expect(harnessName('Claude')).toBe('claude')
    expect(harnessName('claude-code')).toBe('claude')
    expect(harnessName('agy')).toBe('antigravity')
    expect(harnessName('vim')).toBeNull()
  })

  it('streams Claude Code\'s answer, keeps a session per context, and says the instructions once', async () => {
    const claude = make('claude', { instructions: 'Be brief.' })
    const a = handle('ctx-1')
    await claude(say('hi'), a.task)
    expect(a.states).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_COMPLETED'])
    expect(a.output()).toBe('said: Be brief.\n\nhi')
    expect(a.chunks.length).toBeGreaterThan(2) // streamed, then closed
    expect(a.chunks.at(-1)).toMatchObject({ last: true })
    const sessions = JSON.parse(await readFile(join(dir, 'claude-sessions.json'), 'utf-8')) as Record<string, string>
    const id = Object.values(sessions)[0]!
    // The same context resumes the session, without the instructions again.
    const b = handle('ctx-1')
    await claude(say('again'), b.task)
    expect(b.output()).toBe(`said: again (resumed ${id})`)
    // Another context starts its own.
    const c = handle('ctx-2')
    await claude(say('new'), c.task)
    expect(c.output()).toBe('said: Be brief.\n\nnew')
  })

  it('keeps the final answer, not what was said on the way to a tool', async () => {
    const claude = make('claude')
    const a = handle('ctx-tool')
    await claude(say('use a tool'), a.task)
    expect(a.output()).toBe('said: use a tool')
  })

  it('starts afresh when a session can\'t be resumed', async () => {
    const file = join(dir, 'gone-sessions.json')
    const claude = harnessHandler('claude', { cwd: dir, sessions: file, env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir } })
    const a = handle('ctx-gone')
    await claude(say('first'), a.task)
    const sessions = JSON.parse(await readFile(file, 'utf-8')) as Record<string, string>
    const key = Object.keys(sessions)[0]!
    await writeFile(file, JSON.stringify({ [key]: 'gone' }))
    const fresh = harnessHandler('claude', { cwd: dir, sessions: file, env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir } })
    const b = handle('ctx-gone')
    await fresh(say('second'), b.task)
    expect(b.states.at(-1)).toBe('TASK_STATE_COMPLETED')
    expect(b.output()).toBe('said: second')
    expect(JSON.parse(await readFile(file, 'utf-8'))[key]).not.toBe('gone')
  })

  it('stops the harness when the task is canceled', async () => {
    const claude = make('claude')
    const a = handle('ctx-sleep')
    const run = claude(say('sleep'), a.task)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const at = Date.now()
    a.abort.abort()
    await run
    expect(Date.now() - at).toBeLessThan(5000)
    expect(a.states).toEqual(['TASK_STATE_WORKING'])
  })

  it('runs Codex read-only (or writing), resumes its thread, and fails with its error', async () => {
    const codex = make('codex')
    const a = handle('ctx-codex')
    await codex(say('hi'), a.task)
    expect(a.output()).toBe('codex: hi read-only')
    const b = handle('ctx-codex')
    await codex(say('again'), b.task)
    expect(b.output()).toBe('codex: again @codex-1 sandbox_mode="read-only"')
    const writing = make('codex', { write: true })
    const c = handle('ctx-codex-w')
    await writing(say('edit'), c.task)
    expect(c.output()).toBe('codex: edit workspace-write')
    const d = handle('ctx-codex-f')
    await codex(say('fail'), d.task)
    expect(d.states.at(-1)).toBe('TASK_STATE_FAILED')
    expect(d.failure()).toBe('model refused')
  })

  it('runs Antigravity with the prompt as an argument, and continues its conversation', async () => {
    const agy = make('antigravity')
    const a = handle('ctx-agy')
    await agy(say('hello'), a.task)
    expect(a.output()).toBe('agy: hello')
    const b = handle('ctx-agy')
    await agy(say('more'), b.task)
    expect(b.states.at(-1)).toBe('TASK_STATE_COMPLETED')
  })

  it('runs read only unless it may write, and never takes a message as a slash command', async () => {
    const a = handle('ctx-flags')
    await make('claude')(say('flags'), a.task) // its result arrives with no newline after it
    expect(a.output()).toMatch(/--disable-slash-commands --permission-mode dontAsk --tools Read,Grep,Glob/)
    const b = handle('ctx-flags-w')
    await make('claude', { write: true })(say('flags'), b.task)
    expect(b.output()).toMatch(/--permission-mode acceptEdits/)
    expect(b.output()).not.toMatch(/--tools/)
    const c = handle('ctx-agy-flags')
    await make('antigravity')(say('/help flags'), c.task)
    expect(c.output()).toBe('--output-format stream-json --mode plan | Message:\n/help flags')
    const d = handle('ctx-agy-flags-w')
    await make('antigravity', { write: true })(say('flags'), d.task)
    expect(d.output()).toMatch(/--mode accept-edits/)
  })

  it('keeps a session through a failed turn, and Codex through an error it recovers from', async () => {
    const file = join(dir, 'keep-sessions.json')
    const claude = harnessHandler('claude', { cwd: dir, sessions: file, env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir } })
    const a = handle('ctx-keep')
    await claude(say('first'), a.task)
    const before = await readFile(file, 'utf-8')
    const b = handle('ctx-keep')
    await claude(say('overloaded'), b.task)
    expect(b.states.at(-1)).toBe('TASK_STATE_FAILED')
    expect(b.failure()).toBe('API overloaded')
    expect(await readFile(file, 'utf-8')).toBe(before)
    const c = handle('ctx-blip')
    await make('codex')(say('blip'), c.task)
    expect(c.states.at(-1)).toBe('TASK_STATE_COMPLETED')
  })

  it('starts nothing once stopped', async () => {
    const claude = make('claude')
    const a = handle('ctx-stop')
    const run = claude(say('sleep'), a.task)
    const b = handle('ctx-stop') // queued behind it, in the same context
    const queued = claude(say('next'), b.task)
    await new Promise((resolve) => setTimeout(resolve, 500))
    claude.stop()
    await run
    await queued
    expect(a.states.at(-1)).toBe('TASK_STATE_FAILED')
    expect(b.states).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_FAILED'])
    expect(b.failure()).toBe('The agent is shutting down')
    const c = handle('ctx-after')
    await claude(say('hi'), c.task)
    expect(c.states).toEqual(['TASK_STATE_FAILED'])
  })

  it('says so when the harness isn\'t installed', async () => {
    const missing = harnessHandler('claude', { cwd: dir, sessions: join(dir, 'x.json'), env: { PATH: '/nonexistent', HOME: dir } })
    const a = handle('ctx-x')
    await missing(say('hi'), a.task)
    expect(a.states.at(-1)).toBe('TASK_STATE_FAILED')
    expect(a.failure()).toMatch(/claude is not installed/)
  })
})
