import type { JobRecord } from '../src/group/jobs.js'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import createTestnet from 'hyperdht/testnet'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../src/cli/main.js'
import { splitLine } from '../src/cli/interactive.js'
import type { CliIo } from '../src/cli/main.js'
import { waitFor } from './helpers.js'

let testnet: Awaited<ReturnType<typeof createTestnet>>
let bootstrap: string[]
const cleanup: Array<() => Promise<unknown>> = []

beforeAll(async () => {
  testnet = await createTestnet(3)
  bootstrap = testnet.bootstrap.map((n) => `--bootstrap=${typeof n === 'string' ? n : `${n.host}:${n.port}`}`)
})
afterAll(async () => { await testnet.destroy() })
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function tempdir (): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pai-cli-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface Result { code: number, out: string, err: string }

// Runs the CLI in `cwd` and collects its output.
async function pai (cwd: string, args: string[], opts: { stdin?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal } = {}): Promise<Result> {
  const out: string[] = []
  const err: string[] = []
  const stdin = Readable.from(opts.stdin === undefined ? [] : [Buffer.from(opts.stdin)]) as CliIo['stdin']
  if (opts.stdin === undefined) stdin.isTTY = true
  const code = await run(args, {
    cwd,
    env: { HOME: cwd, ...opts.env },
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    stdin,
    ...(opts.signal ? { signal: opts.signal } : {})
  })
  return { code, out: out.join(''), err: err.join('') }
}

// Starts `pai daemon` (gateway on a free port) and resolves with its id and
// gateway URL once it's listening.
async function daemon (cwd: string, args: string[]): Promise<{ id: string, device: string, gateway: string, log: () => string, stop: () => Promise<void> }> {
  const controller = new AbortController()
  const out: string[] = []
  const timeout = args.some((a) => a.startsWith('--timeout')) ? [] : ['--timeout=10000']
  const done = run(['daemon', ...args, '--listen=127.0.0.1:0', ...bootstrap, ...timeout], {
    cwd,
    env: { HOME: cwd },
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => out.push(s) },
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
    signal: controller.signal
  })
  cleanup.push(async () => { controller.abort(); await done })
  for (let i = 0; i < 200; i++) {
    const id = /^id: ([0-9a-f]{64})$/m.exec(out.join(''))?.[1]
    const gateway = /^gateway: (\S+)\/agents\/<id>/m.exec(out.join(''))?.[1]
    // In a group, `device:` follows `id:` (the identity); otherwise they're one.
    const device = /^device: ([0-9a-f]{64})$/m.exec(out.join(''))?.[1] ?? id
    if (id && gateway && device) return { id, device, gateway, log: () => out.join(''), stop: async () => { controller.abort(); await done } }
    if (await Promise.race([done.then(() => true), sleep(50).then(() => false)])) break
  }
  throw new Error(`pai daemon did not start:\n${out.join('')}`)
}

// An agent in its own new group (it's the admin).
async function initAgent (name: string): Promise<string> {
  const dir = await tempdir()
  const res = await pai(dir, ['init', `--name=${name}`])
  expect(res.code, res.err).toBe(0)
  return dir
}

// An agent that joins `admin`'s default group with an invite (`admin`'s
// daemon must be running), in its own folder.
async function joined (admin: string, name: string, inviteArgs: string[] = []): Promise<{ dir: string, id: string }> {
  const invite = await pai(admin, ['group', 'invite', ...inviteArgs])
  expect(invite.code, invite.err).toBe(0)
  const dir = await tempdir()
  const join = await pai(dir, ['init', `--name=${name}`, `--join=${invite.out.trim()}`, ...bootstrap])
  expect(join.code, join.err).toBe(0)
  return { dir, id: (await pai(dir, ['id'])).out.trim() }
}

// An agent in `server`'s group with its daemon running, for `send`, `card`
// and `task` to call through.
async function caller (server: string): Promise<string> {
  const { dir } = await joined(server, 'caller')
  await daemon(dir, [])
  return dir
}

