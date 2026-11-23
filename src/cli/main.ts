import type { Readable } from 'node:stream'
import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { BootstrapNode } from 'hyperdht'
import type { SendMessageResponse, StreamResponse, Task, TaskState } from '../a2a/types.js'
import { isTaskState } from '../task/task.js'
import { PaiCardError, PaiRpcError } from '../errors.js'
import { Pai } from '../pai.js'
import { DaemonClient } from '../daemon/client.js'
import type { RemoteAgent } from '../daemon/client.js'
import { startGateway } from '../daemon/gateway.js'
import { proxyHandler, upstreamCard } from '../daemon/proxy.js'
import type { RawRequestHandler } from '../pai.js'
import type { MessageHandler } from '../server.js'
import { loadKeyPair } from '../store/key-file.js'
import type { Env, LoadedConfig } from './config.js'
import { CliError, addMailbox, chosenGroup, daemonConnection, ensureToken, groupsFile, hasIdentity, identityFor, initConfig, loadConfig, readDaemonAddress, readGroups, removeDaemonAddress, writeDaemonAddress, writeDefault, writeGroups } from './config.js'
import type { GroupsState } from './config.js'
import type { GroupIdentity } from '../identity/group.js'
import { MAX_GROUPS, createGroup, createIdentity, groupName, joinDevice, joinGroup } from '../identity/group.js'
import { groupId } from '../group/base.js'
import { MAX_ROLES, admitted, isRoles, isRuleName, isSelector, mayPost } from '../group/state.js'
import type { PolicyRule } from '../group/state.js'
import { JOB_STATES, MIN_LEASE, isEnded, isJobId, isJobTarget, questionKey, limitsOf, limitsProblem, specProblem } from '../group/jobs.js'
import type { JobRecord, JobState } from '../group/jobs.js'
import { flowProblem, scheduleProblem } from '../group/flows.js'
import { FLOW_FORMAT, checkFlow, flowLayout, groupGuide, unknownFields } from '../group/flow-guide.js'
import type { GuideMember } from '../group/flow-guide.js'
import type { FlowCondition, FlowSpec, FlowView } from '../group/flows.js'
import { JobWorker } from '../jobs/worker.js'
import type { GroupState } from '../daemon/client.js'
import { lockStorage } from '../util/lock.js'
import { describe, echoHandler, execHandler, stateName, userText } from './handlers.js'
import { HARNESSES, harnessHandler, harnessName, sessionsFile } from '../harness.js'
import { interactive } from './interactive.js'

export interface CliIo extends Env {
  stdout: { write (s: string): unknown, isTTY?: boolean, columns?: number }
  stderr: { write (s: string): unknown }
  stdin: Readable & { isTTY?: boolean }
  // Stops `pai daemon` and the --watch commands. The bin wires it to SIGINT and SIGTERM.
  signal?: AbortSignal
  // Set on commands run inside `pai shell`, which can't start another.
  shell?: boolean
}

const USAGE = `pai: peer-to-peer agent orchestration across machines and owners

Usage: pai <command> [options]
       pai shell              type commands at a prompt (\`pai\` alone does
                              this on a terminal), or run a script piped in
       pai help               this text

Setup
  init --name <name> [--description <text>] [--force]
                              make this agent: pai.json, its identity, and a
                              group named <name> with it as the admin, which
                              becomes the default group
  init --name <name> --join <code> [--as <group name>]
                              the same, but join another's group with an
                              admin's invite instead (an admin must be online)
  init --device <code> [--name <device name>]
                              make this folder another device of an existing
                              identity (a code from \`pai device invite\`): it
                              gets every group that identity is in
  id                          this agent's identity (and, on stderr, this
                              device and the default group)

Groups: rosters every member syncs; admins admit and remove agents.
Group commands act on the default group; --group <name> picks another.
  group list [--json]         the groups this identity is in; * marks the
                              default
  group use <name>            make it the default group
  group create <name>         start another group, with this agent as its admin
  group join <code> [--as <name>]
                              join another group with an admin's invite;
                              --as: your name for it (default: the group's own)
  group show [--json]         its members, admins and open proposals
  group invite [--days <n>] [--hours <h>] [--role <r>[,<r>...]]
                              a one-use code, good for --hours (default 24);
                              membership lasts --days (default: no end);
                              the member gets --role (default member)
  group remove <agent id>     members drop its connections as they sync
  group renew <agent id> [--days <n>]
  group role <agent id> <role>[,<role>...]
                              set a member's roles (policy and jobs use them)
  group policy [list]         who may call whom
  group policy allow|deny <name> [--from <who>] [--to <who>]
                              add or change a rule; <who> is *, role:<role> or
                              an agent id (default *). The most specific rule
                              wins, a deny on a tie; no rule: allowed
  group policy remove <name>
  group rotate                propose a new seed (after removing members, so
                              they can't follow the group); needs a majority
  group rules [<version>]     the group's rules version and the newest this
                              pai applies; with a version, propose moving on
                              (once every member's pai applies it)
  group admin add|remove <agent id>
                              propose it; it needs a majority of admins
  group quorum <k>|majority   propose how many admins an admin change needs
  group approve|withdraw <proposal id>

Devices: one identity on several machines, in all of its groups; any of
them answers calls
  device invite [--hours <h>] a one-use code that adds a device to this
                              identity (this daemon has to be running); the
                              device gets every group, and later ones too
  device list                 this identity's devices
  device remove <device id>   take a device out (from another of its devices)

Job board: work for whichever member may claim it, in the default group or
--group <name> (needs the daemon)
  job post [text] [--to <who>] [--lease <s>] [--wait] [--json]
                              post text (or stdin) as a job for --to (role:<r>
                              or an agent id; default anyone); prints its id,
                              or with --wait the result once it's done.
                              --lease: a claim lapses after that many seconds
                              (at least 5) unless its worker renews it
         [--max-time <s>] [--deadline <s>] [--retries <n>] [--backoff <s>]
                              --max-time: an attempt may run this long;
                              --deadline: fail if not done this long after
                              posting; --retries: try a failed, timed-out or
                              abandoned attempt again this many times, waiting
                              --backoff seconds first (doubling each time); a
                              new attempt is told why the last was lost
         [--attach <job id>] [--thread <name>]
                              --attach: send along the whole result of a done
                              job (repeatable, up to 8), read from its task
                              instead of the board's 16 KiB copy; --thread:
                              run the jobs you give this name in one A2A
                              context on each worker
  job list [--state <s>] [--watch] [--json]
                              the board, newest first (open, claimed, done,
                              failed, canceled); --watch: then each job as it
                              changes, until Ctrl-C
  job get <id> [--wait] [--json]
  job cancel <id>             the poster or an admin
  job answer <id> [text]      answer the question a job's run asked (its
                              poster, or an admin); --wait shows questions
  job take <id>               do a job by hand: claim it, print its text
  job done|fail <id> [text]   report a job taken by hand, with text (or
                              stdin) as its result
  job release <id>            give a job you hold back to the board
  inbox [--json]              what's waiting on you in every group (--group:
                              one): questions on your jobs, jobs you may
                              take, jobs you hold, proposals
  ui                          print a link to the daemon's web page: the
                              inbox, the board, workflows and the groups

Workflows: steps run as jobs, each when the ones it needs are done; in the
default group or --group <name>
  flow guide                  how to write one, and this group's roles and
                              members (for people and coding agents alike)
  flow check <file.json> [--json]
                              everything wrong with it, without starting
                              it: its format, unknown fields, and (with the
                              daemon running) whether its steps are for
                              members and roles the policy lets you post for
  flow show <file.json>       its layout: when each step can start, who it's
                              for, its branches, loops and sub-workflows
  flow start <file.json> [input] [--key <k>] [--wait] [--json]
                              start the workflow in the file with input (text,
                              or stdin); prints its id, or with --wait the
                              result of its final steps. With --key, starting
                              again with the same key gives the run it started,
                              not a second one. See examples/model-team
  flow list [--json]
  flow get <id> [--wait] [--json]
                              where each step is, or the output
  flow cancel <id>            the starter or an admin
  flow schedule <name> <file.json> [input] --every <s> [--start <time>]
                              have the group start the workflow every that
                              many seconds (at least 60), from --start (an
                              ISO time; default a period from now), as
                              yours; it skips a run while the last is still
                              going, and runs by the group's clock, so an
                              admin's device has to be running. Setting a
                              name again replaces it
  flow schedules [--json]     the group's schedules
  flow unschedule <name>      yours, or any as an admin

Run the daemon: this agent in every group it's in, plus a local A2A
gateway to other agents
  daemon                      calls only: the gateway, for send/card/task and
                              local A2A clients; incoming messages are refused
  daemon --harness <name>     answer with a coding agent, run headless per
                              message: claude (Claude Code), codex or
                              antigravity (agy). Its answer streams back; a
                              context (a job thread, a workflow) keeps one
                              session; canceling stops it. Uses the
                              harness's own login.
         [--model <m>]        the harness's model (default its own)
         [--instructions <t>] said at the start of each session (a role);
                              @<file> reads them from a file
         [--write]            let it edit files here (default: read only)
  daemon --echo               reply with the request's own text
  daemon --exec <command>     run <command> per message: the text on stdin, stdout
         [--exec-json]        streamed back; exit 0 completes, anything else fails.
                              --exec-json sends the A2A message as JSON instead.
  daemon --proxy <url>        front an existing A2A agent (JSON-RPC over HTTP):
                              forward requests to it, and publish its card
         [--mailbox]          also be a mailbox: hold sealed mail for other
                              agents until they collect it
         [--worker]           also take jobs this agent may claim off every
                              group's board (with --group, one group's), one
                              at a time per group, and run them as messages
                              (with --harness, --exec, --proxy or --echo)
         [--answer-within <s>]
                              a run that asks a question gives up after this
                              many seconds without an answer (default a day)
         [--listen <host:port>]
                              the gateway's address, default 127.0.0.1:7777.
                              Local A2A clients call other agents at
                              http://<host:port>/agents/<id>, with the token in
                              .pai/daemon-token as a bearer token.

Call an agent (by id), through the daemon running in this folder, as its agent
  card <agent> [--watch]      print its Agent Card (JSON), or follow changes
  send <agent> [text]         send text (or stdin) and print the reply; its
                              task is shared in the default group, or
                              --group <name> (if you're both in it;
                              otherwise a group you share)
        [--stream] [--json] [--task <id>] [--context <id>]
        [--durable]           queue it instead: delivered when the agent is
                              reachable, or left at a mailbox; see outbox
  outbox [--json]             durable sends and their state, oldest first
  task get <agent> <taskId>
  task cancel <agent> <taskId>
  task subscribe <agent> <taskId>
  task list <agent> [--context <id>] [--state <s>] [--limit <n>] [--page <token>]
                              your tasks on that agent, newest first

Mailboxes: where mail waits while an agent is offline
  mailbox add <agent id>      use that mailbox for durable sends and to
                              collect mail (saved in pai.json; restart the daemon)

Options
  --group <name>              the group a command acts on (default: the
                              default group, or $PAI_GROUP)
  --config <file>             default ./pai.json
  --bootstrap <host:port>     daemon, init and group join: DHT bootstrap node
                              (repeatable; replaces the defaults)
  --timeout <ms>              daemon: connect timeout, default 30000; init and
                              group join: how long to wait for an answer
  -h, --help

Environment
  PAI_GROUP                   the group commands act on, in place of the default
`

