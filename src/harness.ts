// Agent harnesses as message handlers: Claude Code, Codex and Antigravity,
// run headless per message. Each streams its answer back as one text
// artifact, keeps one harness session per A2A context (so the jobs of a
// thread, or the steps of a workflow, continue one conversation), and is
// stopped when the task is canceled.

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { MessageHandler } from './server.js'
import { agentText, textOf } from './cli/handlers.js'
import { atomicWrite, readJson } from './util/files.js'
import { killGroup, spawnGroup } from './util/spawn.js'

export const HARNESSES = ['claude', 'codex', 'antigravity'] as const
export type HarnessName = typeof HARNESSES[number]
// Other names a harness goes by.
const ALIASES: Record<string, HarnessName> = { 'claude-code': 'claude', agy: 'antigravity' }

export function harnessName (name: string): HarnessName | null {
  const n = name.toLowerCase()
  return (HARNESSES as readonly string[]).includes(n) ? n as HarnessName : ALIASES[n] ?? null
}

export interface HarnessOptions {
  // The harness's model (its own names: haiku, gpt-5.5, …); default its own.
  model?: string
  // Said once at the start of each session: the agent's role, say.
  instructions?: string
  // Let it edit files in `cwd`. Default: it may only read.
  write?: boolean
  // Where it runs; default the daemon's directory.
  cwd: string
  // Where session ids are kept (a JSON file).
  sessions: string
  // The environment to pick the harness's from (default process.env):
  // only what its login, network and locale need (ENV_KEEP), so it never
  // attaches to a session the daemon was started from.
  env?: NodeJS.ProcessEnv
}

// One turn of a harness.
interface Turn {
  prompt: string
  session: string | null
  model?: string
  write: boolean
}

// What a run reports as it goes: text so far (replacing what came before
// when `replace`), the session, and at the end the final answer or why it
// failed (`maybe`: an error the turn may still recover from).
interface Events {
  text (chunk: string, replace?: boolean): void
  session (id: string): void
  final (text: string): void
  error (why: string, maybe?: boolean): void
  // The turn went through: errors it recovered from don't count.
  ok (): void
}

interface Adapter {
  bin: string
  args (t: Turn): string[]
  // The prompt on stdin (else it's in the arguments).
  stdin: boolean
  // One line of the harness's JSON output.
  line (event: any, on: Events): void
}

// The longest single argument Linux takes (MAX_ARG_STRLEN), for harnesses
// that only take the prompt as one.
const MAX_ARG = 128 * 1024 - 1
const READ_TOOLS = 'Read,Grep,Glob'