describe('pai init and id', () => {
  it('writes pai.json and a private groups file with a group of its own, and refuses to overwrite', async () => {
    const dir = await tempdir()
    const res = await pai(dir, ['init', '--name=Echo Bot'])
    expect(res.code, res.err).toBe(0)
    expect(res.out).toMatch(/Started group Echo-Bot, with this agent as its admin/)
    const config = JSON.parse(await readFile(join(dir, 'pai.json'), 'utf-8'))
    expect(config.card.name).toBe('Echo Bot')
    expect(config.identity).toBeUndefined()
    const file = join(dir, '.pai/groups.json')
    expect((await stat(file)).mode & 0o077).toBe(0)
    const groups = JSON.parse(await readFile(file, 'utf-8'))
    expect(groups).toMatchObject({ pai: 'groups/1', groups: [{ name: 'Echo-Bot' }] })
    expect((await readFile(join(dir, '.pai/default-group'), 'utf-8')).trim()).toBe('Echo-Bot')

    const again = await pai(dir, ['init', '--name=Other'])
    expect(again.code).toBe(1)
    expect(again.err).toMatch(/already exists/)
    // --force rewrites pai.json and keeps the identity.
    const forced = await pai(dir, ['init', '--name=Other', '--force'])
    expect(forced.code, forced.err).toBe(0)
    expect(forced.out).toMatch(/Kept this folder's identity/)
    expect(JSON.parse(await readFile(file, 'utf-8')).identity).toBe(groups.identity)
    expect((await pai(dir, ['init', '--name=x', '--join=a', '--device=b'])).code).toBe(2)
  })

  it('prints a stable id offline, the same one the daemon uses', async () => {
    const dir = await initAgent('ider')
    const first = await pai(dir, ['id'])
    expect(first.out).toMatch(/^[0-9a-f]{64}\n$/)
    expect((await pai(dir, ['id'])).out).toBe(first.out)
    const { id } = await daemon(dir, ['--echo'])
    expect(id).toBe(first.out.trim())
    // While the daemon holds the storage, `id` asks the daemon.
    expect((await pai(dir, ['id'])).out).toBe(first.out)
  })

  it('explains a missing config, unknown commands and bad flags', async () => {
    const dir = await tempdir()
    expect((await pai(dir, ['id'])).err).toMatch(/Run `pai init` first/)
    expect((await pai(dir, ['frobnicate'])).code).toBe(2)
    expect((await pai(dir, ['send', '--nope'])).code).toBe(2)
    expect((await pai(dir, ['--help'])).out).toMatch(/Usage: pai <command>/)
  })
})

describe('pai shell', () => {
  it('runs the commands it reads, a line at a time, with --config', async () => {
    const dir = await tempdir()
    const script = [
      'init --name "Line Bot"',
      '# a comment',
      '',
      'pai id',
      'help',
      'exit',
      'id'
    ].join('\n')
    const res = await pai(dir, [`--config=${join(dir, 'pai.json')}`, 'shell'], { stdin: script })
    expect(res.code, res.err).toBe(0)
    expect(JSON.parse(await readFile(join(dir, 'pai.json'), 'utf-8')).card.name).toBe('Line Bot')
    expect(res.out.match(/^[0-9a-f]{64}$/gm)).toHaveLength(1) // nothing runs after `exit`
    expect(res.out).toMatch(/Usage: pai <command>/)
  })

  it('exits with the last command\'s code, and keeps going after a failure', async () => {
    const dir = await tempdir()
    const res = await pai(dir, ['shell'], { stdin: 'frobnicate\nsend' })
    expect(res.code).toBe(2)
    expect(res.err).toMatch(/Unknown command: frobnicate/)
    expect(res.err).toMatch(/send needs an agent id/)
  })

  it('refuses a line with no command, and a shell inside the shell', async () => {
    const dir = await tempdir()
    const res = await pai(dir, ['shell'], { stdin: '--json\nshell\npai --config x.json' })
    expect(res.code).toBe(2)
    expect(res.err.match(/type a command/g)).toHaveLength(2)
    expect(res.err).toMatch(/already in pai shell/)
    expect(res.out).not.toMatch(/pai shell:/) // no second banner
  })

  it('takes only --config, and reads commands from stdin, not a file argument', async () => {
    const dir = await tempdir()
    const flag = await pai(dir, ['shell', '--json'], { stdin: 'id' })
    expect(flag.code).toBe(2)
    expect(flag.err).toMatch(/only --config, not --json/)
    const file = await pai(dir, ['shell', 'script.txt'], { stdin: 'id' })
    expect(file.code).toBe(2)
    expect(file.err).toMatch(/pai shell < script.txt/)
  })

  it('skips comments, even with a stray quote, and `exit <n>` sets the exit code', async () => {
    const dir = await tempdir()
    const res = await pai(dir, ['shell'], { stdin: "# don't run this\nhelp # print usage\nexit 3\nhelp" })
    expect(res.err).toBe('')
    expect(res.out.match(/Usage: pai <command>/g)).toHaveLength(1)
    expect(res.code).toBe(3)
    expect((await pai(dir, ['shell'], { stdin: 'exit nope' })).code).toBe(2)
  })

  it('a bare `pai` prints usage and exits 2 unless on a terminal, instead of waiting', async () => {
    const dir = await tempdir()
    const open = new PassThrough() // a pipe that never closes
    const err: string[] = []
    const code = await run([], { cwd: dir, env: { HOME: dir }, stdout: { write: () => {} }, stderr: { write: (s: string) => err.push(s) }, stdin: open })
    expect(code).toBe(2)
    expect(err.join('')).toMatch(/Usage: pai <command>/)
    expect((await pai(dir, ['help'])).code).toBe(0)
  })

  // Types `keys` into `pai` on a (pretend) terminal: stdin and stdout TTYs.
  // As [prompt, keys] steps, each step's keys go in once its prompt is shown,
  // the way a person types; a plain string arrives all at once, typed ahead.
  async function terminal (cwd: string, keys: string | Array<[string, string]>, argv: string[] = []): Promise<Result> {
    const out = Object.assign(new PassThrough(), { isTTY: true, columns: 80 })
    const chunks: string[] = []
    const input = typeof keys === 'string' ? Readable.from([Buffer.from(keys)]) : new PassThrough()
    const steps = typeof keys === 'string' ? [] : [...keys]
    let seen = 0
    out.on('data', (c: Buffer) => {
      chunks.push(c.toString())
      const shown = chunks.join('')
      while (steps.length && shown.indexOf(steps[0]![0], seen) !== -1) {
        seen = shown.indexOf(steps[0]![0], seen) + steps[0]![0].length
        ;(input as PassThrough).write(steps.shift()![1])
      }
    })
    const err: string[] = []
    const code = await run(argv, {
      cwd,
      env: { HOME: cwd },
      stdout: out,
      stderr: { write: (s: string) => err.push(s) },
      stdin: Object.assign(input, { isTTY: true })
    })
    return { code, out: chunks.join(''), err: err.join('') }
  }

  it('asks for what `pai init` needs when there is no pai.json, without echoing or keeping the invite code', async () => {
    const dir = await tempdir()
    const code = 'not-a-real-invite-code'
    // The Up arrow after setup would bring the code back if history kept it.
    const res = await terminal(dir, [
      ['Name: ', 'Prompt Bot\r'],
      ['Description', 'Answers questions\r'],
      ['not shown', `${code}\r`],
      ['pai> ', '\x1b[A\r'],
      ['pai> ', 'id\r'],
      ['pai> ', '\x04'] // Ctrl-D
    ])
    expect(res.out).toMatch(/No pai.json here yet/)
    expect(res.out).not.toContain(code)
    expect(res.err).toMatch(/not a pai invite code/) // the join, tried
    expect(res.err).not.toMatch(/Unknown command/)
    const config = JSON.parse(await readFile(join(dir, 'pai.json'), 'utf-8'))
    expect(config.card).toMatchObject({ name: 'Prompt Bot', description: 'Answers questions' })
    expect(res.out).toMatch(/[0-9a-f]{64}/) // `id` ran: the identity was made

    // Once there is one, it goes straight to the prompt.
    expect((await terminal(dir, 'exit\r')).out).not.toMatch(/No pai.json/)
  })

  it('skips setup on a blank name, and starts a group of its own on a blank code', async () => {
    const skipped = await tempdir()
    expect((await terminal(skipped, '\rexit\r')).code).toBe(0)
    expect(await stat(join(skipped, 'pai.json')).catch(() => null)).toBeNull()

    const member = await tempdir()
    const res = await terminal(member, 'Member\r\r\r')
    expect(res.out).toMatch(/Started group Member/)
    expect((await readFile(join(member, '.pai/default-group'), 'utf-8')).trim()).toBe('Member')
  })

  it('runs a command typed at the name prompt instead of naming the agent after it', async () => {
    const dir = await tempdir()
    const res = await terminal(dir, 'help\rexit\r')
    expect(res.out).toMatch(/setup is skipped/)
    expect(res.out).toMatch(/Usage: pai <command>/)
    expect(await stat(join(dir, 'pai.json')).catch(() => null)).toBeNull()
  })

  it('a second Ctrl-C leaves while a command ignores its signal', async () => {
    const dir = await tempdir()
    await writeFile(join(dir, 'pai.json'), '{}') // no setup questions
    const keys = new PassThrough()
    let started!: () => void
    const running = new Promise<void>((resolve) => { started = resolve })
    const { interactive } = await import('../src/cli/interactive.js')
    const out = Object.assign(new PassThrough(), { isTTY: true, columns: 80 })
    out.resume()
    const err: string[] = []
    const done = interactive(undefined, {
      cwd: dir,
      env: { HOME: dir },
      stdout: out,
      stderr: { write: (s: string) => err.push(s) },
      stdin: Object.assign(keys, { isTTY: true })
    }, async () => { started(); return await new Promise<number>(() => {}) }) // never settles
    keys.write('hang\r')
    await running
    keys.write('\x03')
    keys.write('\x03')
    expect(await done).toBe(130)
    expect(err.join('')).toMatch(/without waiting/)
  })

  it('splits lines like a shell', () => {
    expect(splitLine(`send  abc "hi there" it\\'s ''`)).toEqual(['send', 'abc', 'hi there', "it's", ''])
    expect(splitLine('send abc "C:\\temp\\new" "say \\"hi\\"" \'a\\b\'')).toEqual(['send', 'abc', 'C:\\temp\\new', 'say "hi"', 'a\\b'])
    expect(splitLine("send abc hi # it's a note")).toEqual(['send', 'abc', 'hi'])
    expect(splitLine('send abc "#1" a#b')).toEqual(['send', 'abc', '#1', 'a#b'])
    expect(() => splitLine('send "oops')).toThrow(/unclosed/)
  })
})

describe('groups', () => {
  it('starts a group, invites agents, they call each other, and a removed one is cut off', async () => {
    const admin = await initAgent('boss')
    // More groups, made here (the daemon isn't running); the first stays
    // the default.
    expect((await pai(admin, ['group', 'create'])).code).toBe(2)
    const side = await pai(admin, ['group', 'create', 'side'])
    expect(side.out, side.err).toMatch(/Started group side.*pai group use side/)
    expect((await pai(admin, ['group', 'list'])).out).toMatch(/^\* boss +[0-9a-f]{16}\n {2}side +[0-9a-f]{16}\n$/)
    expect((await pai(admin, ['group', 'use', 'nope'])).err).toMatch(/No group named nope: yours are boss, side/)
    expect((await pai(admin, ['group', 'use', 'side'])).out).toMatch(/Commands now act on side/)
    expect(JSON.parse((await pai(admin, ['group', 'list', '--json'])).out).default).toBe('side')
    expect(JSON.parse((await pai(admin, ['group', 'list', '--json'], { env: { PAI_GROUP: 'boss' } })).out).default).toBe('boss')
    await pai(admin, ['group', 'use', 'boss'])
    await daemon(admin, ['--echo'])
    expect((await pai(admin, ['group', 'list'])).out).toMatch(/^\* boss +[0-9a-f]{16} {2}1 member, admin/)

    const server = await joined(admin, 'server')
    expect((await daemon(server.dir, ['--echo'])).id).toBe(server.id)
    const client = await joined(admin, 'client')
    await daemon(client.dir, [])
    const sent = await pai(client.dir, ['send', server.id, 'hi'])
    expect(sent.out, sent.err).toBe('hi\n')
    // The joiners know the group by its own name.
    expect(JSON.parse((await pai(client.dir, ['group', 'list', '--json'])).out).default).toBe('boss')

    // Policy: clients may not call anyone, until the rule goes.
    expect((await pai(admin, ['group', 'role', client.id, 'client'])).code).toBe(0)
    const rule = await pai(admin, ['group', 'policy', 'deny', 'no-clients', '--from', 'role:client'])
    expect(rule.out, rule.err).toBe('Rule no-clients: deny role:client -> *\n')
    expect((await pai(admin, ['group', 'policy', 'deny', 'x', '--from', 'role:'])).code).toBe(2)
    expect((await pai(admin, ['group', 'policy', 'deny', 'NoCaps'])).err).toMatch(/not a rule name/)
    await waitFor(async () => (await pai(client.dir, ['send', server.id, 'blocked?'])).err.includes('policy'), 20_000)
    expect((await pai(admin, ['group', 'policy'])).out).toMatch(/no-clients: deny role:client -> \*/)
    await pai(admin, ['group', 'policy', 'remove', 'no-clients'])
    await waitFor(async () => (await pai(client.dir, ['send', server.id, 'back'])).code === 0, 20_000)
    // One admin: a new seed is done at once.
    expect((await pai(admin, ['group', 'rotate'])).out).toBe('Done.\n')
    expect((await pai(admin, ['group', 'show'])).out).toMatch(/Seed: epoch 1/)

    const show = await pai(admin, ['group', 'show'])
    expect(show.out).toMatch(/^Group boss, [0-9a-f]{16}\n/)
    expect(show.out).toMatch(/\(admin\)/)
    expect(show.out).toMatch(new RegExp(`${server.id}\\s+member\\s+server`))
    expect(show.out).toMatch(new RegExp(`${client.id}\\s+client\\s+client`))
    const state = JSON.parse((await pai(admin, ['group', 'show', '--json'])).out)
    expect(state.roster.members).toHaveLength(3)
    // --group picks another of the admin's groups.
    expect(JSON.parse((await pai(admin, ['group', 'show', '--group', 'side', '--json'])).out).roster.members).toHaveLength(1)
    expect((await pai(admin, ['group', 'show', '--group', 'nope'])).err).toMatch(/isn't in a group named nope/)

    expect((await pai(admin, ['group', 'remove', client.id])).code).toBe(0)
    await waitFor(async () => (await pai(client.dir, ['send', server.id, 'still here?'])).code !== 0, 20_000)
  }, 90_000)

  it('makes and joins groups through a running daemon', async () => {
    const admin = await initAgent('boss')
    await daemon(admin, ['--echo'])
    const made = await pai(admin, ['group', 'create', 'side'])
    expect(made.out, made.err).toMatch(/Started group side/)
    await waitFor(async () => JSON.parse(await readFile(join(admin, '.pai/groups.json'), 'utf-8')).groups.length === 2)
    const other = await initAgent('other')
    await daemon(other, ['--echo'])
    const invite = (await pai(admin, ['group', 'invite', '--group', 'side'])).out.trim()
    const joining = await pai(other, ['group', 'join', invite, '--as', 'theirs'])
    expect(joining.out, joining.err).toMatch(/Joined, as theirs/)
    // Once it has synced the group's roster.
    await waitFor(async () => /^ {2}theirs +[0-9a-f]{16} {2}2 members/m.test((await pai(other, ['group', 'list'])).out), 20_000)
    expect((await pai(other, ['group', 'list'])).out).toMatch(/^\* other /m)
    // A send in the shared group reaches the admin.
    const adminId = (await pai(admin, ['id'])).out.trim()
    expect((await pai(other, ['send', adminId, 'hello', '--group', 'theirs'])).out).toBe('hello\n')
  }, 90_000)

  it('explains a folder without an identity, unknown groups, and non-admin actions', async () => {
    const dir = await tempdir()
    await writeFile(join(dir, 'pai.json'), JSON.stringify({ storage: '.pai/agent', card: { name: 'x', description: 'x', version: '1', capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] } }))
    expect((await pai(dir, ['daemon', '--echo', ...bootstrap])).err).toMatch(/no identity yet: run `pai init`/)
    expect((await pai(dir, ['id'])).err).toMatch(/no identity yet/)

    const admin = await initAgent('boss')
    expect((await pai(admin, ['daemon', '--echo', '--worker', '--group', 'nope', ...bootstrap])).err).toMatch(/isn't in a group named nope/)
    expect((await pai(admin, ['device', 'join', 'x'])).err).toMatch(/pai init --device/)
  })

  it('a member can\'t invite, and admin changes wait for a majority', async () => {
    const admin = await initAgent('boss')
    await daemon(admin, [])
    const two = await joined(admin, 'two')
    await daemon(two.dir, [])
    await waitFor(async () => JSON.parse((await pai(two.dir, ['group', 'show', '--json'])).out).writable === true, 20_000)
    expect((await pai(two.dir, ['group', 'invite'])).err).toMatch(/Only a group admin/)

    // One admin: a majority is 1, so it's done at once.
    expect((await pai(admin, ['group', 'admin', 'add', two.id])).out).toBe('Done.\n')
    const three = await joined(admin, 'three')
    await daemon(three.dir, [])
    const proposal = await pai(admin, ['group', 'admin', 'add', three.id])
    const pid = /Proposed: ([0-9a-f]{64})/.exec(proposal.out)?.[1]
    expect(pid, proposal.out + proposal.err).toBeDefined()
    expect(proposal.err).toMatch(/needs 2 of 2 admins/)
    await waitFor(async () => (await pai(two.dir, ['group', 'show'])).out.includes(pid!), 20_000)
    expect((await pai(two.dir, ['group', 'approve', pid!])).out).toBe('Approved, and done.\n')
  }, 90_000)

  it('posts jobs to the board; a worker with the role runs them', async () => {
    const admin = await initAgent('boss')
    await daemon(admin, [])
    const writer = await joined(admin, 'writer', ['--role', 'writer'])
    await daemon(writer.dir, ['--echo', '--worker'])
    expect((await pai(admin, ['daemon', '--worker', ...bootstrap])).err).toMatch(/--harness <name>, --exec/)
    expect((await pai(admin, ['daemon', '--harness', 'vim'])).err).toMatch(/--harness is one of claude, codex, antigravity/)
    expect((await pai(admin, ['daemon', '--model', 'x'])).err).toMatch(/are for --harness/)
    expect((await pai(admin, ['daemon', '--harness', 'claude', '--instructions', '@nope.md'])).err).toMatch(/Can't read --instructions @nope.md/)

    const done = await pai(admin, ['job', 'post', '--to', 'role:writer', '--wait', 'draft', 'this'])
    expect(done.out, done.err).toBe('draft this\n')
    expect(done.code).toBe(0)
    const posted = await pai(admin, ['job', 'post', '--to', 'role:editor', 'nobody edits'])
    const id = posted.out.trim()
    expect(id, posted.err).toMatch(/^[0-9a-f]{32}$/)
    // --watch: the board, then each change, until stopped.
    const stop = new AbortController()
    const watched: string[] = []
    const watching = run(['job', 'list', '--watch'], {
      cwd: admin, env: { HOME: admin }, stdout: { write: (s: string) => watched.push(s) }, stderr: { write: () => {} }, stdin: Object.assign(Readable.from([]), { isTTY: true }) as CliIo['stdin'], signal: stop.signal
    })
    await waitFor(() => watched.join('').includes(id), 10_000)
    const later = (await pai(admin, ['job', 'post', '--to', 'role:editor', 'watch me'])).out.trim()
    await waitFor(() => watched.join('').includes(`${later}  open`), 10_000)
    await pai(admin, ['job', 'cancel', later])
    await waitFor(() => watched.join('').includes(`${later}  canceled`), 10_000)
    stop.abort()
    expect(await watching).toBe(0)
    expect(watched.join('').split(id).length).toBe(2) // unchanged: shown once

    const list = await pai(admin, ['job', 'list'])
    expect(list.out).toMatch(new RegExp(`${id}  open\\s+role:editor  nobody edits`))
    expect(list.out).toMatch(/done\s+role:writer {2}by [0-9a-f]{8}… {2}draft this/)
    expect((await pai(admin, ['job', 'cancel', id])).out).toBe(`${id} canceled\n`)
    const got = await pai(admin, ['job', 'get', id])
    expect(got.out).toBe(`${id}: canceled (for role:editor)\n`)
    expect((await pai(admin, ['job', 'post', '--to', 'editor', 'x'])).code).toBe(2)
    expect((await pai(admin, ['job', 'get', 'nope'])).code).toBe(2)

    // Rules versions: shown, and a version this pai doesn't apply refused.
    expect((await pai(admin, ['group', 'rules'])).out).toBe('The group is on rules v1; this pai applies up to v1.\n')
    expect((await pai(admin, ['group', 'rules', '2'])).err).toMatch(/applies rules up to v1: upgrade it first/)
    expect((await pai(admin, ['group', 'rules', '1'])).err).toMatch(/already on rules v1/)
    // Limits on a job, checked.
    expect((await pai(admin, ['job', 'post', '--max-time', '1', 'x'])).err).toMatch(/--max-time is 5 s/)

    // The web page's link carries the token.
    const link = (await pai(admin, ['ui'])).out.trim()
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ui#token=.+$/)
    expect((await fetch(link.split('#')[0]!)).status).toBe(200)

    // By hand: a job for the admin itself, which runs no worker.
    const me = (await pai(admin, ['id'])).out.trim()
    const mine = (await pai(admin, ['job', 'post', '--to', me, 'sign the release'])).out.trim()
    await waitFor(async () => (await pai(admin, ['inbox'])).out.includes(mine), 10_000)
    expect((await pai(admin, ['inbox'])).out).toMatch(/Jobs you may take/)
    const took = await pai(admin, ['job', 'take', mine])
    expect(took.out, took.err).toBe('sign the release\n')
    expect(took.err).toMatch(/pai job done/)
    expect((await pai(admin, ['inbox'])).out).toMatch(/Jobs you hold\n {2}[0-9a-f]{32} {2}claimed/)
    expect((await pai(admin, ['job', 'done', mine, 'signed', 'it'])).out).toBe(`${mine} done\n`)
    expect((await pai(admin, ['job', 'get', mine])).out).toMatch(/signed it/)
    const notWaiting = await pai(admin, ['job', 'answer', mine, 'hm'])
    expect(notWaiting.err).toMatch(/isn't waiting for an answer/)
    // Attached results come along with a job taken by hand; --context is send's.
    const drafted = (JSON.parse((await pai(admin, ['job', 'list', '--state', 'done', '--json'])).out) as JobRecord[]).find((j) => j.spec.text === 'draft this')!
    expect((await pai(admin, ['job', 'post', '--context', 'x', 'y'])).err).toMatch(/takes --thread/)
    expect((await pai(admin, ['job', 'post', '--attach', 'nope', 'y'])).err).toMatch(/--attach takes job ids/)
    const using = (await pai(admin, ['job', 'post', '--to', me, '--attach', drafted.id, '--thread', 't1', 'use the draft'])).out.trim()
    await waitFor(async () => (await pai(admin, ['inbox'])).out.includes(using), 10_000)
    const withDraft = await pai(admin, ['job', 'take', using])
    expect(withDraft.out, withDraft.err).toBe(`use the draft\n\n--- Attached: the result of job ${drafted.id} ---\ndraft this\n`)
    await pai(admin, ['job', 'release', using])

    // A workflow: two steps for the writer, the second using the first.
    const file = join(admin, 'flow.json')
    await writeFile(file, JSON.stringify({ name: 'two', steps: [{ name: 'a', to: 'role:writer', text: 'A {{input}}' }, { name: 'b', to: 'role:writer', after: ['a'], text: 'B {{steps.a}}' }] }))
    const ran = await pai(admin, ['flow', 'start', 'flow.json', '--wait', 'x'])
    expect(ran.out, ran.err).toBe('B A x\n')
    expect((await pai(admin, ['flow', 'list'])).out).toMatch(/^[0-9a-f]{32} {2}done {6}2\/2 steps {2}two\n$/)
    await writeFile(file, JSON.stringify({ steps: [{ name: 'a', to: null, text: '{{steps.z}}' }] }))
    expect((await pai(admin, ['flow', 'start', 'flow.json', 'x'])).err).toMatch(/doesn't wait/)

    // Writing one: the guide lists the group; check and show read a file.
    const guide = (await pai(admin, ['flow', 'guide'])).out
    expect(guide).toMatch(/# Writing a pai workflow/)
    expect(guide).toMatch(/Roles: .*role:writer/)
    expect(guide).toContain(`${me}  `)
    await writeFile(file, JSON.stringify({ steps: [{ name: 'a', to: 'role:writer', text: 'A {{input}}' }, { name: 'b', to: 'role:nobody', depends_on: ['a'], text: 'B' }] }))
    const bad = await pai(admin, ['flow', 'check', 'flow.json'])
    expect(bad.code).toBe(1)
    expect(bad.out).toMatch(/problem: step b has a field pai doesn't know: "depends_on" \(did you mean after\?\)/)
    expect((await pai(admin, ['flow', 'start', 'flow.json', 'x'])).err).toMatch(/depends_on/)
    await writeFile(file, JSON.stringify({ steps: [{ name: 'a', to: 'role:writer', text: 'A {{input}}' }, { name: 'b', to: 'role:nobody', after: ['a'], text: 'B' }, { name: 'c', to: 'ab'.repeat(32), after: ['b'], text: 'C' }] }))
    await writeFile(join(admin, 'broken.json'), '{ "steps": [], }')
    expect(JSON.parse((await pai(admin, ['flow', 'check', 'broken.json', '--json'])).out)).toMatchObject({ ok: false, problems: [expect.stringMatching(/Can't read the workflow/)] })
    const checked = await pai(admin, ['flow', 'check', 'flow.json', '--json'])
    expect(JSON.parse(checked.out)).toMatchObject({ ok: false, group: true, problems: [expect.stringMatching(/step c is for abab.*isn't a member/)], warnings: [expect.stringMatching(/role:nobody/)] })
    expect((await pai(admin, ['flow', 'show', join(process.cwd(), 'examples/model-team/loop.json')])).out).toMatch(/ 2 └ review +role:critic +· after draft · repeat from draft until review is "approved", at most 3 rounds/)
  }, 90_000)

  it('runs one agent on two devices: either answers, and a device can be removed', async () => {
    const admin = await initAgent('boss')
    await daemon(admin, [])
    const first = await joined(admin, 'worker')
    const firstDaemon = await daemon(first.dir, ['--echo'])
    const invite = await pai(first.dir, ['device', 'invite'])
    expect(invite.code, invite.err).toBe(0)
    expect(invite.err).toMatch(/pai init --device <code>/)

    const second = await tempdir()
    const join = await pai(second, ['init', '--name=worker-2', `--device=${invite.out.trim()}`, ...bootstrap])
    expect(join.code, join.err).toBe(0)
    expect((await pai(second, ['id'])).out).toBe((await pai(first.dir, ['id'])).out) // one identity
    await daemon(second, ['--echo'])
    // It gets the identity's group from the first device.
    await waitFor(async () => JSON.parse((await pai(second, ['group', 'list', '--json'])).out).default === 'boss', 30_000)
    const devices = JSON.parse((await pai(first.dir, ['device', 'list', '--json'])).out)
    expect(devices.devices).toHaveLength(2)

    // A call to the identity reaches whichever device is up.
    expect((await pai(admin, ['send', first.id, 'one'])).out).toBe('one\n')
    await firstDaemon.stop()
    await waitFor(async () => (await pai(admin, ['send', first.id, 'two'])).out === 'two\n', 30_000)

    // Removed from the second device's side (once it has synced the list):
    // the first is gone for good.
    await waitFor(async () => JSON.parse((await pai(second, ['device', 'list', '--json'])).out).devices.length === 2, 20_000)
    const removed = await pai(second, ['device', 'remove', firstDaemon.device])
    expect(removed.code, removed.err).toBe(0)
    expect(JSON.parse((await pai(second, ['device', 'list', '--json'])).out).devices).toHaveLength(1)
  }, 120_000)

  it('checks group arguments', async () => {
    const dir = await initAgent('x')
    expect((await pai(dir, ['group', 'remove', 'abc'])).err).toMatch(/is not an agent id/)
    expect((await pai(dir, ['group', 'invite', '--days=0'])).code).toBe(2)
    expect((await pai(dir, ['group', 'quorum', 'lots'])).code).toBe(2)
    expect((await pai(dir, ['group', 'join'])).err).toMatch(/needs an invite code/)
    expect((await pai(dir, ['group', 'use'])).err).toMatch(/needs the name/)
    expect((await pai(dir, ['group'])).code).toBe(2)
  })
})

describe('durable sends and mailboxes', () => {
  async function outboxSays (dir: string, pattern: RegExp): Promise<string> {
    let last = ''
    for (let i = 0; i < 300; i++) {
      last = (await pai(dir, ['outbox'])).out
      if (pattern.test(last)) return last
      await sleep(50)
    }
    throw new Error(`outbox never matched ${pattern}:\n${last}`)
  }

  it('queues a send for an offline agent at a mailbox, and shows the reply when it comes back', async () => {
    // Mail goes to a device: the mailbox, bob and alice are in one group.
    const box = await initAgent('mailbox')
    const { device: boxId, log } = await daemon(box, ['--mailbox'])
    expect(log()).toMatch(/is a mailbox/)

    const { dir: bob } = await joined(box, 'bob')
    const bobId = /device: ([0-9a-f]{64})/.exec((await pai(bob, ['id'])).err)![1]!
    expect((await pai(bob, ['mailbox', 'add', boxId])).out).toMatch(/Added mailbox/)

    const { dir: alice } = await joined(box, 'alice')
    expect((await pai(alice, ['mailbox', 'add', boxId])).code).toBe(0)
    expect((await pai(alice, ['mailbox', 'add', boxId])).out).toMatch(/already listed/)
    await daemon(alice, [])
    expect((await pai(alice, ['outbox'])).out).toMatch(/No durable sends yet/)

    const queued = await pai(alice, ['send', bobId, 'are you there', '--durable'])
    expect(queued.out, queued.err).toMatch(/^queued [0-9a-f-]{36}:/)
    await outboxSays(alice, new RegExp(`message to ${bobId.slice(0, 8)}…  deposited at mailbox ${boxId.slice(0, 8)}`))

    await daemon(bob, ['--echo'])
    expect(await outboxSays(alice, /task completed: are you there/)).toMatch(/deposited/)
  })

  it('checks durable flags', async () => {
    const dir = await initAgent('flags')
    await daemon(dir, [])
    expect((await pai(dir, ['send', 'a'.repeat(64), 'x', '--durable', '--stream'])).code).toBe(2)
    expect((await pai(dir, ['send', 'nope', 'x', '--durable'])).err).toMatch(/is not an agent id/)
    expect((await pai(dir, ['mailbox', 'remove', 'x'])).code).toBe(2)
  })
})

describe('daemon and call', () => {
  it('echoes with send, streams, prints JSON, reads the card, and gets the task', async () => {
    const server = await initAgent('echo')
    const { id, device } = await daemon(server, ['--echo'])
    const client = await caller(server)

    const sent = await pai(client, ['send', id, 'hello', 'there'])
    expect(sent.err).toBe('')
    expect(sent.out).toBe('hello there\n')
    expect(sent.code).toBe(0)

    const piped = await pai(client, ['send', id, '--stream'], { stdin: 'from stdin\n' })
    expect(piped.out).toBe('from stdin\n')
    expect(piped.err).toBe('') // no "working" noise while streaming

    // --json prints the A2A v1.0 objects as they came over the wire.
    const json = await pai(client, ['send', id, 'as json', '--json'])
    const { task } = JSON.parse(json.out)
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.history[0]).toMatchObject({ role: 'ROLE_USER', parts: [{ text: 'as json' }] })

    const got = await pai(client, ['task', 'get', id, task.id, '--json'])
    expect(JSON.parse(got.out).id).toBe(task.id)

    const lines = (await pai(client, ['send', id, 'streamed', '--stream', '--json'])).out.trim().split('\n').map((l) => JSON.parse(l))
    expect(Object.keys(lines[0])).toEqual(['task'])
    expect(lines.some((l) => 'artifactUpdate' in l)).toBe(true)
    expect(lines.at(-1).statusUpdate.status.state).toBe('TASK_STATE_COMPLETED')

    const listed = await pai(client, ['task', 'list', id])
    expect(listed.code, listed.err).toBe(0)
    expect(listed.out).toContain(`${task.id}  completed`)
    expect(listed.err).toMatch(/^4 of 4 tasks$/m) // hello there, from stdin, as json, streamed

    const card = await pai(client, ['card', id])
    expect(JSON.parse(card.out)).toMatchObject({ name: 'echo', supportedInterfaces: [{ url: `pai://${device}`, protocolVersion: '1.0' }] })
  })

  it('runs an --exec command per message and streams its output', async () => {
    const server = await initAgent('upper')
    const { id, log } = await daemon(server, ['--exec', 'tr a-z A-Z; echo "task=$PAI_TASK_ID"'])
    const client = await caller(server)

    const res = await pai(client, ['send', id, 'shout this', '--stream'])
    expect(res.code, res.err).toBe(0)
    expect(res.out).toMatch(/^SHOUT THIS\s*task=[0-9a-f]{16}\.[0-9a-f-]{36}\n$/)
    expect(log()).toMatch(/task [0-9a-f]{16}\.[0-9a-f-]{36} completed/)
  })

  it('reports a failing --exec command and exits 1', async () => {
    const server = await initAgent('fails')
    const { id } = await daemon(server, ['--exec', 'echo "out of cheese" >&2; exit 3'])
    const client = await caller(server)

    const res = await pai(client, ['send', id, 'anything'])
    expect(res.code).toBe(1)
    expect(res.err).toBe('failed: out of cheese\n')
  })

  it('Ctrl-C during send --stream cancels the task, which kills the --exec command', async () => {
    const server = await initAgent('slow')
    const { id, log } = await daemon(server, ['--exec', 'echo started; sleep 30; echo never'])
    const client = await caller(server)

    const interrupt = new AbortController()
    const streaming = pai(client, ['send', id, 'go', '--stream'], { signal: interrupt.signal })
    for (let i = 0; i < 100 && !log().includes('received'); i++) await sleep(50)
    await sleep(300) // let "started" stream back
    const started = Date.now()
    interrupt.abort()

    const res = await streaming
    expect(res.out).toContain('started')
    expect(res.out).not.toContain('never')
    expect(res.err).toMatch(/Canceling task [0-9a-f]{16}\.[0-9a-f-]{36}\ncanceled\n/)
    expect(res.code).toBe(1)
    expect(Date.now() - started).toBeLessThan(5000)
    for (let i = 0; i < 40 && !/task \S+ canceled/.test(log()); i++) await sleep(50)
    expect(log()).toMatch(/task \S+ canceled/)

    // The task belongs to the caller's agent: later calls through its daemon can read it.
    const taskId = /Canceling task (\S+)/.exec(res.err)![1]!
    const got = await pai(client, ['task', 'get', id, taskId])
    expect(got.err).toBe('canceled\n')
  })

  it('an agent outside the group can\'t reach it', async () => {
    const server = await initAgent('private')
    const { id } = await daemon(server, ['--echo'])
    const stranger = await initAgent('stranger')
    await daemon(stranger, ['--echo', '--timeout=1500'])
    const res = await pai(stranger, ['send', id, 'hi'])
    expect(res.code).toBe(1)
    expect(res.err).toMatch(/Agent unreachable: (Timed out (connecting|reaching)|Peer refused this agent)/)
  })

  it('needs a running daemon to call through, and says how to start one', async () => {
    const server = await initAgent('target')
    const { id } = await daemon(server, ['--echo'])
    const { dir } = await joined(server, 'lonely')
    const res = await pai(dir, ['send', id, 'hi'])
    expect(res.code).toBe(1)
    expect(res.err).toMatch(/No pai daemon is running here. Start one with `pai daemon`/)

    // A daemon that died without cleaning up counts as not running.
    await writeFile(join(dir, '.pai/daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:1', pid: 2 ** 22 + 1 }))
    expect((await pai(dir, ['card', id])).err).toMatch(/No pai daemon is running here/)
    // Network options belong to the daemon.
    expect((await pai(dir, ['send', id, 'hi', ...bootstrap])).err).toMatch(/`pai daemon` options/)

    // A calls-only daemon (no --echo/--exec/--proxy) is enough to call, and
    // refuses messages itself.
    const { id: lonelyId, log } = await daemon(dir, [])
    expect(log()).toMatch(/calls only/)
    expect((await pai(dir, ['send', id, 'hi'])).out).toBe('hi\n')
    const other = await caller(server)
    expect((await pai(other, ['send', lonelyId, 'hi'])).err).toMatch(/no message handler/)
  })

  it('removes its address file when it stops', async () => {
    const dir = await initAgent('stopping')
    const stop = new AbortController()
    const out: string[] = []
    const done = run(['daemon', '--echo', '--listen=127.0.0.1:0', ...bootstrap], {
      cwd: dir, env: { HOME: dir }, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => out.push(s) },
      stdin: Object.assign(Readable.from([]), { isTTY: true }), signal: stop.signal
    })
    for (let i = 0; i < 200 && !out.join('').includes('gateway:'); i++) await sleep(50)
    expect(JSON.parse(await readFile(join(dir, '.pai/daemon.json'), 'utf-8')).pid).toBe(process.pid)
    stop.abort()
    expect(await done).toBe(0)
    await expect(stat(join(dir, '.pai/daemon.json'))).rejects.toThrow()
  })

  it('prints the card with card --watch until interrupted', async () => {
    const server = await initAgent('watched')
    const { id } = await daemon(server, ['--echo'])
    const client = await caller(server)

    const interrupt = new AbortController()
    const out: string[] = []
    const watching = run(['card', id, '--watch'], {
      cwd: client, env: { HOME: client }, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => out.push(s) },
      stdin: Object.assign(Readable.from([]), { isTTY: true }), signal: interrupt.signal
    })
    for (let i = 0; i < 200 && !out.join('').includes('\n'); i++) await sleep(50)
    expect(JSON.parse(out.join('').split('\n')[0]!)).toMatchObject({ name: 'watched' })
    interrupt.abort()
    expect(await watching).toBe(0)
  })

  it('runs a gateway that local A2A clients reach with the token from .pai/daemon-token', async () => {
    const remote = await initAgent('remote')
    const { id: remoteId } = await daemon(remote, ['--echo'])
    const { dir: local } = await joined(remote, 'local')
    const { gateway } = await daemon(local, ['--echo'])

    const tokenFile = join(local, '.pai/daemon-token')
    expect((await stat(tokenFile)).mode & 0o077).toBe(0)
    const token = (await readFile(tokenFile, 'utf-8')).trim()

    const card = await fetch(`${gateway}/agents/${remoteId}/.well-known/agent-card.json`, { headers: { Authorization: `Bearer ${token}` } })
    expect((await card.json() as { name: string }).name).toBe('remote')
    const res = await fetch(`${gateway}/agents/${remoteId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'A2A-Version': '1.0', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: 'm1', parts: [{ text: 'via the gateway' }] } } })
    })
    const body = await res.json() as { result: { task: { artifacts: Array<{ parts: Array<{ text: string }> }> } } }
    expect(body.result.task.artifacts[0]?.parts[0]?.text).toBe('via the gateway')
    expect((await fetch(`${gateway}/`)).status).toBe(401)
  })

  it('checks its flags, and explains an unreachable --proxy upstream and the old serve command', async () => {
    const dir = await initAgent('flags')
    expect((await pai(dir, ['daemon', '--echo', '--exec', 'cat'])).err).toMatch(/at most one of --harness <name>, --exec <command>, --proxy <url> or --echo/)
    expect((await pai(dir, ['daemon', '--echo', '--listen=0.0.0.0:7777'])).err).toMatch(/loopback/)
    const proxy = await pai(dir, ['daemon', '--proxy', 'http://127.0.0.1:1/', ...bootstrap])
    expect(proxy.code).toBe(1)
    expect(proxy.err).toMatch(/Couldn't reach the upstream agent/)
    expect((await pai(dir, ['serve', '--echo'])).err).toMatch(/now `pai daemon`/)
  })

})

function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
