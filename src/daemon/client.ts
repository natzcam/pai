import type {
  AgentCard,
  ListTasksRequest,
  ListTasksResponse,
  Message,
  SendMessageConfiguration,
  SendMessageRequest,
  SendMessageResponse,
  StreamResponse,
  Task
} from '../a2a/types.js'
import { A2A_METHODS, A2A_PROTOCOL_VERSION, SERVICE_PARAMS } from '../a2a/types.js'
import type { Post } from '../mailbox/store.js'
import type { Roster } from '../group/state.js'
import type { DeviceRecord } from '../devices/state.js'
import { isJobId } from '../group/jobs.js'
import type { JobLimits, JobRecord, JobSpec, JobState } from '../group/jobs.js'
import type { FlowSpec, FlowSummary, FlowView, Schedule, ScheduleRecord } from '../group/flows.js'
import type { GroupAction } from './gateway.js'
import type { Inbox } from '../group/membership.js'

import { PaiCardError, PaiConnectionError } from '../errors.js'
import { isEventStream, readJson, sseEvents, streamed, unary } from './http.js'

// Calls other agents through a running daemon's gateway, as the daemon's
// agent: the same calls as Peer, without opening a second identity. This
// is what `pai send`, `pai card` and `pai task` use.

export interface DaemonClientOptions {
  // The gateway, e.g. http://127.0.0.1:7777
  url: string
  // The daemon token (.pai/daemon-token).
  token: string
  // The group (name or id) group calls act on, and new messages' tasks are
  // shared in; default the daemon's default group.
  group?: string
  fetch?: typeof fetch
}

// The groups the daemon's identity is in.
export interface GroupsState {
  // The default group's name (null: in none).
  default: string | null
  groups: Array<{ id: string, name: string, title: string | null, admin: boolean, members: number, writable: boolean, problem: string | null }>
}

// What's waiting on the agent: each item names its group.
export type InboxState = { [K in keyof Inbox]: Array<Inbox[K][number] & { group: string }> } & { inputs: Record<string, string> }

export interface GroupState {
  // The group these are about.
  group: { id: string, name: string }
  // The identity the daemon's device acts for, hex: its id in the roster.
  id: string
  admin: boolean
  // Whether its writer is in the group yet (false while syncing).
  writable: boolean
  // The group's rules version, and the newest this daemon's pai applies.
  rules: { group: number, supported: number }
  // Why the group stopped applying here (it needs a newer pai), or null.
  problem: string | null
  roster: Roster
}

export interface DeviceState {
  identity: string
  // The daemon's own device, hex.
  device: string | null
  devices: DeviceRecord[]
}

export interface DaemonInfo {
  // The daemon's agent id, hex: in a group, its identity.
  id: string
  // The daemon's device (its Noise key), hex.
  device: string
  card: AgentCard
}

export interface RemoteWatchOptions {
  signal?: AbortSignal
  onInvalid?: (err: PaiCardError) => void
}

const GROUP_ROUTE = /^\/(pai\/(group|jobs|flows|schedules)|agents\/)/

export class DaemonClient {
  readonly url: string
  // The group group calls act on (see DaemonClientOptions.group).
  readonly groupRef: string | undefined
  readonly #token: string
  readonly #fetch: typeof fetch

  constructor (opts: DaemonClientOptions) {
    this.url = opts.url.replace(/\/+$/, '')
    this.#token = opts.token
    this.#fetch = opts.fetch ?? fetch
    this.groupRef = opts.group
  }

  // The groups the daemon's identity is in, and its default.
  async groups (): Promise<GroupsState> {
    return await this.json(await this.get('/pai/groups')) as GroupsState
  }

