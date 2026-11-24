import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { CardInput } from '../pai.js'
import { GroupIdentity } from '../identity/group.js'
import type { GroupEntry, IdentityKeys } from '../identity/group.js'

export const CONFIG_FILE = 'pai.json'

export interface CliConfig {
  // The agent `pai daemon` runs. `pai send`, `pai card` and `pai task` call
  // through the running daemon, as this agent.
  storage: string
  // pai adds its own entry to supportedInterfaces (see CardInput).
  card: CardInput
  // Mailboxes (hex agent ids) for durable sends; see `pai mailbox add`.
  mailboxes?: string[]
}

export interface Env {
  cwd: string
  env: NodeJS.ProcessEnv
}

// A loaded config, with paths resolved against the config file's folder.
export interface LoadedConfig extends CliConfig {
  path: string
  dir: string
}

export async function loadConfig (file: string | undefined, { cwd }: Env): Promise<LoadedConfig> {
  const path = resolve(cwd, file ?? CONFIG_FILE)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    throw new CliError(`No ${file ?? CONFIG_FILE} here. Run \`pai init\` first, or pass --config.`)
  }
  let parsed: CliConfig
  try {
    parsed = JSON.parse(raw) as CliConfig
  } catch (err) {
    throw new CliError(`${path} is not valid JSON: ${(err as Error).message}`)
  }
  if (!parsed.card || !parsed.storage) throw new CliError(`${path} needs storage and card`)
  const dir = dirname(path)
  return {
    ...parsed,
    path,
    dir,
    storage: resolve(dir, parsed.storage)
  }
}

export interface InitOptions {
  name: string
  description?: string
  force?: boolean
}

// Writes pai.json. The identity and its groups come after (see
// writeGroups).
export async function initConfig (opts: InitOptions, { cwd }: Env): Promise<{ path: string, config: LoadedConfig }> {
  const path = resolve(cwd, CONFIG_FILE)
  if (!opts.force && await exists(path)) throw new CliError(`${CONFIG_FILE} already exists; pass --force to overwrite it`)
  const config: CliConfig = {
    storage: '.pai/agent',
    card: {
      name: opts.name,
      description: opts.description ?? `${opts.name} agent`,
      version: '1.0.0',
      capabilities: { streaming: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'default', name: opts.name, description: opts.description ?? `${opts.name} agent`, tags: ['general'] }]
    }
  }
  await writeFile(path, JSON.stringify(config, null, 2) + '\n')
  return { path, config: { ...config, path, dir: cwd, storage: resolve(cwd, config.storage) } }
}

// Adds a mailbox to pai.json, keeping the rest of the file as it is.
export async function addMailbox (config: LoadedConfig, id: string): Promise<boolean> {
  const raw = JSON.parse(await readFile(config.path, 'utf-8')) as CliConfig
  const list = raw.mailboxes ?? []
  if (list.includes(id)) return false
  raw.mailboxes = [...list, id]
  await writeFile(config.path, JSON.stringify(raw, null, 2) + '\n')
  return true
}

// This agent's identity and groups (.pai/groups.json, mode 600): the
// identity's key and secret, and each group's name, slot, key and seed,
// as JSON with base64url bytes. Whoever has it can act as the agent, so
// it's kept private. The running daemon rewrites it as groups are added.
interface GroupsFile {
  pai: 'groups/1'
  identity: string
  secret: string
  groups: Array<{ name: string, slot: string, key: string, seed: string }>
}

// `default`: the group commands act on (.pai/default-group, its name: a
// file of its own, which only `pai group use` and a first group write, so
// it never races the daemon's rewrites of groups.json). One that's no
// longer a group falls back to the first group.
export interface GroupsState {
  keys: IdentityKeys
  groups: GroupEntry[]
  default: string | null
}

export function groupsFile (config: LoadedConfig): string {
  return join(dirname(config.storage), 'groups.json')
}

function defaultFile (config: LoadedConfig): string {
  return join(dirname(config.storage), 'default-group')
}

export async function hasIdentity (config: LoadedConfig): Promise<boolean> {
  return await exists(groupsFile(config))
}

export async function readGroups (config: LoadedConfig): Promise<GroupsState> {
  const file = groupsFile(config)
  const raw = await readJson<GroupsFile>(file, 'groups', 'groups/1', 'This agent has no identity yet: run `pai init`.')
  for (const field of ['identity', 'secret'] as const) {
    if (typeof raw[field] !== 'string' || bytes(raw[field]).byteLength !== 32) throw new CliError(`${file} has no valid ${field}`)
  }
  if (!Array.isArray(raw.groups)) throw new CliError(`${file} has no list of groups`)
  const groups: GroupEntry[] = raw.groups.map((g, i) => {
    if (typeof g?.name !== 'string' || typeof g.slot !== 'string' || typeof g.key !== 'string' || typeof g.seed !== 'string' || bytes(g.key).byteLength !== 32 || bytes(g.seed).byteLength !== 32) {
      throw new CliError(`${file}: group ${i + 1} is not valid`)
    }
    return { name: g.name, slot: g.slot, key: bytes(g.key), seed: bytes(g.seed) }
  })
  const named = (await readFile(defaultFile(config), 'utf-8').catch(() => '')).trim()
  const fallback = groups.some((g) => g.name === named) ? named : groups[0]?.name ?? null
  return { keys: { identity: bytes(raw.identity), secret: bytes(raw.secret) }, groups, default: fallback }
}

