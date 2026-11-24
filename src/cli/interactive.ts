import { Readable, Writable } from 'node:stream'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { CliIo } from './main.js'
import { CONFIG_FILE, CliError, exists } from './config.js'

type RunCommand = (argv: string[], io: CliIo) => Promise<number>

const PROMPT = 'pai> '

// Words that mean "a command", typed at the setup prompt by someone who
// didn't notice it was asking for a name.
const COMMANDS: ReadonlySet<string> = new Set(['help', 'exit', 'quit', 'shell', 'serve', 'init', 'id', 'daemon', 'card', 'send', 'task', 'group', 'outbox', 'mailbox', 'device', 'job', 'flow', 'inbox', 'ui'])

// `pai shell` (and `pai` alone on a terminal): read commands a line at a
// time and run each one. `flags` (--config) go in front of every command.
//
// On a terminal (stdin and stdout both TTYs) it shows a prompt, and with no
// pai.json yet it first asks for what `pai init` needs. Ctrl-C stops the
// running command; a second Ctrl-C while that command is still running
// leaves the shell with 130. At the prompt, Ctrl-C clears the line or, on
// an empty one, leaves, as Ctrl-D and `exit` do. A terminal session exits 0.
//
// Otherwise (a script piped in, or output piped out) there is no prompt or
// setup, and it exits with the last command's code.
export async function interactive (config: string | undefined, io: CliIo, runCommand: RunCommand): Promise<number> {
  if (io.shell) throw new CliError('already in pai shell', 2)
  const tty = io.stdin.isTTY === true && io.stdout.isTTY === true
  const flags = config === undefined ? [] : [`--config=${config}`]

  // On a terminal readline writes through `output`, so a hidden prompt
  // can mute its echo.
  let muted = false
  const rl = createInterface({
    input: io.stdin,
    ...(tty ? { output: terminalOutput(io, () => muted), terminal: true, historySize: 1000 } : { terminal: false })
  })
  const lines = rl[Symbol.asyncIterator]()
  let current: AbortController | null = null
  let force: (() => void) | null = null
  let closed = false
  rl.on('close', () => {
    if (tty && !closed && !current) io.stdout.write('\n') // Ctrl-D or Ctrl-C at the prompt
    closed = true
  })
  rl.on('SIGINT', () => {
    if (current) {
      // Readline holds the terminal in raw mode, so the bin never sees this
      // SIGINT: a command that ignores its signal is left on the second one.
      if (current.signal.aborted) force?.()
      else current.abort()
    } else if (rl.line) {
      rl.write(null, { ctrl: true, name: 'e' })
      rl.write(null, { ctrl: true, name: 'u' })
    } else {
      rl.close()
    }
  })
  const stop = () => {
    current?.abort()
    rl.close()
  }
  io.signal?.addEventListener('abort', stop, { once: true })

  // The next line, after `prompt` on a TTY; null once input ends. Input that
  // ended while a command ran (Ctrl-D, or EOF on a pipe) closed readline:
  // the lines it already read still come, without a prompt. A `hidden`
  // answer isn't echoed.
  const next = async (prompt: string, hidden = false): Promise<string | null> => {
    if (tty && !closed) {
      // Muted before prompt(): resuming input can echo keys typed ahead
      // right away, so the hidden prompt writes its own text.
      muted = hidden
      if (hidden) io.stdout.write(`\x1b[1G\x1b[0J${prompt}`)
      rl.setPrompt(prompt)
      rl.prompt()
    }
    try {
      const { value, done } = await lines.next()
      return done ? null : value
    } finally {
      if (muted) io.stdout.write('\n')
      muted = false
    }
  }
  let forced = false
  const exec = async (argv: string[]): Promise<number> => {
    current = new AbortController()
    const abandoned = new Promise<number>((resolve) => { force = () => { forced = true; resolve(130) } })
    try {
      return await Promise.race([abandoned, runCommand(argv, {
        ...io,
        // Commands don't read the shell's input (`send` with no text says so).
        stdin: Readable.from([]),
        signal: current.signal,
        shell: true
      })])
    } finally {
      current = null
      force = null
    }
  }

  if (tty) io.stdout.write('pai shell: type a command without `pai` (`help` lists them), `exit` to leave\n')
  let code = 0
  let explicit = false // `exit <n>` sets the exit code, on a terminal too
  try {
    // A line typed at the setup prompt that was really a command.
    let pending: string | null = null
    // `pai init` writes ./pai.json, so only offer it when that's the config in use.
    if (tty && config === undefined && !await exists(resolve(io.cwd, CONFIG_FILE))) {
      const answer = await askInit(next, io)
      clearHistory(rl) // the answers, the invite code among them, stay out of Up-arrow
      if (answer && 'line' in answer) pending = answer.line
      else if (answer) await exec([...flags, ...answer.args])
    }
    for (let line = pending ?? await next(PROMPT); line !== null; line = await next(PROMPT)) {
      let words: string[]
      try {
        words = splitLine(line)
      } catch (err) {
        io.stderr.write(`pai: ${(err as Error).message}\n`)
        words = []
        code = 2
      }
      if (words[0] === 'pai') words.shift()
      const [command, ...args] = words
      if (command === 'exit' || command === 'quit') {
        closed = true
        if (args.length) {
          const status = Number(args[0])
          if (!Number.isInteger(status) || status < 0 || status > 255) {
            io.stderr.write(`pai: ${command} wants a status from 0 to 255, got ${args[0]}\n`)
            code = 2
          } else {
            code = status
            explicit = true
          }
        }
        break
      }
      if (command) code = await exec([...flags, ...words])
      if (forced || io.signal?.aborted) break
    }
  } finally {
    io.signal?.removeEventListener('abort', stop)
    rl.close()
  }
  if (forced) {
    io.stderr.write('pai: left without waiting for the command to stop\n')
    return 130
  }
  return tty && !explicit ? 0 : code
}