  // Starts a group (`name` for it here; `title`, its own), or joins one with
  // an admin's invite, through the running daemon.
  async groupsAction (action: { action: 'create', name: string, title?: string } | { action: 'join', code: string, as?: string }, signal?: AbortSignal): Promise<GroupsState & { created?: string, joined?: string }> {
    const body = await this.json(await this.#call('/pai/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
      ...(signal ? { signal } : {})
    })) as GroupsState & { error?: string }
    // A join answers 200 at once (it can wait long): its failure is in the body.
    if (typeof body.error === 'string') throw new PaiConnectionError(body.error)
    return body
  }

  // The daemon's own agent.
  async info (): Promise<DaemonInfo> {
    return await this.json(await this.get('/')) as DaemonInfo
  }

  // A durable post through the daemon (see Pai.post).
  async post (to: string, message: Message): Promise<Post> {
    return await this.json(await this.#call('/pai/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: to.toLowerCase(), message })
    })) as Post
  }

  // The daemon's posts, oldest first.
  async posts (): Promise<Post[]> {
    return (await this.json(await this.get('/pai/outbox')) as { posts: Post[] }).posts
  }

  // The daemon's group: its roster, and whether this agent is an admin.
  async group (): Promise<GroupState> {
    return await this.json(await this.get('/pai/group')) as GroupState
  }

  // This identity's devices.
  async devices (): Promise<DeviceState> {
    return await this.json(await this.get('/pai/device')) as DeviceState
  }

  async deviceAction (action: { action: 'invite', hours?: number } | { action: 'remove', device: string }): Promise<DeviceState & { code?: string, expires?: number }> {
    return await this.json(await this.#call('/pai/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action)
    })) as DeviceState
  }

  // An admin action on the group, as the daemon's agent.
  async groupAction (action: GroupAction): Promise<GroupState & { code?: string, expires?: number, pid?: string }> {
    return await this.json(await this.#call('/pai/group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action)
    })) as GroupState
  }

  // The group's job board, newest first; `state` narrows it.
  async jobs (state?: JobState, signal?: AbortSignal): Promise<JobRecord[]> {
    return (await this.json(await this.get(`/pai/jobs${state ? `?state=${state}` : ''}`, signal ? { signal } : {})) as { jobs: JobRecord[] }).jobs
  }

  // One job. With `wait` (ms), held until it ends or that long has passed.
  // With `asked` (questionKey of the question already seen), a wait also
  // ends when a new question comes.
  async job (id: string, wait?: number, signal?: AbortSignal, asked?: string): Promise<JobRecord> {
    if (!isJobId(id)) throw new Error(`${id} is not a job id (32 hex characters)`)
    const query = wait ? `?wait=${Math.floor(wait)}&asked=${encodeURIComponent(asked ?? '')}` : ''
    return (await this.json(await this.get(`/pai/jobs/${id}${query}`, signal ? { signal } : {})) as { job: JobRecord }).job
  }

  // Posts a job (for `to`: 'role:<role>' or an agent id; default anyone).
  async postJob (spec: JobSpec, opts: { to?: string, lease?: number } & JobLimits = {}): Promise<JobRecord> {
    return await this.#jobAction({ action: 'post', spec, ...opts })
  }

  async cancelJob (id: string): Promise<JobRecord> {
    return await this.#jobAction({ action: 'cancel', id })
  }

  // Takes a job to do by hand; `mine`: whether the claim held.
  // `input`: what it runs as (its text, attached results and all), once mine.
  async takeJob (id: string, signal?: AbortSignal): Promise<{ job: JobRecord, mine: boolean, input?: string }> {
    return await this.json(await this.#call('/pai/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'take', id }),
      ...(signal ? { signal } : {})
    })) as { job: JobRecord, mine: boolean, input?: string }
  }

  async releaseJob (id: string): Promise<JobRecord> {
    return await this.#jobAction({ action: 'release', id })
  }

  // Reports a job taken by hand as done or failed, with `text` as result.
  async finishJob (id: string, state: 'done' | 'failed', text: string | null): Promise<JobRecord> {
    return await this.#jobAction({ action: 'finish', id, state, text })
  }

  // Answers the question a job asked.
  async answerJob (id: string, text: string): Promise<JobRecord> {
    return await this.#jobAction({ action: 'answer', id, text })
  }

  // What's waiting on this agent in every group, or in `group` alone.
  async inbox (opts: { group?: string } = {}): Promise<InboxState> {
    return await this.json(await this.get(`/pai/inbox${opts.group ? `?group=${encodeURIComponent(opts.group)}` : ''}`)) as InboxState
  }

  async #jobAction (action: unknown): Promise<JobRecord> {
    return (await this.json(await this.#call('/pai/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action)
    })) as { job: JobRecord }).job
  }

  // Workflows, newest first.
  async flows (): Promise<FlowSummary[]> {
    return (await this.json(await this.get('/pai/flows')) as { flows: FlowSummary[] }).flows
  }

  // One workflow. With `wait` (ms), held until it ends or that long has passed.
  async flow (id: string, wait?: number, signal?: AbortSignal): Promise<FlowView> {
    if (!isJobId(id)) throw new Error(`${id} is not a workflow id (32 hex characters)`)
    return (await this.json(await this.get(`/pai/flows/${id}${wait ? `?wait=${Math.floor(wait)}` : ''}`, signal ? { signal } : {})) as { flow: FlowView }).flow
  }

  // With `key`, a repeat start returns the run the key started.
  async startFlow (spec: FlowSpec, input: string, opts: { key?: string } = {}): Promise<FlowView> {
    return await this.#flowAction({ action: 'start', spec, input, ...(opts.key !== undefined ? { key: opts.key } : {}) })
  }

  async cancelFlow (id: string): Promise<FlowView> {
    return await this.#flowAction({ action: 'cancel', id })
  }

  // The group's schedules; setting and dropping one.
  async schedules (): Promise<ScheduleRecord[]> {
    return (await this.json(await this.get('/pai/schedules')) as { schedules: ScheduleRecord[] }).schedules
  }

  async setSchedule (schedule: Schedule): Promise<ScheduleRecord> {
    return (await this.json(await this.#call('/pai/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', schedule })
    })) as { schedule: ScheduleRecord }).schedule
  }

  async dropSchedule (name: string): Promise<void> {
    await this.json(await this.#call('/pai/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'drop', name })
    }))
  }

  async #flowAction (action: unknown): Promise<FlowView> {
    return (await this.json(await this.#call('/pai/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action)
    })) as { flow: FlowView }).flow
  }

  // Another agent, by hex id.
  agent (id: string): RemoteAgent {
    if (!/^[0-9a-f]{64}$/i.test(id)) throw new Error(`${id} is not an agent id (64 hex characters)`)
    return new RemoteAgent(this, id.toLowerCase())
  }

  // Low level: an authenticated request to the gateway.
  async get (path: string, init: RequestInit = {}): Promise<Response> {
    return await this.#call(path, { ...init, method: 'GET' })
  }

  async rpc (agent: string, method: string, params: unknown): Promise<unknown> {
    return await unary(await this.#post(agent, method, params, 'application/json'), daemonFailure)
  }

  async * rpcStream (agent: string, method: string, params: unknown): AsyncGenerator<unknown> {
    yield * streamed(await this.#post(agent, method, params, 'text/event-stream, application/json'), daemonFailure)
  }

  async #post (agent: string, method: string, params: unknown, accept: string): Promise<Response> {
    return await this.#call(`/agents/${agent}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: accept, [SERVICE_PARAMS.version]: A2A_PROTOCOL_VERSION },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
  }

  async #call (path: string, init: RequestInit): Promise<Response> {
    const headers = { ...init.headers as Record<string, string>, Authorization: `Bearer ${this.#token}` }
    let res: Response
    try {
      res = await this.#fetch(`${this.url}${this.#inGroup(path)}`, { ...init, headers })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message
      throw new PaiConnectionError(`No pai daemon at ${this.url} (${cause})`)
    }
    if (res.status === 401) throw new PaiConnectionError(`The daemon at ${this.url} refused the token`)
    return res
  }

  // Group routes, and calls to agents, name this client's group.
  #inGroup (path: string): string {
    if (this.groupRef === undefined || !GROUP_ROUTE.test(path) || /[?&]group=/.test(path)) return path
    return `${path}${path.includes('?') ? '&' : '?'}group=${encodeURIComponent(this.groupRef)}`
  }

  // Low level: a plain JSON (not JSON-RPC) gateway response; errors become
  // exceptions.
  async json (res: Response): Promise<unknown> {
    const body = await readJson(res, daemonFailure) as { error?: string, errors?: string[] }
    if (res.ok) return body
    if (body.errors) throw new PaiCardError(body.errors, null)
    throw new PaiConnectionError(body.error ?? `HTTP ${res.status}`)
  }
}