const OPTIONS = {
  config: { type: 'string' },
  bootstrap: { type: 'string', multiple: true },
  timeout: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  // init
  name: { type: 'string' },
  description: { type: 'string' },
  force: { type: 'boolean' },
  join: { type: 'string' },
  device: { type: 'string' },
  // the group a command acts on; group join --as
  group: { type: 'string' },
  as: { type: 'string' },
  // group invite|renew
  days: { type: 'string' },
  hours: { type: 'string' },
  role: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  // daemon
  harness: { type: 'string' },
  model: { type: 'string' },
  instructions: { type: 'string' },
  write: { type: 'boolean' },
  echo: { type: 'boolean' },
  mailbox: { type: 'boolean' },
  durable: { type: 'boolean' },
  exec: { type: 'string' },
  'exec-json': { type: 'boolean' },
  proxy: { type: 'string' },
  listen: { type: 'string' },
  worker: { type: 'boolean' },
  'answer-within': { type: 'string' },
  // job post|get
  wait: { type: 'boolean' },
  lease: { type: 'string' },
  'max-time': { type: 'string' },
  // flow start
  key: { type: 'string' },
  // flow schedule
  every: { type: 'string' },
  start: { type: 'string' },
  deadline: { type: 'string' },
  retries: { type: 'string' },
  backoff: { type: 'string' },
  attach: { type: 'string', multiple: true },
  thread: { type: 'string' },
  // card, send
  watch: { type: 'boolean' },
  stream: { type: 'boolean' },
  json: { type: 'boolean' },
  task: { type: 'string' },
  context: { type: 'string' },
  // task list
  state: { type: 'string' },
  limit: { type: 'string' },
  page: { type: 'string' }
} as const

type Flags = ReturnType<typeof parse>['values']

function parse (argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
}

// Runs one CLI command and returns the exit code.
export async function run (argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (err) {
    io.stderr.write(`${(err as Error).message}\n\n${USAGE}`)
    return 2
  }
  const { values: flags, positionals } = parsed
  const [command, ...args] = positionals
  if (flags.help) {
    io.stdout.write(USAGE)
    return 0
  }

  try {
    if (!command) {
      // A prompt only for a person at a terminal; a script or CI job that
      // runs a bare `pai` gets the usage, as before, instead of a wait.
      if (!io.shell && io.stdin.isTTY && io.stdout.isTTY) return await shell(flags, io)
      io.stderr.write(io.shell ? 'pai: type a command (`help` lists them)\n' : USAGE)
      return 2
    }
    switch (command) {
      case 'help': io.stdout.write(USAGE); return 0
      case 'shell':
        if (args.length) throw new CliError(`pai shell reads commands from stdin, not from ${args[0]}: try pai shell < ${args[0]}`, 2)
        return await shell(flags, io)
      case 'init': return await init(flags, io)
      case 'id': return await id(flags, io)
      case 'daemon': return await daemon(flags, io)
      case 'serve': throw new CliError('`pai serve` is now `pai daemon` (same flags)', 2)
      case 'card': return await card(args, flags, io)
      case 'send': return await send(args, flags, io)
      case 'task': return await task(args, flags, io)
      case 'group': return await group(args, flags, io)
      case 'device': return await device(args, flags, io)
      case 'job': return await job(args, flags, io)
      case 'inbox': return await inbox(flags, io)
      case 'ui': return await ui(flags, io)
      case 'flow': return await flow(args, flags, io)
      case 'outbox': return await outbox(flags, io)
      case 'mailbox': return await mailbox(args, flags, io)
      default:
        io.stderr.write(`Unknown command: ${command}\n\n${USAGE}`)
        return 2
    }
  } catch (err) {
    io.stderr.write(`pai: ${errorMessage(err)}\n`)
    return err instanceof CliError ? err.exitCode : 1
  }
}

// Only --config carries over to the commands typed in the shell.
async function shell (flags: Flags, io: CliIo): Promise<number> {
  const other = Object.keys(flags).filter((f) => f !== 'config')
  if (other.length) throw new CliError(`pai shell takes only --config, not --${other[0]}`, 2)
  return await interactive(flags.config, io, run)
}

// Makes this folder an agent: pai.json, then its identity and a first
// group (its own, or one it joins), or a new device of an existing
// identity. Runs without the daemon.
async function init (flags: Flags, io: CliIo): Promise<number> {
  if (flags.device !== undefined && flags.join !== undefined) throw new CliError('--device and --join are different setups; pass one', 2)
  if (flags.device === undefined && !flags.name) throw new CliError('init needs --name', 2)
  const name = flags.name ?? 'device'
  const { path, config } = await initConfig({
    name,
    ...(flags.description ? { description: flags.description } : {}),
    ...(flags.force ? { force: true } : {})
  }, io)
  io.stdout.write(`Wrote ${path}\n`)
  if (await hasIdentity(config)) {
    // --force rewrites pai.json; the identity and its groups stay.
    if (flags.force && flags.join === undefined && flags.device === undefined) {
      io.stdout.write(`Kept this folder's identity and groups (${groupsFile(config)}).\n`)
      return 0
    }
    throw new CliError(`${groupsFile(config)} already holds an identity: this folder is set up (delete .pai/ to start over)`)
  }
  const keyPair = await loadKeyPair(config.storage)
  const unlock = await lockOrExplain(config)
  try {
    if (flags.device !== undefined) {
      io.stdout.write('Looking for a device of that identity (one has to be running)…\n')
      const keys = await joinDevice({ ...joinOptions(config, flags, io, keyPair, flags.device), ...(flags.name ? { name: flags.name } : {}) }).catch(async (err: Error) => {
        // Nothing made here then: the same command can be run again.
        await rm(path, { force: true })
        throw new CliError(err.message)
      })
      await writeGroups(config, { keys, groups: [], default: null })
      io.stdout.write(`Joined identity ${hex(keys.identity)} as a new device. Wrote ${groupsFile(config)}: keep it private.\n`)
      io.stdout.write('Next: run `pai daemon`; it gets the identity\'s groups from its other devices.\n')
      return 0
    }
    const keys = await createIdentity({ storage: config.storage, keyPair, name })
    const state: GroupsState = { keys, groups: [], default: null }
    await writeGroups(config, state)
    io.stdout.write(`identity: ${hex(keys.identity)}  (this device is ${hex(keyPair.publicKey).slice(0, 8)}…)\n`)
    if (flags.join !== undefined) {
      io.stdout.write('Looking for an admin of the group (one has to be online)…\n')
      const entry = await joinGroup({ ...joinOptions(config, flags, io, keyPair, flags.join), keys, name, ...(flags.as ? { as: flags.as } : {}) }).catch((err: Error) => {
        throw new CliError(`${err.message}. The identity is made: try again with \`pai group join <code>\``)
      })
      await writeGroups(config, { ...state, groups: [entry], default: entry.name })
      io.stdout.write(`Joined the group, as ${entry.name}. Wrote ${groupsFile(config)}: keep it private.\n`)
      io.stdout.write('Next: run `pai daemon`; it syncs the group and connects to the other members.\n')
    } else {
      const entry = await createGroup({ storage: config.storage, keys, keyPair, name, member: name })
      await writeGroups(config, { ...state, groups: [entry], default: entry.name })
      io.stdout.write(`Started group ${entry.name}, with this agent as its admin. Wrote ${groupsFile(config)}: keep it private.\n`)
      io.stdout.write('Next: run `pai daemon`, then `pai group invite` for each agent that should join.\n')
    }
  } finally {
    await unlock()
  }
  io.stdout.write('Keep .pai/ out of version control.\n')
  return 0
}

// What a join (of a group, or of a device to an identity) needs here.
function joinOptions (config: LoadedConfig, flags: Flags, io: CliIo, keyPair: { publicKey: Uint8Array, secretKey: Uint8Array }, code: string) {
  return {
    storage: config.storage,
    keyPair,
    code,
    ...(flags.bootstrap ? { bootstrap: flags.bootstrap.map(node) } : {}),
    ...(flags.timeout ? { timeout: Number(flags.timeout) } : {}),
    ...(io.signal ? { signal: io.signal } : {})
  }
}

// Asks the running daemon, or reads the id from storage without going online.
async function id (flags: Flags, io: CliIo): Promise<number> {
  const config = await loadConfig(flags.config, io)
  const state = await readGroups(config)
  const keyPair = await loadKeyPair(config.storage)
  const current = chosenGroup(flags.group, io) ?? state.default
  if (flags.json) {
    io.stdout.write(JSON.stringify({ identity: hex(state.keys.identity), device: hex(keyPair.publicKey), default: current }, null, 2) + '\n')
    return 0
  }
  io.stdout.write(`${hex(state.keys.identity)}\n`)
  io.stderr.write(`device: ${hex(keyPair.publicKey)}\n`)
  io.stderr.write(current ? `group: ${current}\n` : 'group: none yet (pai group create <name>, or pai group join <code>)\n')
  return 0
}