// Readline's output on a terminal: io.stdout, muted while `muted()`, with its
// width and resize events so long lines redraw.
function terminalOutput (io: CliIo, muted: () => boolean): Writable {
  const output = new Writable({
    write (chunk: Buffer, _enc, cb) {
      if (!muted()) io.stdout.write(chunk.toString())
      cb()
    }
  })
  Object.defineProperty(output, 'isTTY', { value: true })
  Object.defineProperty(output, 'columns', { get: () => io.stdout.columns ?? 80 })
  const source = io.stdout as Partial<Pick<Writable, 'on' | 'off'>>
  if (source.on && source.off) {
    const resize = () => output.emit('resize')
    source.on('resize', resize)
    output.once('close', () => source.off!('resize', resize))
  }
  return output
}

function clearHistory (rl: ReturnType<typeof createInterface>): void {
  const history = (rl as unknown as { history?: string[] }).history
  if (history) history.length = 0
}

// Asks for `pai init`'s options and returns its arguments; or `line` when
// the "name" was a command (`help`, `pai id`), to run instead of setting
// up; or null to skip setup (a blank name, or input that ended).
async function askInit (next: (prompt: string, hidden?: boolean) => Promise<string | null>, io: CliIo): Promise<{ args: string[] } | { line: string } | null> {
  io.stdout.write(`No ${CONFIG_FILE} here yet: set up this agent (blank name to skip).\n`)
  const name = (await next('Name: '))?.trim()
  if (!name) return null
  if (looksLikeCommand(name)) {
    io.stdout.write('That looks like a command, so setup is skipped.\n')
    return { line: name }
  }
  const description = await next(`Description [${name} agent]: `)
  if (description === null) return null
  const code = await next('Invite code to join a group, not shown (blank: start a group of your own): ', true)
  if (code === null) return null
  const args = ['init', `--name=${name}`]
  if (description.trim()) args.push(`--description=${description.trim()}`)
  return { args: code.trim() ? [...args, `--join=${code.trim()}`] : args }
}

// `pai …`, or a lone command word. "Group Bot" or "send-bot" is a name.
function looksLikeCommand (name: string): boolean {
  let words: string[]
  try {
    words = splitLine(name)
  } catch {
    return false
  }
  return words[0] === 'pai' || (words.length === 1 && COMMANDS.has(words[0]!))
}

// Splits a line into words the way a POSIX shell does for the simple cases:
// whitespace separates and quotes group. Outside quotes a backslash escapes
// the next character; inside double quotes it escapes only " \ $ and `, and
// is kept before anything else; inside single quotes it's literal. A `#`
// that starts a word starts a comment, to the end of the line.
export function splitLine (line: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) word += line[++i]
      else word += c
    } else if (c === '#' && !inWord) {
      break
    } else if (c === '"' || c === '\'') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
      inWord = true
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else {
      word += c
      inWord = true
    }
  }
  if (quote) throw new CliError(`unclosed ${quote}`, 2)
  if (inWord) words.push(word)
  return words
}