export class RemoteAgent {
  constructor (readonly daemon: DaemonClient, readonly id: string) {}

  // The card as the agent publishes it, or null if it has none yet.
  async card (): Promise<AgentCard | null> {
    const res = await this.daemon.get(`/agents/${this.id}/pai/card`)
    if (res.status === 404) return null
    return await this.daemon.json(res) as AgentCard
  }

  // Each valid card as it changes, until `signal` aborts.
  async * watchCard (opts: RemoteWatchOptions = {}): AsyncGenerator<AgentCard> {
    let res: Response
    try {
      res = await this.daemon.get(`/agents/${this.id}/pai/card?watch`, opts.signal ? { signal: opts.signal } : {})
    } catch (err) {
      if (opts.signal?.aborted) return
      throw err
    }
    if (!isEventStream(res)) {
      await this.daemon.json(res)
      return
    }
    try {
      for await (const event of sseEvents(res.body!)) {
        const data = JSON.parse(event.data) as unknown
        if (event.event === 'invalid') opts.onInvalid?.(new PaiCardError((data as { errors: string[] }).errors, null))
        else if (event.event === 'error') throw new PaiConnectionError((data as { error: string }).error)
        else yield data as AgentCard
      }
    } catch (err) {
      if (!opts.signal?.aborted) throw err
    }
  }