async function daemon (flags: Flags, io: CliIo): Promise<number> {
  const modes = [flags.echo, flags.exec, flags.proxy, flags.harness].filter(Boolean).length
  if (modes > 1) throw new CliError('daemon takes at most one of --harness <name>, --exec <command>, --proxy <url> or --echo', 2)
  const harness = flags.harness === undefined ? null : harnessName(flags.harness)
  if (flags.harness !== undefined && harness === null) throw new CliError(`--harness is one of ${HARNESSES.join(', ')}, not ${flags.harness}`, 2)
  if (harness === null && (flags.model !== undefined || flags.instructions !== undefined || flags.write)) throw new CliError('--model, --instructions and --write are for --harness', 2)
  const { host, port } = listenAddress(flags.listen)
  const config = await loadConfig(flags.config, io)

  let handler: MessageHandler | undefined
  let onRequest: RawRequestHandler | undefined
  let card = config.card
  // --instructions @<file>: read from that file.
  let instructions = flags.instructions
  if (instructions?.startsWith('@')) {
    try {
      instructions = (await readFile(resolve(io.cwd, instructions.slice(1)), 'utf-8')).trim()
    } catch (err) {
      throw new CliError(`Can't read --instructions ${instructions}: ${(err as Error).message}`, 2)
    }
  }
  const exec = flags.exec
    ? execHandler(flags.exec, { json: flags['exec-json'] ?? false, env: io.env, cwd: io.cwd })
    : harness
      ? harnessHandler(harness, {
        cwd: io.cwd,
        env: io.env,
        sessions: sessionsFile(config.storage),
        write: flags.write === true,
        ...(flags.model !== undefined ? { model: flags.model } : {}),
        ...(instructions !== undefined ? { instructions } : {})
      })
      : null
  if (flags.proxy) {
    // The upstream describes itself; pai.json's card isn't used.
    try {
      card = await upstreamCard(flags.proxy)
    } catch (err) {
      throw new CliError((err as Error).message)
    }
    const forward = proxyHandler(flags.proxy)
    onRequest = (req, ctx) => {
      io.stdout.write(`${new Date().toISOString()} ${req.method} from ${ctx.peer.slice(0, 12)}\n`)
      return forward(req, ctx)
    }
  } else if (flags.echo || exec) {
    const inner = exec ?? echoHandler
    handler = async (message, task) => {
      io.stdout.write(`${new Date().toISOString()} task ${task.task.id} received\n`)
      try {
        return await inner(message, task)
      } finally {
        io.stdout.write(`${new Date().toISOString()} task ${task.task.id} ${stateName(task.task.status.state)}\n`)
      }
    }
  }

  if (flags.worker && modes === 0) throw new CliError('--worker runs jobs as messages: add --harness <name>, --exec <command>, --proxy <url> or --echo', 2)
  const answerWithin = flags['answer-within'] === undefined ? undefined : Number(flags['answer-within']) * 1000
  if (answerWithin !== undefined && !(answerWithin > 0)) throw new CliError('--answer-within is a number of seconds (Infinity: no limit)', 2)
  if (answerWithin !== undefined && !flags.worker) throw new CliError('--answer-within is for --worker', 2)
  const identity = await identityFor(config)
  // --worker --group: one group's board; otherwise every group's.
  const only = flags.worker ? chosenGroup(flags.group, io) : undefined
  const pai = await open({ config, identity, card, flags, ...(handler ? { handler } : {}), ...(onRequest ? { onRequest } : {}) })
  if (only !== undefined) {
    try {
      identity.group(only)
    } catch (err) {
      await pai.close()
      throw new CliError((err as Error).message, 2)
    }
  }
  // One worker per group it takes jobs in, started as groups are added.
  const workers = new Map<string, JobWorker>()
  const startWorkers = (): void => {
    if (!flags.worker) return
    for (const g of identity.groups()) {
      if (workers.has(g.id) || (only !== undefined && g.name !== only && g.id !== only)) continue
      const worker = new JobWorker(pai, g, {
        ...(answerWithin !== undefined ? { answerWithin } : {}),
        onJob: (job, event) => { io.stdout.write(`${new Date().toISOString()} ${g.name}: job ${job.id} ${event}\n`) }
      })
      workers.set(g.id, worker)
      worker.start()
    }
  }
  const closeWorkers = async (): Promise<void> => {
    await Promise.all([...workers.values()].map(async (w) => { await w.close() }))
  }
  try {
    const token = await ensureToken(config)
    let gateway
    try {
      gateway = await startGateway(pai, {
        token: token.value,
        host,
        port,
        defaultGroup: async () => (await readGroups(config).catch(() => null))?.default ?? undefined
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') throw new CliError(`${host}:${port} is in use (another pai daemon?); pick another with --listen`)
      throw err
    }
    try {
      // Jobs only once the daemon is fully up: a failed start holds no claims.
      startWorkers()
      await writeDaemonAddress(config, { url: gateway.url, pid: process.pid })
      io.stdout.write(`${card.name} is listening${flags.proxy ? `, in front of ${flags.proxy}` : ''}${modes ? '' : ' (calls only: it answers no messages)'}${flags.mailbox ? ', and is a mailbox' : ''}${flags.worker ? `, and takes jobs${only !== undefined ? ` in ${only}` : ''}` : ''}\n`)
      io.stdout.write(`id: ${identity.self}\n`)
      io.stdout.write(`device: ${hex(pai.id)}\n`)
      const names = (): string => identity.groups().map((g) => g.name).join(', ') || 'none yet (pai group create <name>, or pai group join <code>)'
      io.stdout.write(`groups: ${names()}\n`)
      // A group moved to rules this pai can't apply, or this pai applies it
      // differently from the admins': say so, once each. Groups added while
      // it runs get a worker, and are said.
      let told: string | null = null
      let known = identity.groups().length
      identity.onAdmissionChange(() => {
        const problem = identity.problem
        if (problem !== told) {
          told = problem
          if (problem) io.stderr.write(`${problem}\n`)
        }
        if (identity.groups().length !== known) {
          known = identity.groups().length
          io.stdout.write(`groups: ${names()}\n`)
          startWorkers()
        }
      })
      io.stdout.write(`gateway: ${gateway.url}/agents/<id> (bearer token in ${token.file})\n`)
      await aborted(io.signal)
    } finally {
      // Jobs it holds go back to the board while it can still write.
      await closeWorkers()
      await removeDaemonAddress(config, process.pid)
      await gateway.close()
    }
  } finally {
    await closeWorkers()
    exec?.stop()
    await pai.close()
  }
  return 0
}

function listenAddress (value: string | undefined): { host: string, port: number } {
  if (!value) return { host: '127.0.0.1', port: 7777 }
  const i = value.lastIndexOf(':')
  const host = value.slice(0, i).replace(/^\[|\]$/g, '')
  const port = Number(value.slice(i + 1))
  if (i <= 0 || !Number.isInteger(port) || port < 0 || port > 65535) throw new CliError(`--listen wants host:port, got ${value}`, 2)
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new CliError('--listen must be a loopback address (127.0.0.1, localhost or [::1])', 2)
  return { host, port }
}

async function card (args: string[], flags: Flags, io: CliIo): Promise<number> {
  const target = need(args[0], 'card needs an agent id')
  return await withAgent(target, flags, io, async (peer) => {
    if (!flags.watch) {
      const c = await peer.card()
      if (!c) throw new CliError('The agent has no card yet')
      io.stdout.write(JSON.stringify(c, null, 2) + '\n')
      return 0
    }
    for await (const c of peer.watchCard({ ...(io.signal ? { signal: io.signal } : {}), onInvalid: (err) => { io.stderr.write(`invalid card: ${err.errors.join('; ')}\n`) } })) {
      io.stdout.write(JSON.stringify(c) + '\n')
    }
    return 0
  })
}

async function send (args: string[], flags: Flags, io: CliIo): Promise<number> {
  const target = need(args[0], 'send needs an agent id')
  const text = args.length > 1 ? args.slice(1).join(' ') : await readStdin(io)
  if (!text) throw new CliError(io.shell ? 'Nothing to send: pass the text' : 'Nothing to send: pass the text, or pipe it on stdin', 2)
  const message = userText(text, {
    ...(flags.task ? { taskId: flags.task } : {}),
    ...(flags.context ? { contextId: flags.context } : {})
  })
  if (flags.durable) {
    if (flags.stream) throw new CliError('--durable and --stream don\'t go together: a durable send returns at once', 2)
    parseId(target)
    const post = await (await daemonClient(flags, io)).post(target, message)
    if (flags.json) io.stdout.write(`${JSON.stringify(post)}\n`)
    else io.stdout.write(`queued ${post.id}: \`pai outbox\` shows when it's delivered and the reply\n`)
    return 0
  }
  return await withAgent(target, flags, io, async (peer) => {
    if (flags.stream) return await printStream(peer.stream(message), flags, io, peer)
    return printResult(await peer.send(message), flags, io)
  })
}

async function daemonClient (flags: Flags, io: CliIo): Promise<DaemonClient> {
  return await connectTo(await loadConfig(flags.config, io), flags, io)
}

// The running daemon, for calls in the group chosen (--group, PAI_GROUP,
// or the daemon's default).
async function connectTo (config: LoadedConfig, flags: Flags, io: CliIo): Promise<DaemonClient> {
  const group = chosenGroup(flags.group, io)
  return new DaemonClient({ ...await daemonConnection(config), ...(group !== undefined ? { group } : {}) })
}

async function outbox (flags: Flags, io: CliIo): Promise<number> {
  const posts = await (await daemonClient(flags, io)).posts()
  if (flags.json) {
    for (const post of posts) io.stdout.write(`${JSON.stringify(post)}\n`)
    return 0
  }
  if (!posts.length) io.stdout.write('No durable sends yet.\n')
  for (const post of posts) {
    const what = post.kind === 'task' ? 'reply' : 'message'
    const via = post.state === 'deposited' ? ` at mailbox ${post.mailbox?.slice(0, 8)}…` : ''
    const reply = post.task ? `; task ${stateName(post.task.status.state)}${replyText(post.task)}` : ''
    const error = post.state === 'queued' || post.state === 'failed' ? (post.lastError ? ` (${post.lastError})` : '') : ''
    io.stdout.write(`${post.id}  ${what} to ${post.to.slice(0, 8)}…  ${post.state}${via}${reply}${error}\n`)
  }
  return 0
}

// The reply's text: the status message's, or else the artifacts'.
function replyText (task: Task): string {
  const parts = task.status.message?.parts ?? task.artifacts?.flatMap((a) => a.parts) ?? []
  const text = parts.map((p) => 'text' in p ? p.text : '').join('').trim()
  return text ? `: ${text}` : ''
}

async function mailbox (args: string[], flags: Flags, io: CliIo): Promise<number> {
  const [sub, id] = args
  if (sub !== 'add') throw new CliError('Usage: pai mailbox add <agent id>', 2)
  const target = need(id, 'mailbox add needs the mailbox agent\'s id')
  parseId(target)
  const config = await loadConfig(flags.config, io)
  const added = await addMailbox(config, target.toLowerCase())
  io.stdout.write(added ? `Added mailbox ${target.slice(0, 8)}… to ${config.path}; restart the daemon to use it.\n` : 'That mailbox is already listed.\n')
  return 0
}

const TASK_USAGE = 'Usage: pai task get|cancel|subscribe <agent> <taskId>, or pai task list <agent>'

async function task (args: string[], flags: Flags, io: CliIo): Promise<number> {
  const [action, target, taskId] = args
  if (action === 'list' && target) return await listTasks(target, flags, io)
  if (!action || !target || !taskId) throw new CliError(TASK_USAGE, 2)
  return await withAgent(target, flags, io, async (peer) => {
    switch (action) {
      case 'get': return printTask(await peer.getTask(taskId), flags, io)
      case 'cancel': return printTask(await peer.cancelTask(taskId), flags, io)
      case 'subscribe': return await printStream(peer.subscribe(taskId), flags, io, peer)
      default: throw new CliError(`Unknown task action: ${action}. ${TASK_USAGE}`, 2)
    }
  })
}

async function listTasks (target: string, flags: Flags, io: CliIo): Promise<number> {
  let status: TaskState | undefined
  if (flags.state) {
    const full = `TASK_STATE_${flags.state.toUpperCase().replace(/-/g, '_')}`
    if (!isTaskState(full)) throw new CliError(`Unknown state: ${flags.state}`, 2)
    status = full
  }
  return await withAgent(target, flags, io, async (peer) => {
    const res = await peer.listTasks({
      ...(flags.context ? { contextId: flags.context } : {}),
      ...(status ? { status } : {}),
      ...(flags.limit ? { pageSize: Number(flags.limit) } : {}),
      ...(flags.page ? { pageToken: flags.page } : {}),
      historyLength: 0
    })
    if (flags.json) {
      io.stdout.write(JSON.stringify(res, null, 2) + '\n')
      return 0
    }
    for (const t of res.tasks) io.stdout.write(`${t.id}  ${stateName(t.status.state)}  ${t.status.timestamp ?? ''}\n`)
    io.stderr.write(`${res.tasks.length} of ${res.totalSize} tasks\n`)
    if (res.nextPageToken) io.stderr.write(`More: pai task list ${target} --page ${res.nextPageToken}\n`)
    return 0
  })
}

// Runs `fn` against `target` through the daemon running for this config,
// so calls go out as the daemon's agent.
async function withAgent (target: string, flags: Flags, io: CliIo, fn: (agent: RemoteAgent) => Promise<number>): Promise<number> {
  if (flags.bootstrap || flags.timeout) throw new CliError('--bootstrap and --timeout are `pai daemon` options; calls go through the running daemon', 2)
  const config = await loadConfig(flags.config, io)
  parseId(target)
  const daemon = await connectTo(config, flags, io)
  return await fn(daemon.agent(target))
}

async function open (opts: {
  config: LoadedConfig
  identity: GroupIdentity
  card: LoadedConfig['card']
  flags: Flags
  handler?: MessageHandler
  onRequest?: RawRequestHandler
}): Promise<Pai> {
  const { flags } = opts
  const pai = new Pai({
    identity: opts.identity,
    storage: opts.config.storage,
    card: opts.card,
    ...(flags.bootstrap ? { bootstrap: flags.bootstrap.map(node) } : {}),
    ...(flags.timeout ? { timeout: Number(flags.timeout) } : {}),
    ...(opts.config.mailboxes?.length ? { mailboxes: opts.config.mailboxes.map((id) => Buffer.from(id, 'hex')) } : {}),
    ...(flags.mailbox ? { serveMailbox: true } : {})
  })
  if (opts.handler) pai.onMessage(opts.handler)
  if (opts.onRequest) pai.onRequest(opts.onRequest)
  try {
    await pai.ready()
  } catch (err) {
    await pai.close().catch(() => {})
    throw locked(err, opts.config.storage)
  }
  return pai
}

async function group (args: string[], flags: Flags, io: CliIo): Promise<number> {
  const [sub, target, extra] = args
  const config = await loadConfig(flags.config, io)
  switch (sub) {
    case 'create': return await groupCreate(config, need(target, 'group create needs a name for the group'), flags, io)
    case 'join': return await groupJoin(config, need(target, 'group join needs an invite code (an admin makes one with `pai group invite`)'), flags, io)
    case 'list': return await groupList(config, flags, io)
    case 'use': return await groupUse(config, need(target, 'group use needs the name of one of your groups (pai group list)'), io)
  }
  // The rest act through the running daemon, which holds the groups.
  const connect = async (): Promise<DaemonClient> => await connectTo(config, flags, io)
  switch (sub) {
    case 'show': {
      const state = await (await connect()).group()
      if (flags.json) {
        io.stdout.write(JSON.stringify(state, null, 2) + '\n')
        return 0
      }
      printRoster(state, io)
      return 0
    }
    case 'invite': {
      const action = {
        action: 'invite' as const,
        days: positive(flags.days, '--days'),
        ...(flags.role ? { roles: roleList(flags.role) } : {}),
        ...(flags.hours ? { hours: positive(flags.hours, '--hours')! } : {})
      }
      const res = await (await connect()).groupAction(action)
      io.stdout.write(`${res.code}\n`)
      io.stderr.write(`An invite to ${res.group.name}: one use, until ${new Date(res.expires!).toISOString()}. On the new agent: pai init --name <name> --join <code>, or pai group join <code>\n`)
      io.stderr.write('An admin has to be online (running pai daemon) when it joins.\n')
      return 0
    }
    case 'remove': {
      const id = need(target, 'group remove needs an agent id')
      parseId(id)
      await (await connect()).groupAction({ action: 'remove', id: id.toLowerCase() })
      io.stdout.write(`Removed ${id.slice(0, 8)}…: members drop its connections as they sync.\n`)
      return 0
    }
    case 'renew': {
      const id = need(target, 'group renew needs an agent id')
      parseId(id)
      const days = positive(flags.days, '--days')
      await (await connect()).groupAction({ action: 'renew', id: id.toLowerCase(), days })
      io.stdout.write(days === null ? `${id.slice(0, 8)}…'s membership no longer ends.\n` : `${id.slice(0, 8)}… is a member for ${days} more days.\n`)
      return 0
    }
    case 'admin': {
      const id = need(extra, 'Usage: pai group admin add|remove <agent id>')
      parseId(id)
      if (target !== 'add' && target !== 'remove') throw new CliError('Usage: pai group admin add|remove <agent id>', 2)
      return proposed(await (await connect()).groupAction({ action: 'propose', op: { type: target === 'add' ? 'admin.add' : 'admin.remove', id: id.toLowerCase() } }), io)
    }
    case 'role': {
      const id = need(target, 'Usage: pai group role <agent id> <role>[,<role>...]')
      parseId(id)
      // Roles after the id, by commas or spaces: `member,approver` or `member approver`.
      const roles = roleList(need(args.slice(2).join(',') || undefined, 'Usage: pai group role <agent id> <role>[,<role>...]'))
      await (await connect()).groupAction({ action: 'roles', id: id.toLowerCase(), roles })
      io.stdout.write(`${id.slice(0, 8)}… now has roles: ${roles.join(', ')}\n`)
      return 0
    }
    case 'policy': {
      if (target === undefined || target === 'list') {
        const { roster } = await (await connect()).group()
        if (flags.json) io.stdout.write(JSON.stringify(roster.policy, null, 2) + '\n')
        else if (roster.policy.length) printPolicy(roster.policy, io)
        else io.stdout.write('No policy rules: every member may call every other.\n')
        return 0
      }
      const usage = 'Usage: pai group policy [list] | allow|deny <name> [--from <who>] [--to <who>] | remove <name>\n  <who> is *, role:<role> or an agent id; default *'
      const name = need(extra, usage)
      if (!isRuleName(name)) throw new CliError(`${name} is not a rule name: lowercase letters, digits, ., _ and -, up to 64`, 2)
      if (target === 'remove') {
        await (await connect()).groupAction({ action: 'policy.remove', name })
        io.stdout.write(`Removed rule ${name}.\n`)
        return 0
      }
      if (target !== 'allow' && target !== 'deny') throw new CliError(usage, 2)
      const rule = { name, from: selector(flags.from), to: selector(flags.to), allow: target === 'allow' }
      await (await connect()).groupAction({ action: 'policy.set', rule })
      io.stdout.write(`Rule ${name}: ${rule.allow ? 'allow' : 'deny'} ${rule.from} -> ${rule.to}\n`)
      return 0
    }
    case 'rotate':
      return proposed(await (await connect()).groupAction({ action: 'rotate' }), io)
    case 'rules': {
      const c = await connect()
      if (target === undefined) {
        const state = await c.group()
        io.stdout.write(`The group is on rules v${state.rules.group}; this pai applies up to v${state.rules.supported}.\n`)
        if (state.problem) io.stderr.write(`${state.problem}\n`)
        return 0
      }
      const v = Number(target)
      if (!Number.isInteger(v) || v < 1) throw new CliError('Usage: pai group rules [<version>]', 2)
      return proposed(await c.groupAction({ action: 'propose', op: { type: 'rules.set', version: v } }), io)
    }
    case 'quorum': {
      const k = need(target, 'Usage: pai group quorum <k>|majority')
      if (k !== 'majority' && !(Number.isInteger(Number(k)) && Number(k) >= 1)) throw new CliError('quorum is a whole number of admins, or majority', 2)
      return proposed(await (await connect()).groupAction({ action: 'propose', op: { type: 'quorum.set', k: k === 'majority' ? 'majority' : Number(k) } }), io)
    }
    case 'approve':
    case 'withdraw': {
      const pid = need(target, `group ${sub} needs a proposal id (pai group show lists them)`)
      if (!/^[0-9a-f]{64}$/.test(pid)) throw new CliError(`${pid} is not a proposal id`, 2)
      const state = await (await connect()).groupAction({ action: sub, pid })
      const open = state.roster.proposals.find((p) => p.pid === pid)
      if (sub === 'withdraw') io.stdout.write(open ? 'Not withdrawn: only the admin who proposed it can.\n' : 'Withdrawn.\n')
      else io.stdout.write(open ? `Approved: ${open.approvals.length} of ${state.roster.quorum.k} admins so far.\n` : 'Approved, and done.\n')
      return 0
    }
    default:
      throw new CliError('Usage: pai group list | use <name> | create <name> | join <code> [--as <name>] | show | invite | remove <id> | renew <id> | role <id> <roles> | policy ... | rotate | rules [<version>] | admin add|remove <id> | quorum <k> | approve|withdraw <proposal>', 2)
  }
}

async function job (args: string[], flags: Flags, io: CliIo): Promise<number> {
  const [sub, target] = args
  const usage = 'Usage: pai job post [text] [--to <who>] [--lease <s>] [--wait] | list [--state <s>] [--watch] | get <id> [--wait] | cancel <id> | take <id> | done|fail <id> [text] | release <id> | answer <id> [text]'
  const client = async (): Promise<DaemonClient> => await daemonClient(flags, io)
  const jobId = (v: string | undefined): string => {
    const id = need(v, `job ${sub} needs a job id (pai job list shows them)`)
    if (!isJobId(id)) throw new CliError(`${id} is not a job id`, 2)
    return id
  }
  switch (sub) {
    case 'post': {
      const text = args.length > 1 ? args.slice(1).join(' ') : await readStdin(io)
      if (!text) throw new CliError(io.shell ? 'Nothing to post: pass the text' : 'Nothing to post: pass the text, or pipe it on stdin', 2)
      const to = flags.to === undefined ? undefined : /^[0-9a-fA-F]{64}$/.test(flags.to) ? flags.to.toLowerCase() : flags.to
      if (to !== undefined && !isJobTarget(to)) throw new CliError(`--to takes role:<role> or an agent id, not ${flags.to}`, 2)
      const lease = positive(flags.lease, '--lease')
      if (lease !== null && lease * 1000 < MIN_LEASE) throw new CliError(`--lease is at least ${MIN_LEASE / 1000} seconds`, 2)
      const ms = (v: string | undefined, name: string): number | undefined => {
        if (v === undefined) return undefined
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) throw new CliError(`${name} is a number of seconds`, 2)
        return Math.round(n * 1000)
      }
      const retries = flags.retries === undefined ? undefined : Number(flags.retries)
      if (retries !== undefined && !(Number.isInteger(retries) && retries >= 0)) throw new CliError('--retries is a whole number, 0 or more', 2)
      const limits = { timeout: ms(flags['max-time'], '--max-time'), deadline: ms(flags.deadline, '--deadline'), retries, backoff: ms(flags.backoff, '--backoff') }
      const problem = limitsProblem(limits, { timeout: '--max-time', deadline: '--deadline', retries: '--retries', backoff: '--backoff' }, 's')
      if (problem) throw new CliError(problem, 2)
      if (flags.context !== undefined) throw new CliError('job post takes --thread <name> (--context is an A2A context id, for send)', 2)
      const attach = (flags.attach ?? []).flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean)
      for (const a of attach) if (!isJobId(a)) throw new CliError(`--attach takes job ids, not ${a}`, 2)
      const spec = { text, ...(attach.length ? { attach } : {}), ...(flags.thread ? { context: flags.thread } : {}) }
      const specIssue = specProblem(spec)
      if (specIssue) throw new CliError(specIssue.replace(/^attach/, '--attach').replace(/^context/, '--thread'), 2)
      const c = await client()
      const posted = await c.postJob(spec, { ...(to ? { to } : {}), ...(lease ? { lease: Math.round(lease * 1000) } : {}), ...limitsOf(limits) })
      if (!flags.wait) {
        io.stdout.write(flags.json ? `${JSON.stringify(posted)}\n` : `${posted.id}\n`)
        return 0
      }
      return printJob(await waitForJob(c, posted.id, io), flags, io)
    }
    case 'get': {
      const c = await client()
      const id = jobId(target)
      return printJob(flags.wait ? await waitForJob(c, id, io) : await c.job(id), flags, io, !flags.wait)
    }
    case 'list': {
      if (flags.state !== undefined && !(JOB_STATES as readonly string[]).includes(flags.state)) throw new CliError(`--state is one of ${JOB_STATES.join(', ')}`, 2)
      const c = await client()
      const state = flags.state as JobState | undefined
      const jobs = await c.jobs(state)
      if (flags.watch) return await watchJobs(c, state, jobs, flags, io)
      if (flags.json) {
        io.stdout.write(JSON.stringify(jobs, null, 2) + '\n')
        return 0
      }
      if (jobs.length === 0) io.stdout.write('No jobs.\n')
      for (const j of jobs) io.stdout.write(jobLine(j))
      return 0
    }
    case 'cancel': {
      const canceled = await (await client()).cancelJob(jobId(target))
      io.stdout.write(`${canceled.id} ${canceled.state}\n`)
      return 0
    }
    case 'take': {
      const id = jobId(target)
      let taken: { job: JobRecord, mine: boolean, input?: string }
      try {
        taken = await (await client()).takeJob(id, io.signal)
      } catch (err) {
        if (io.signal?.aborted) throw new CliError('Stopped waiting', 130)
        throw err
      }
      if (flags.json) {
        io.stdout.write(`${JSON.stringify(taken.job)}\n`)
        return taken.mine ? 0 : 1
      }
      if (!taken.mine) {
        io.stderr.write(taken.job.claim ? `Another worker took it first (${taken.job.claim.by.slice(0, 8)}…)\n` : 'The claim isn\'t settled yet: see pai job get\n')
        return 1
      }
      const input = taken.input ?? taken.job.spec.text
      io.stdout.write(input.endsWith('\n') ? input : `${input}\n`)
      const lease = taken.job.lease === null ? '' : ` It has a ${Math.round(taken.job.lease / 1000)} s lease, which this daemon renews while it runs.`
      io.stderr.write(`Yours. When it's done: pai job done ${id} <result> (or fail, or release).${lease}\n`)
      return 0
    }
    case 'done':
    case 'fail': {
      const id = jobId(target)
      const text = args.length > 2 ? args.slice(2).join(' ') : await readStdin(io)
      const ended = await (await client()).finishJob(id, sub === 'done' ? 'done' : 'failed', text || null)
      io.stdout.write(`${ended.id} ${ended.state}\n`)
      return 0
    }
    case 'release': {
      const released = await (await client()).releaseJob(jobId(target))
      io.stdout.write(`${released.id} ${released.state}\n`)
      return 0
    }
    case 'answer': {
      const id = jobId(target)
      const text = args.length > 2 ? args.slice(2).join(' ') : await readStdin(io)
      if (!text) throw new CliError(io.shell ? 'Nothing to answer: pass the text' : 'Nothing to answer: pass the text, or pipe it on stdin', 2)
      const answered = await (await client()).answerJob(id, text)
      io.stdout.write(`${answered.id} answered\n`)
      return 0
    }
    default:
      throw new CliError(usage, 2)
  }
}