// Writes the groups file (all at once: a crash never leaves half of it),
// and the default, when it changes.
export async function writeGroups (config: LoadedConfig, state: GroupsState): Promise<void> {
  const raw: GroupsFile = {
    pai: 'groups/1',
    identity: b64(state.keys.identity),
    secret: b64(state.keys.secret),
    groups: state.groups.map((g) => ({ name: g.name, slot: g.slot, key: b64(g.key), seed: b64(g.seed) }))
  }
  await writeSecret(groupsFile(config), JSON.stringify(raw, null, 2))
  const current = (await readFile(defaultFile(config), 'utf-8').catch(() => '')).trim()
  if ((state.default ?? '') !== current) await writeDefault(config, state.default)
}

// Sets the default group (by name), or clears it.
export async function writeDefault (config: LoadedConfig, name: string | null): Promise<void> {
  if (name === null) {
    await rm(defaultFile(config), { force: true })
    return
  }
  await mkdir(dirname(defaultFile(config)), { recursive: true })
  await writeFile(defaultFile(config), name + '\n')
}

// The group commands act on: --group, else PAI_GROUP, else the file's
// default. Undefined lets the daemon use its default.
export function chosenGroup (flag: string | undefined, { env }: Env): string | undefined {
  return flag ?? (env.PAI_GROUP || undefined)
}

// The identity `pai daemon` runs, keeping the groups file in step as
// groups are made, joined, or learned from the identity's other devices.
export async function identityFor (config: LoadedConfig): Promise<GroupIdentity> {
  const state = await readGroups(config)
  let last = state.groups
  return new GroupIdentity({
    storage: config.storage,
    keys: state.keys,
    groups: state.groups,
    onGroups: async (groups) => {
      // The default as it is now (`pai group use` may have changed it while
      // the daemon ran); a renamed default stays the default (by slot), and
      // a first group becomes it.
      const named = (await readFile(defaultFile(config), 'utf-8').catch(() => '')).trim()
      const slot = last.find((g) => g.name === named)?.slot
      const renamed = slot === undefined ? undefined : groups.find((g) => g.slot === slot)?.name
      const wanted = renamed ?? (groups.some((g) => g.name === named) ? named : groups[0]?.name ?? null)
      last = groups
      await writeGroups(config, { keys: state.keys, groups, default: wanted })
    }
  })
}

// Reads a pai JSON file of the given kind (`pai: '<kind>'`).
async function readJson<T extends { pai: string }> (file: string, what: string, kind: string, missing: string): Promise<T> {
  let text: string
  try {
    text = await readFile(file, 'utf-8')
  } catch {
    throw new CliError(missing)
  }
  let raw: T
  try {
    raw = JSON.parse(text) as T
  } catch (err) {
    throw new CliError(`${file} is not valid JSON: ${(err as Error).message}`)
  }
  if (raw?.pai !== kind) throw new CliError(`${file} is not a pai ${what} file`)
  return raw
}

function bytes (s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

function b64 (b: Uint8Array): string {
  return Buffer.from(b).toString('base64url')
}

function tokenFile (config: LoadedConfig): string {
  return join(dirname(config.storage), 'daemon-token')
}

// The daemon's gateway token, created on first use next to the storage.
export async function ensureToken (config: LoadedConfig): Promise<{ file: string, value: string }> {
  const file = tokenFile(config)
  try {
    const value = (await readFile(file, 'utf-8')).trim()
    if (value) return { file, value }
  } catch {}
  const value = randomBytes(32).toString('base64url')
  await writeSecret(file, value)
  return { file, value }
}

// Where a running daemon's gateway is: written when it starts, removed when
// it stops.
export interface DaemonAddress { url: string, pid: number }

export function daemonFile (config: LoadedConfig): string {
  return join(dirname(config.storage), 'daemon.json')
}

export async function writeDaemonAddress (config: LoadedConfig, address: DaemonAddress): Promise<void> {
  await writeFile(daemonFile(config), JSON.stringify(address) + '\n', { mode: 0o600 })
}

// Removes the file if it's still this process's.
export async function removeDaemonAddress (config: LoadedConfig, pid: number): Promise<void> {
  const current = await readDaemonAddress(config)
  if (current?.pid === pid) await rm(daemonFile(config), { force: true })
}

export async function readDaemonAddress (config: LoadedConfig): Promise<DaemonAddress | null> {
  try {
    const address = JSON.parse(await readFile(daemonFile(config), 'utf-8')) as Partial<DaemonAddress>
    return typeof address.url === 'string' && typeof address.pid === 'number' ? { url: address.url, pid: address.pid } : null
  } catch {
    return null
  }
}

// The running daemon's gateway and token, for `pai send`, `card` and `task`.
export async function daemonConnection (config: LoadedConfig): Promise<{ url: string, token: string }> {
  const address = await readDaemonAddress(config)
  if (!address || !alive(address.pid)) throw new CliError('No pai daemon is running here. Start one with `pai daemon` (in another terminal), then try again.')
  try {
    const token = (await readFile(tokenFile(config), 'utf-8')).trim()
    if (token) return { url: address.url, token }
  } catch {}
  throw new CliError(`The daemon token is missing (${tokenFile(config)}); restart \`pai daemon\``)
}

function alive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Private (mode 600) and whole: written to a temporary name, then renamed
// into place.
async function writeSecret (file: string, secret: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, secret + '\n', { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

export async function exists (path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

// An error meant for the user: printed without a stack trace.
export class CliError extends Error {
  constructor (message: string, readonly exitCode = 1) {
    super(message)
    this.name = 'CliError'
  }
}