const ADAPTERS: Record<HarnessName, Adapter> = {
  claude: {
    bin: 'claude',
    stdin: true,
    // Read only: its read tools, nothing it would ask about. No slash
    // commands either way: a message is only ever a message.
    args: (t) => [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--disable-slash-commands',
      ...(t.write ? ['--permission-mode', 'acceptEdits'] : ['--permission-mode', 'dontAsk', '--tools', READ_TOOLS]),
      ...(t.model ? ['--model', t.model] : []),
      ...(t.session ? ['--resume', t.session] : [])
    ],
    line (e, on) {
      if (typeof e?.session_id === 'string') on.session(e.session_id)
      if (e?.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') on.text(e.event.delta.text)
      // A new message after a tool call: what came before was on the way.
      else if (e?.type === 'stream_event' && e.event?.type === 'message_start') on.text('', true)
      else if (e?.type === 'result') {
        if (e.is_error === true || e.subtype !== 'success') on.error(typeof e.result === 'string' && e.result ? e.result : `claude stopped: ${e.subtype ?? 'error'}`)
        else on.final(typeof e.result === 'string' ? e.result : '')
      }
    }
  },
  codex: {
    bin: 'codex',
    stdin: true,
    args: (t) => t.session
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${t.write ? 'workspace-write' : 'read-only'}"`, ...(t.model ? ['-m', t.model] : []), t.session, '-']
      : ['exec', '--json', '--skip-git-repo-check', '-s', t.write ? 'workspace-write' : 'read-only', ...(t.model ? ['-m', t.model] : []), '-'],
    line (e, on) {
      if (e?.type === 'thread.started' && typeof e.thread_id === 'string') on.session(e.thread_id)
      // Each message as it's done; the last one is the answer.
      else if (e?.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') on.text(e.item.text, true)
      else if (e?.type === 'turn.failed') on.error(e.error?.message ?? 'codex: the turn failed')
      // A stream error it may reconnect from: only if the turn never completes.
      else if (e?.type === 'error' && typeof e.message === 'string') on.error(e.message, true)
      else if (e?.type === 'turn.completed') on.ok()
    }
  },
  antigravity: {
    bin: 'agy',
    stdin: false,
    // Read only: plan mode (it answers, and plans changes instead of making
    // them). Its slash commands can't be turned off in plan mode, so a
    // message starting with '/' is defused instead (see `prompt`).
    args: (t) => [
      '--output-format', 'stream-json',
      '--mode', t.write ? 'accept-edits' : 'plan',
      ...(t.model ? ['--model', t.model] : []),
      ...(t.session ? ['--conversation', t.session] : []),
      `--print=${t.prompt}`
    ],
    line (e, on) {
      const id = e?.conversation_id ?? e?.step_update?.conversation_id ?? e?.result?.conversation_id
      if (typeof id === 'string') on.session(id)
      const step = e?.step_update
      if (e?.event === 'step_update' && step?.step_type === 'agent_response' && typeof step.text_delta === 'string') on.text(step.text_delta)
      else if (e?.event === 'result') {
        if (e.result?.status !== 'SUCCESS') on.error(`antigravity stopped: ${e.result?.status ?? 'error'}`)
        else on.final(typeof e.result.response === 'string' ? e.result.response : '')
      }
    }
  }
}

// What a harness gets from the daemon's environment: the system, the
// locale, where its login lives (or its API keys), and the network's
// proxies and certificates.
const ENV_KEEP = [
  'HOME', 'PATH', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
]
// How many contexts' sessions are kept (the least recently used go first).
const MAX_SESSIONS = 2000

interface Outcome { ok: boolean, why: string, final: string | null, session: string | null, said: boolean, heard: boolean }

export interface HarnessHandler extends MessageHandler {
  // Stops the runs still going, and starts no more: for shutdown.
  stop (): void
}

// A message handler that runs `name` per message.
export function harnessHandler (name: HarnessName, opts: HarnessOptions): HarnessHandler {
  const adapter = ADAPTERS[name]
  const from = opts.env ?? process.env
  const env = Object.fromEntries(ENV_KEEP.flatMap((k) => from[k] !== undefined ? [[k, from[k]]] : []))
  const running = new Set<number>()
  let stopped = false
  // One turn at a time per context: a session takes turns in order.
  const queues = new Map<string, Promise<unknown>>()
  let sessions: Promise<Map<string, string>> | null = null
  let saving = Promise.resolve()
  const store = async (): Promise<Map<string, string>> => {
    sessions ??= readJson<Record<string, string>>(opts.sessions).then((o) => new Map(Object.entries(o ?? {})), () => new Map())
    return await sessions
  }
  // In order, and done before the task completes.
  const save = async (map: Map<string, string>): Promise<void> => {
    while (map.size > MAX_SESSIONS) map.delete(map.keys().next().value!)
    const data = JSON.stringify(Object.fromEntries(map))
    saving = saving.then(async () => { await atomicWrite(opts.sessions, data) }).catch(() => {})
    await saving
  }

  const handler: MessageHandler = async (message, task) => {
    if (stopped) {
      await task.update('TASK_STATE_FAILED', agentText('The agent is shutting down'))
      return
    }
    await task.update('TASK_STATE_WORKING')
    const key = createHash('sha256').update(`${name}\0${opts.cwd}\0${task.task.contextId}`).digest('hex').slice(0, 32)
    const before = queues.get(key) ?? Promise.resolve()
    let release = (): void => {}
    const mine = new Promise<void>((resolve) => { release = resolve })
    const chained = before.then(() => mine)
    queues.set(key, chained)
    try {
      await before
      if (task.signal.aborted) return
      if (stopped) {
        await task.update('TASK_STATE_FAILED', agentText('The agent is shutting down'))
        return
      }
      const map = await store()
      const known = map.get(key) ?? null
      let text = textOf(message.parts)
      // A message is never one of the harness's slash commands.
      if (name === 'antigravity' && text.trimStart().startsWith('/')) text = `Message:\n${text}`
      const prompt = (session: string | null): string => !session && opts.instructions ? `${opts.instructions}\n\n${text}` : text

      // The answer so far, streamed as one artifact: chunks appended, or
      // the whole replaced (a harness's next message, after a tool call).
      let streamed = ''
      let started = false
      let sent = Promise.resolve()
      const show = (chunk: string, replace = false): void => {
        if (replace) streamed = chunk
        else if (chunk === '') return
        else streamed += chunk
        if (!started && chunk === '') return
        const append = started && !replace
        started = true
        sent = sent.then(async () => { await task.artifact({ artifactId: 'output', parts: [{ text: chunk }] }, { append }) })
      }
      const turn = async (session: string | null): Promise<Outcome> => {
        const t: Turn = { prompt: prompt(session), session, write: opts.write === true, ...(opts.model ? { model: opts.model } : {}) }
        if (!adapter.stdin && Buffer.byteLength(`--print=${t.prompt}`) > MAX_ARG) return { ok: false, why: `The message is over ${MAX_ARG >> 10} KiB, more than ${name} takes`, final: null, session, said: false, heard: false }
        try {
          return await run(adapter, t, opts.cwd, env, task.signal, running, show)
        } catch (err) {
          return { ok: false, why: (err as Error).message, final: null, session, said: false, heard: false }
        }
      }
      let out = await turn(known)
      // A session the harness can't resume (cleaned up, say) fails before
      // it says anything at all: start afresh. Any other failure keeps the
      // session (a rate limit shouldn't cost a thread its history).
      if (!out.ok && known && !out.heard && !task.signal.aborted && !stopped) {
        streamed = ''
        out = await turn(null)
      }
      await sent
      if (task.signal.aborted) return
      if (out.ok && out.session) {
        // Most recently used last, so the oldest go first.
        map.delete(key)
        map.set(key, out.session)
        await save(map)
      }
      if (!out.ok) {
        await task.update('TASK_STATE_FAILED', agentText(stopped ? 'The agent is shutting down' : out.why))
        return
      }
      // The final answer stands for whatever streamed on the way.
      const answer = out.final ?? streamed
      if (answer !== streamed || streamed === '') await task.artifact({ artifactId: 'output', parts: [{ text: answer }] }, { append: false })
      await task.artifact({ artifactId: 'output', parts: [{ text: '' }] }, { append: true, lastChunk: true })
      await task.update('TASK_STATE_COMPLETED')
    } finally {
      release()
      if (queues.get(key) === chained) queues.delete(key)
    }
  }
  return Object.assign(handler, {
    stop () {
      stopped = true
      for (const pid of running) killGroup(pid)
    }
  })
}

async function run (adapter: Adapter, t: Turn, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, running: Set<number>, show: (chunk: string, replace?: boolean) => void): Promise<Outcome> {
  let session: string | null = t.session
  let final: string | null = null
  let error: string | null = null
  let maybe: string | null = null
  let said = false
  let heard = false
  const on: Events = {
    text: (chunk, replace) => { if (chunk) said = true; show(chunk, replace) },
    session: (id) => { session = id },
    final: (text) => { final = text },
    error: (why, tentative) => { if (tentative) maybe ??= why; else error ??= why },
    ok: () => { maybe = null }
  }
  const { child, done } = spawnGroup(adapter.bin, adapter.args(t), { cwd, env }, signal, running)
  child.stdin.end(adapter.stdin ? t.prompt : '')
  let buf = ''
  const parse = (line: string): void => {
    if (!line.trim()) return
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      return // not an event (a warning, say)
    }
    heard = true
    adapter.line(event, on)
  }
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (s: string) => {
    buf += s
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      parse(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  })
  const { code, stderr, error: spawnError } = await done
  parse(buf) // a last event with no newline after it
  if (spawnError) error ??= spawnError.code === 'ENOENT' ? `${adapter.bin} is not installed (or not on PATH)` : spawnError.message
  error ??= maybe
  if (error === null && code !== 0) error = stderr.trim() || `${adapter.bin} exited with code ${code}`
  return { ok: error === null, why: error ?? '', final, session, said, heard }
}

// Where a daemon keeps its harness sessions.
export function sessionsFile (storage: string): string {
  return join(storage, 'harness-sessions.json')
}