function jobLine (j: JobRecord): string {
  const who = j.claim ? `  by ${j.claim.by.slice(0, 8)}…` : ''
  const asks = waitingOn(j) ? '  ? asks' : ''
  const text = j.spec.text.replace(/\s+/g, ' ')
  return `${j.id}  ${j.state.padEnd(8)}  ${j.to ?? 'anyone'}${who}${asks}  ${text.length > 60 ? text.slice(0, 59) + '…' : text}\n`
}

// Whether a job's run is waiting for its poster to answer a question.
function waitingOn (j: JobRecord): boolean {
  return questionKey(j) !== ''
}

function askLine (j: JobRecord): string {
  return `Job ${j.id} asks: ${j.question!.text}\n  answer with: pai job answer ${j.id} <text>\n`
}

// How often `job list --watch` reads the board.
const WATCH_EVERY = 1000

// `job list --watch`: the board as it stands, then each job as it's posted
// or changes hands or state (one JSON object per line with --json), until
// stopped.
async function watchJobs (client: DaemonClient, state: JobState | undefined, first: JobRecord[], flags: Flags, io: CliIo): Promise<number> {
  const seen = new Map<string, string>()
  const mark = (j: JobRecord): string => `${j.state} ${j.claim?.by ?? ''} ${j.claim?.at ?? ''}`
  const show = (j: JobRecord): void => { io.stdout.write(flags.json ? `${JSON.stringify(j)}\n` : jobLine(j)) }
  // Oldest first, so the newest ends up at the bottom.
  for (const j of [...first].reverse()) {
    seen.set(j.id, mark(j))
    show(j)
  }
  while (!io.signal?.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, WATCH_EVERY)
      function done (): void { clearTimeout(timer); io.signal?.removeEventListener('abort', done); resolve() }
      io.signal?.addEventListener('abort', done, { once: true })
    })
    if (io.signal?.aborted) break
    let jobs: JobRecord[]
    try {
      jobs = await client.jobs(state, io.signal)
    } catch (err) {
      if (io.signal?.aborted) break
      throw err
    }
    for (const j of [...jobs].reverse()) {
      const m = mark(j)
      if (seen.get(j.id) === m) continue
      seen.set(j.id, m)
      show(j)
    }
    // Pruned, or out of the --state filter: forgotten.
    const ids = new Set(jobs.map((j) => j.id))
    for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id)
  }
  return 0
}