  async send (message: Message, configuration?: SendMessageConfiguration): Promise<SendMessageResponse> {
    return await this.daemon.rpc(this.id, A2A_METHODS.sendMessage, sendParams(message, configuration)) as SendMessageResponse
  }

  stream (message: Message, configuration?: SendMessageConfiguration): AsyncGenerator<StreamResponse> {
    return this.daemon.rpcStream(this.id, A2A_METHODS.sendStreamingMessage, sendParams(message, configuration)) as AsyncGenerator<StreamResponse>
  }

  async getTask (id: string, historyLength?: number): Promise<Task> {
    return await this.daemon.rpc(this.id, A2A_METHODS.getTask, historyLength === undefined ? { id } : { id, historyLength }) as Task
  }

  async listTasks (params: ListTasksRequest = {}): Promise<ListTasksResponse> {
    return await this.daemon.rpc(this.id, A2A_METHODS.listTasks, params) as ListTasksResponse
  }

  async cancelTask (id: string): Promise<Task> {
    return await this.daemon.rpc(this.id, A2A_METHODS.cancelTask, { id }) as Task
  }

  subscribe (id: string): AsyncGenerator<StreamResponse> {
    return this.daemon.rpcStream(this.id, A2A_METHODS.subscribeToTask, { id }) as AsyncGenerator<StreamResponse>
  }
}

function sendParams (message: Message, configuration?: SendMessageConfiguration): SendMessageRequest {
  const params: SendMessageRequest = { message }
  if (configuration) params.configuration = configuration
  return params
}

function daemonFailure (message: string): PaiConnectionError {
  return new PaiConnectionError(`Unexpected response from the daemon: ${message}`)
}