// Polls the daemon (each request waits up to a minute) until the job ends.
async function waitForJob (client: DaemonClient, id: string, io: CliIo): Promise<JobRecord> {
  // Each question, once, as it comes (the wait goes on: answer elsewhere).
  let asked = ''
  for (;;) {
    if (io.signal?.aborted) throw new CliError('Stopped waiting', 130)
    let job: JobRecord
    try {
      job = await client.job(id, 60_000, io.signal, asked)
    } catch (err) {
      if (io.signal?.aborted) throw new CliError('Stopped waiting', 130)
      throw err
    }
    if (isEnded(job)) return job
    const key = questionKey(job)
    if (key !== asked) {
      asked = key
      if (key) io.stderr.write(askLine(job))
    }
  }
}

// A job: with --json, as JSON; else its result once it has one (exit 1 if
// it failed or was canceled), or where it stands.
function printJob (job: JobRecord, flags: Flags, io: CliIo, status = false): number {
  const failed = job.state === 'failed' || job.state === 'canceled'
  if (flags.json) {
    io.stdout.write(JSON.stringify(job, null, 2) + '\n')
    return failed ? 1 : 0
  }
  if (status || (job.state !== 'done' && job.state !== 'failed')) {
    io.stdout.write(`${job.id}: ${job.state}${job.claim ? `, claimed by ${job.claim.by}` : ''}${job.to ? ` (for ${job.to})` : ''}\n`)
    if (waitingOn(job)) io.stdout.write(askLine(job))
    const limits = [
      job.retries != null ? `attempt ${job.attempt ?? 0} of ${job.retries + 1}` : '',
      job.notBefore != null && job.state === 'open' ? `next try after ${new Date(job.notBefore).toISOString()}` : '',
      job.due != null ? `due ${new Date(job.due).toISOString()}` : '',
      job.timeout != null ? `${Math.round(job.timeout / 1000)} s per attempt` : ''
    ].filter(Boolean)
    if (limits.length) io.stdout.write(`  ${limits.join(' · ')}\n`)
    if (job.lastError && job.state !== 'done') io.stdout.write(`  last attempt: ${job.lastError}\n`)
  }
  if (job.result !== null) io.stdout.write(job.result.endsWith('\n') ? job.result : `${job.result}\n`)
  if (job.ref && (status || failed)) io.stderr.write(`The task: pai task get ${job.claim?.by ?? '<worker>'} ${job.ref}\n`)
  if (failed && !status) io.stderr.write(`Job ${job.state}\n`)
  return failed ? 1 : 0
}

// The link carries the daemon's token after `#`, which browsers never send
// to a server; the page keeps it for the tab's session.
async function ui (flags: Flags, io: CliIo): Promise<number> {
  const { url, token } = await daemonConnection(await loadConfig(flags.config, io))
  io.stdout.write(`${url}/ui#token=${encodeURIComponent(token)}\n`)
  io.stderr.write('Open it in a browser on this machine. It has the daemon\'s token: don\'t share it.\n')
  return 0
}

async function inbox (flags: Flags, io: CliIo): Promise<number> {
  // Every group's, unless --group (or PAI_GROUP) picks one.
  const only = chosenGroup(flags.group, io)
  const box = await (await daemonClient(flags, io)).inbox(only !== undefined ? { group: only } : {})
  if (flags.json) {
    io.stdout.write(JSON.stringify(box, null, 2) + '\n')
    return 0
  }
  const empty = !box.questions.length && !box.open.length && !box.held.length && !box.proposals.length
  if (empty) {
    io.stdout.write('Nothing waiting on you.\n')
    return 0
  }
  // Each item names its group when there's more than one to tell apart.
  const all = [...box.questions, ...box.held, ...box.open, ...box.proposals]
  const several = new Set(all.map((x) => x.group)).size > 1
  const where = (x: { group: string }): string => several ? `[${x.group}] ` : ''
  const flag = several ? ' --group <group>' : ''
  if (box.questions.length) {
    io.stdout.write('Questions for you\n')
    for (const j of box.questions) io.stdout.write(`  ${where(j)}${j.id}  ${j.question!.text.replace(/\s+/g, ' ').slice(0, 100)}\n`)
    io.stdout.write(`  answer with: pai job answer <id> <text>${flag}\n`)
  }
  if (box.held.length) {
    io.stdout.write('Jobs you hold\n')
    for (const j of box.held) io.stdout.write(`  ${where(j)}${jobLine(j)}`)
  }
  if (box.open.length) {
    io.stdout.write(`Jobs you may take (pai job take <id>${flag})\n`)
    for (const j of box.open) io.stdout.write(`  ${where(j)}${jobLine(j)}`)
  }
  if (box.proposals.length) {
    io.stdout.write(`Proposals to approve (pai group approve <id>${flag})\n`)
    for (const p of box.proposals) io.stdout.write(`  ${where(p)}${p.pid}  ${p.op.type}  by ${p.by.slice(0, 8)}…\n`)
  }
  return 0
}

async function flow (args: string[], flags: Flags, io: CliIo): Promise<number> {
  const [sub, target] = args
  const usage = 'Usage: pai flow guide | check <file.json> | show <file.json> | start <file.json> [input] [--wait] | list | get <id> [--wait] | cancel <id> | schedule <name> <file.json> [input] --every <s> [--start <time>] | schedules | unschedule <name>'
  const client = async (): Promise<DaemonClient> => await daemonClient(flags, io)
  const flowId = (v: string | undefined): string => {
    const id = need(v, `flow ${sub} needs a workflow id (pai flow list shows them)`)
    if (!isJobId(id)) throw new CliError(`${id} is not a workflow id`, 2)
    return id
  }
  // The group as this daemon sees it, or why there's none to read.
  const group = async (): Promise<{ c: DaemonClient, state: GroupState } | { error: string }> => {
    try {
      const c = await client()
      return { c, state: await c.group() }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }
  switch (sub) {
    case 'guide': {
      io.stdout.write(FLOW_FORMAT)
      const g = await group()
      if ('error' in g) {
        io.stdout.write(`\n## This group\n\nCouldn't read the group's roles and members (it needs a group agent's daemon running here): ${g.error}\n`)
        return 0
      }
      const { roster } = g.state
      const now = Date.now()
      const live = roster.members.filter((m) => admitted(roster, m.id, now))
      const members: GuideMember[] = await Promise.all(live.map(async (m) => {
        const card = await Promise.race([g.c.agent(m.id).card().catch(() => null), new Promise<null>((resolve) => setTimeout(() => { resolve(null) }, 3000).unref())])
        return {
          id: m.id,
          name: m.name,
          roles: m.roles,
          admin: roster.admins.includes(m.id),
          ...(card?.description ? { description: card.description } : {}),
          ...(card?.skills?.length ? { skills: card.skills.map((k) => k.name) } : {})
        }
      }))
      const blocked = [null, ...new Set(live.flatMap((m) => m.roles.map((r) => `role:${r}`))), ...live.map((m) => m.id)].filter((to) => !mayPost(roster, g.state.id, to)).map((to) => to ?? 'anyone (null)')
      io.stdout.write('\n' + groupGuide(g.state.id, members, blocked))
      if (!g.state.writable) io.stdout.write('\nThis device is still syncing the group: some members may be missing.\n')
      return 0
    }
    case 'check': {
      const file = need(target, 'flow check needs a workflow file')
      let spec: unknown
      try {
        spec = await readJsonFile(file, io.cwd)
      } catch (err) {
        if (!flags.json) throw err
        io.stdout.write(JSON.stringify({ ok: false, problems: [(err as Error).message], warnings: [], group: false }, null, 2) + '\n')
        return 1
      }
      const g = await group()
      const result = checkFlow(spec, 'error' in g ? undefined : { self: g.state.id, roster: g.state.roster, syncing: !g.state.writable })
      const note = 'error' in g ? `who the steps are for wasn't checked against the group: ${g.error}` : null
      if (flags.json) {
        io.stdout.write(JSON.stringify({ ok: result.problems.length === 0, ...result, group: !('error' in g), ...(note ? { note } : {}) }, null, 2) + '\n')
        return result.problems.length ? 1 : 0
      }
      for (const p of result.problems) io.stdout.write(`problem: ${p}\n`)
      for (const w of result.warnings) io.stdout.write(`warning: ${w}\n`)
      if (note) io.stdout.write(`note: ${note}\n`)
      io.stdout.write(result.problems.length ? `${file}: ${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}\n` : `${file}: ok\n`)
      return result.problems.length ? 1 : 0
    }
    case 'show': {
      const spec = await readSpec(need(target, 'flow show needs a workflow file'), io.cwd)
      io.stdout.write(flowLayout(spec) + '\n')
      return 0
    }
    case 'start': {
      const spec = await readSpec(need(target, usage), io.cwd)
      const input = args.length > 2 ? args.slice(2).join(' ') : await readStdin(io)
      const c = await client()
      const started = await c.startFlow(spec, input, flags.key !== undefined ? { key: flags.key } : {})
      if (!flags.wait) {
        io.stdout.write(flags.json ? `${JSON.stringify(started)}\n` : `${started.id}\n`)
        return 0
      }
      return printFlow(await waitForFlow(c, started.id, io), flags, io)
    }
    case 'get': {
      const c = await client()
      const id = flowId(target)
      return printFlow(flags.wait ? await waitForFlow(c, id, io) : await c.flow(id), flags, io, !flags.wait)
    }
    case 'list': {
      const flows = await (await client()).flows()
      if (flags.json) {
        io.stdout.write(JSON.stringify(flows, null, 2) + '\n')
        return 0
      }
      if (flows.length === 0) io.stdout.write('No workflows.\n')
      for (const f of flows) io.stdout.write(`${f.id}  ${f.state.padEnd(8)}  ${f.done}/${f.steps} steps${f.skipped || f.failed ? ` (${[f.skipped ? `${f.skipped} skipped` : '', f.failed ? `${f.failed} failed on a branch` : ''].filter(Boolean).join(', ')})` : ''}  ${f.name ?? ''}${f.parent ? `  (a step of ${f.parent})` : ''}${f.schedule ? `  (schedule ${f.schedule})` : ''}\n`)
      return 0
    }
    case 'cancel': {
      const canceled = await (await client()).cancelFlow(flowId(target))
      io.stdout.write(`${canceled.id} ${canceled.state}\n`)
      return 0
    }
    case 'schedule': {
      const name = need(target, usage)
      const spec = await readSpec(need(args[2], usage), io.cwd)
      const every = Number(need(flags.every, 'flow schedule needs --every <seconds>'))
      if (!Number.isFinite(every) || every <= 0) throw new CliError('--every is a number of seconds', 2)
      const start = flags.start === undefined ? undefined : Date.parse(flags.start)
      if (start !== undefined && !Number.isFinite(start)) throw new CliError('--start is a time, such as 2026-12-01T09:00', 2)
      const input = args.length > 3 ? args.slice(3).join(' ') : ''
      const schedule = { name, flow: spec, input, every: Math.round(every * 1000), ...(start !== undefined ? { start } : {}) }
      const problem = scheduleProblem(schedule)
      if (problem) throw new CliError(problem, 2)
      const set = await (await client()).setSchedule(schedule)
      io.stdout.write(flags.json ? `${JSON.stringify(set)}\n` : `${set.name}: every ${set.every / 1000} s, next at ${new Date(set.next).toISOString()}\n`)
      return 0
    }
    case 'schedules': {
      const schedules = await (await client()).schedules()
      if (flags.json) {
        io.stdout.write(JSON.stringify(schedules, null, 2) + '\n')
        return 0
      }
      if (schedules.length === 0) io.stdout.write('No schedules.\n')
      for (const s of schedules) io.stdout.write(`${s.name.padEnd(16)} every ${s.every / 1000} s  next ${new Date(s.next).toISOString()}  ${s.runs} run(s)  by ${s.by.slice(0, 8)}…  ${s.flow.name ?? ''}\n`)
      return 0
    }
    case 'unschedule': {
      const name = need(target, usage)
      await (await client()).dropSchedule(name)
      io.stdout.write(`${name} dropped\n`)
      return 0
    }
    default:
      throw new CliError(usage, 2)
  }
}

async function readJsonFile (path: string, cwd: string): Promise<unknown> {
  const file = resolve(cwd, path)
  try {
    return JSON.parse(await readFile(file, 'utf-8'))
  } catch (err) {
    throw new CliError(`Can't read the workflow in ${file}: ${(err as Error).message}`)
  }
}

// A workflow from a JSON file, checked (fields pai doesn't know too:
// they'd be ignored, and are most likely a mistake).
async function readSpec (path: string, cwd: string): Promise<FlowSpec> {
  const spec = await readJsonFile(path, cwd) as FlowSpec
  const problem = unknownFields(spec)[0] ?? flowProblem(spec)
  if (problem) throw new CliError(`${resolve(cwd, path)}: ${problem} (pai flow check lists every problem)`, 2)
  return spec
}

async function waitForFlow (client: DaemonClient, id: string, io: CliIo): Promise<FlowView> {
  for (;;) {
    if (io.signal?.aborted) throw new CliError('Stopped waiting', 130)
    let f: FlowView
    try {
      f = await client.flow(id, 60_000, io.signal)
    } catch (err) {
      if (io.signal?.aborted) throw new CliError('Stopped waiting', 130)
      throw err
    }
    if (f.state !== 'running') return f
  }
}

// A workflow: with --json, as JSON; else its output once done (exit 1 if
// it failed or was canceled), or each step's state.
function printFlow (f: FlowView, flags: Flags, io: CliIo, status = false): number {
  const failed = f.state === 'failed' || f.state === 'canceled'
  if (flags.json) {
    io.stdout.write(JSON.stringify(f, null, 2) + '\n')
    return failed ? 1 : 0
  }
  if (status || f.state !== 'done') {
    io.stdout.write(`${f.id}: ${f.state}${f.name ? ` (${f.name})` : ''}\n`)
    for (const s of f.steps) {
      const where = f.done.includes(s.name) ? 'done' : f.skipped.includes(s.name) ? 'skipped' : f.failed.includes(s.name) ? 'failed (a branch)' : f.items && Object.hasOwn(f.items, s.name) ? `${f.items[s.name]!.done}/${f.items[s.name]!.n} items done` : Object.hasOwn(f.jobs, s.name) ? `${s.flow !== undefined ? 'workflow' : 'job'} ${f.jobs[s.name]}` : 'waiting'
      const test = (c: FlowCondition): string => `${c.step} ${c.not ? 'not ' : ''}${c.failed ? 'failed' : c.equals !== undefined ? `= "${c.equals}"` : `has "${c.contains}"`}`
      const cond = s.if ? `  if ${test(s.if)}` : ''
      const loop = s.repeat ? `  repeat from ${s.repeat.from} until ${test(s.repeat.until)} (round ${(f.loops?.[s.name]?.round ?? 0) + 1} of at most ${s.repeat.max})` : ''
      io.stdout.write(`  ${s.name.padEnd(12)} ${s.flow !== undefined ? 'sub-workflow' : s.to ?? 'anyone'}  ${where}${cond}${loop}\n`)
    }
  }
  if (f.cut.length) io.stderr.write(`Cut to fit in a job: ${f.cut.join(', ')}\n`)
  if (f.output !== null && (f.state === 'done' || failed)) {
    const out = failed ? io.stderr : io.stdout
    out.write(f.output.endsWith('\n') ? f.output : `${f.output}\n`)
  }
  return failed ? 1 : 0
}

async function device (args: string[], flags: Flags, io: CliIo): Promise<number> {
  const [sub, target] = args
  const config = await loadConfig(flags.config, io)
  if (sub === 'join') throw new CliError('A new device joins with `pai init --device <code>`, in a folder of its own', 2)
  const connect = async (): Promise<DaemonClient> => await connectTo(config, flags, io)
  switch (sub) {
    case 'invite': {
      const hours = positive(flags.hours, '--hours')
      const res = await (await connect()).deviceAction({ action: 'invite', ...(hours ? { hours } : {}) })
      io.stdout.write(`${res.code}\n`)
      io.stderr.write(`One use, until ${new Date(res.expires!).toISOString()}. On the new device: pai init --device <code>\n`)
      io.stderr.write('This daemon has to be running when it joins.\n')
      return 0
    }
    case 'list': {
      const state = await (await connect()).devices()
      if (flags.json) {
        io.stdout.write(JSON.stringify(state, null, 2) + '\n')
        return 0
      }
      io.stdout.write(`Identity ${state.identity}\n`)
      for (const d of state.devices) io.stdout.write(`  ${d.device}  ${d.name ?? ''}${d.device === state.device ? '  (this device)' : ''}\n`)
      return 0
    }
    case 'remove': {
      const id = need(target, 'device remove needs a device id (pai device list shows them)')
      parseId(id)
      await (await connect()).deviceAction({ action: 'remove', device: id.toLowerCase() })
      io.stdout.write(`Removed device ${id.slice(0, 8)}…: members drop its connections as they sync.\n`)
      return 0
    }
    default:
      throw new CliError('Usage: pai device invite | list | remove <device id>', 2)
  }
}

// A new group, with this agent as its only admin: through the daemon if
// it's running, else in this folder's store.
async function groupCreate (config: LoadedConfig, name: string, flags: Flags, io: CliIo): Promise<number> {
  const live = await runningDaemon(config, flags, io)
  if (live) {
    const res = await live.groupsAction({ action: 'create', name })
    io.stdout.write(`Started group ${res.created}, with this agent as its admin.${res.default === res.created ? ' It\'s the default group.' : ` Make it the default with \`pai group use ${res.created}\`.`}\n`)
    io.stdout.write(`Next: \`pai group invite --group ${res.created}\` for each agent that should join.\n`)
    return 0
  }
  const added = await addGroup(config, async (state, keyPair) => await createGroup({ storage: config.storage, keys: state.keys, keyPair, name: uniqueName(state, name), title: name, member: config.card.name }))
  io.stdout.write(`Started group ${added.name}, with this agent as its admin.${added.isDefault ? ' It\'s the default group.' : ` Make it the default with \`pai group use ${added.name}\`.`}\n`)
  io.stdout.write(`Next: run \`pai daemon\`, then \`pai group invite --group ${added.name}\` for each agent that should join.\n`)
  return 0
}

// Redeems an invite: through the daemon if it's running, else in this
// folder's store. Waits for an admin.
async function groupJoin (config: LoadedConfig, code: string, flags: Flags, io: CliIo): Promise<number> {
  io.stdout.write('Looking for an admin of the group (one has to be online)…\n')
  const live = await runningDaemon(config, flags, io)
  if (live) {
    const res = await live.groupsAction({ action: 'join', code, ...(flags.as ? { as: flags.as } : {}) }, io.signal)
    io.stdout.write(`Joined, as ${res.joined}.${res.default === res.joined ? ' It\'s the default group.' : ` Make it the default with \`pai group use ${res.joined}\`.`}\n`)
    return 0
  }
  const added = await addGroup(config, async (state, keyPair) => {
    const entry = await joinGroup({ ...joinOptions(config, flags, io, keyPair, code), keys: state.keys, name: config.card.name, ...(flags.as ? { as: flags.as } : {}) }).catch((err: Error) => { throw new CliError(err.message) })
    if (state.groups.some((g) => groupId(g.seed) === groupId(entry.seed))) throw new CliError('This agent is already in that group')
    return { ...entry, name: uniqueName(state, entry.name) }
  })
  io.stdout.write(`Joined, as ${added.name}.${added.isDefault ? ' It\'s the default group.' : ` Make it the default with \`pai group use ${added.name}\`.`}\n`)
  io.stdout.write('Next: run `pai daemon`; it syncs the group and connects to the other members.\n')
  return 0
}

// The groups this identity is in, the default marked.
async function groupList (config: LoadedConfig, flags: Flags, io: CliIo): Promise<number> {
  const state = await readGroups(config)
  const current = chosenGroup(flags.group, io) ?? state.default
  const live = await runningDaemon(config, flags, io)
  const details = live ? new Map((await live.groups()).groups.map((g) => [g.name, g])) : new Map()
  if (flags.json) {
    io.stdout.write(JSON.stringify({ default: current, groups: state.groups.map((g) => ({ name: g.name, id: groupId(g.seed), ...(details.get(g.name) ?? {}) })) }, null, 2) + '\n')
    return 0
  }
  if (!state.groups.length) {
    io.stdout.write('No groups yet: pai group create <name>, or pai group join <code>.\n')
    return 0
  }
  for (const g of state.groups) {
    const d = details.get(g.name)
    const about = d ? `  ${d.members} member${d.members === 1 ? '' : 's'}${d.admin ? ', admin' : ''}${d.writable ? '' : ', syncing'}${d.title && d.title !== g.name ? `  (${d.title})` : ''}` : ''
    io.stdout.write(`${g.name === current ? '*' : ' '} ${g.name.padEnd(16)} ${groupId(g.seed)}${about}\n`)
  }
  if (!live) io.stderr.write('(the daemon isn\'t running: members and roles show once it is)\n')
  return 0
}

async function groupUse (config: LoadedConfig, name: string, io: CliIo): Promise<number> {
  const state = await readGroups(config)
  const g = state.groups.find((x) => x.name === name) ?? state.groups.find((x) => groupId(x.seed) === name)
  if (!g) throw new CliError(`No group named ${name}: yours are ${state.groups.map((x) => x.name).join(', ') || 'none yet'}`)
  await writeDefault(config, g.name)
  io.stdout.write(`Commands now act on ${g.name}${io.env.PAI_GROUP ? ` (but PAI_GROUP=${io.env.PAI_GROUP} wins in this shell)` : ''}.\n`)
  return 0
}

// The running daemon here, or null (the store is free to open).
async function runningDaemon (config: LoadedConfig, flags: Flags, io: CliIo): Promise<DaemonClient | null> {
  if (!await readDaemonAddress(config)) return null
  try {
    const client = await connectTo(config, flags, io)
    await client.info()
    return client
  } catch {
    return null
  }
}

// Adds a group to this folder's identity with the daemon not running: under
// the folder's lock, then into the groups file (the first becomes the
// default).
async function addGroup (config: LoadedConfig, make: (state: GroupsState, keyPair: { publicKey: Uint8Array, secretKey: Uint8Array }) => Promise<GroupsState['groups'][number]>): Promise<{ name: string, isDefault: boolean }> {
  const keyPair = await loadKeyPair(config.storage)
  const unlock = await lockOrExplain(config)
  try {
    const state = await readGroups(config)
    if (state.groups.length >= MAX_GROUPS) throw new CliError(`An identity can be in at most ${MAX_GROUPS} groups`)
    const entry = await make(state, keyPair)
    const groups = [...state.groups, entry]
    const fallback = state.default ?? entry.name
    await writeGroups(config, { ...state, groups, default: fallback })
    return { name: entry.name, isDefault: fallback === entry.name }
  } finally {
    await unlock()
  }
}

function uniqueName (state: GroupsState, wanted: string): string {
  const base = groupName(wanted)
  const taken = new Set(state.groups.map((g) => g.name))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

async function lockOrExplain (config: LoadedConfig): Promise<() => Promise<void>> {
  try {
    return await lockStorage(config.storage)
  } catch (err) {
    throw new CliError(`${(err as Error).message}. Stop the daemon first.`)
  }
}

function proposed (state: GroupState & { pid?: string }, io: CliIo): number {
  const open = state.roster.proposals.find((p) => p.pid === state.pid)
  if (!open) {
    io.stdout.write('Done.\n')
    return 0
  }
  io.stdout.write(`Proposed: ${state.pid}\n`)
  io.stderr.write(`It needs ${state.roster.quorum.k} of ${state.roster.admins.length} admins: each other admin runs pai group approve ${state.pid}\n`)
  io.stderr.write('A proposal lapses after 7 days.\n')
  return 0
}

function printRoster (state: GroupState, io: CliIo): void {
  const { roster } = state
  const now = Date.now()
  io.stdout.write(`Group ${state.group.name}${roster.title && roster.title !== state.group.name ? ` (${roster.title})` : ''}, ${state.group.id}\n`)
  io.stdout.write(`You: ${state.id}${state.admin ? ' (admin)' : ''}${state.writable ? '' : ' — still syncing'}\n`)
  io.stdout.write(`Admins: ${roster.admins.length}; admin changes need ${roster.quorum.k}${roster.quorum.setting === 'majority' ? ' (a majority)' : ''}\n`)
  for (const m of roster.members) {
    const role = roster.admins.includes(m.id) ? 'admin' : m.roles.join(',')
    const until = m.until === null ? '' : m.until <= now ? '  lapsed' : `  until ${new Date(m.until).toISOString().slice(0, 10)}`
    io.stdout.write(`  ${m.id}  ${role.padEnd(7)}  ${m.name ?? ''}${until}\n`)
  }
  for (const p of roster.proposals) {
    const what = p.op.type === 'quorum.set' ? `quorum ${p.op.k}` : p.op.type === 'seed.rotate' ? `new seed (epoch ${p.op.epoch})` : p.op.type === 'rules.set' ? `rules v${p.op.version}` : `${p.op.type} ${p.op.id.slice(0, 8)}…`
    io.stdout.write(`Proposal ${p.pid}: ${what}, ${p.approvals.length} of ${roster.quorum.k}\n`)
  }
  const invites = roster.invites.filter((i) => i.expires > now)
  if (invites.length) io.stdout.write(`Open invites: ${invites.length}\n`)
  if (roster.policy.length) printPolicy(roster.policy, io)
  if (roster.seed.epoch > 0) io.stdout.write(`Seed: epoch ${roster.seed.epoch}, since ${new Date(roster.seed.at).toISOString().slice(0, 10)}\n`)
}

function printPolicy (rules: PolicyRule[], io: CliIo): void {
  io.stdout.write('Policy (the most specific rule wins; no rule: allowed):\n')
  for (const r of rules) io.stdout.write(`  ${r.name}: ${r.allow ? 'allow' : 'deny'} ${r.from} -> ${r.to}\n`)
}

// Roles as `a,b`: lowercase names, as the group's rules want them.
function roleList (value: string): string[] {
  const roles = [...new Set(value.split(',').map((r) => r.trim()).filter(Boolean))]
  if (!isRoles(roles)) throw new CliError(`Roles are 1 to ${MAX_ROLES} lowercase names (a-z, 0-9, - and _; not admin), separated by commas`, 2)
  return roles
}

// A policy selector, '*' when not given.
function selector (value: string | undefined): string {
  const v = value === undefined ? '*' : /^[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : value
  if (!isSelector(v)) throw new CliError(`${value} is not *, role:<role> or an agent id`, 2)
  return v
}

function positive (value: string | undefined, flag: string): number | null {
  if (value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`${flag} must be a positive number`, 2)
  return n
}

function parseId (target: string): void {
  if (!/^[0-9a-f]{64}$/i.test(target)) throw new CliError(`${target} is not an agent id (64 hex characters)`)
}

// GetTask and CancelTask return a bare Task, which --json prints as is.
function printTask (task: Task, flags: Flags, io: CliIo): number {
  if (!flags.json) return printResult({ task }, flags, io)
  io.stdout.write(JSON.stringify(task, null, 2) + '\n')
  return exitCode(task)
}

function printResult (result: SendMessageResponse, flags: Flags, io: CliIo): number {
  const task: Task | null = 'task' in result ? result.task : null
  if (flags.json) {
    io.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return exitCode(task)
  }
  const { text, status } = describe(result)
  if (text) io.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  if (status && status !== 'completed') io.stderr.write(`${status}\n`)
  if (task?.status.state === 'TASK_STATE_INPUT_REQUIRED') {
    io.stderr.write(`Reply with: pai send <agent> --task ${task.id} --context ${task.contextId} <text>\n`)
  }
  return exitCode(task)
}

// Ctrl-C (io.signal) cancels the streamed task, and the stream ends with its
// canceled status. The task belongs to the daemon's agent, so anything
// calling through the same daemon can cancel it later.
async function printStream (events: AsyncIterable<StreamResponse>, flags: Flags, io: CliIo, peer: RemoteAgent): Promise<number> {
  let last: StreamResponse | null = null
  let state: TaskState | null = null
  let endsWithNewline = true
  let taskId: string | null = null
  let canceling = false
  const cancel = () => {
    if (!taskId || canceling) return
    canceling = true
    io.stderr.write(`Canceling task ${taskId}\n`)
    peer.cancelTask(taskId).catch((err: unknown) => { io.stderr.write(`pai: ${errorMessage(err)}\n`) })
  }
  io.signal?.addEventListener('abort', cancel, { once: true })
  try {
    for await (const event of events) {
      last = event
      if ('task' in event) {
        taskId = event.task.id
        state = event.task.status.state
      } else if ('statusUpdate' in event) {
        taskId = event.statusUpdate.taskId
        state = event.statusUpdate.status.state
      } else if ('artifactUpdate' in event) {
        taskId = event.artifactUpdate.taskId
      }
      if (io.signal?.aborted) cancel() // aborted before the task id was known
      if (flags.json) {
        io.stdout.write(JSON.stringify(event) + '\n')
        continue
      }
      const { text, status } = describe(event)
      if (text) {
        io.stdout.write(text)
        endsWithNewline = text.endsWith('\n')
      }
      if (status && status !== 'completed') {
        if (!endsWithNewline) { io.stdout.write('\n'); endsWithNewline = true }
        io.stderr.write(`${status}\n`)
      }
    }
  } finally {
    io.signal?.removeEventListener('abort', cancel)
  }
  if (!flags.json && !endsWithNewline) io.stdout.write('\n')
  if (!last) return 1
  return state ? stateExit(state) : 0
}

function exitCode (task: Task | null): number {
  return task ? stateExit(task.status.state) : 0
}

function stateExit (state: TaskState): number {
  return state === 'TASK_STATE_FAILED' || state === 'TASK_STATE_REJECTED' || state === 'TASK_STATE_CANCELED' ? 1 : 0
}

function node (spec: string): BootstrapNode {
  const i = spec.lastIndexOf(':')
  const port = Number(spec.slice(i + 1))
  if (i <= 0 || !Number.isInteger(port)) throw new CliError(`--bootstrap wants host:port, got ${spec}`, 2)
  return { host: spec.slice(0, i), port }
}

function need (value: string | undefined, message: string): string {
  if (!value) throw new CliError(message, 2)
  return value
}

async function readStdin (io: CliIo): Promise<string> {
  if (io.stdin.isTTY || io.shell) return ''
  const chunks: Buffer[] = []
  for await (const chunk of io.stdin) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf-8').replace(/\n$/, '')
}

async function aborted (signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return await new Promise(() => {})
  if (signal.aborted) return
  await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
}

// Another process holds the storage lock.
function locked (err: unknown, storage: string): unknown {
  const message = (err as Error)?.message ?? ''
  if (/lock/i.test(message)) {
    return new CliError(`${storage} is in use by another pai process (is \`pai daemon\` running?)`)
  }
  return err
}

function errorMessage (err: unknown): string {
  if (err instanceof PaiCardError) return `${err.message}\n  ${err.errors.join('\n  ')}`
  if (err instanceof PaiRpcError) return `${err.message} (code ${err.code})`
  return (err as Error)?.message ?? String(err)
}

function hex (key: Uint8Array): string {
  return Buffer.from(key).toString('hex')
}

