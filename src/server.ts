import { randomUUID } from 'node:crypto'
import type {
  Artifact,
  CancelTaskRequest,
  GetTaskRequest,
  ListTasksRequest,
  ListTasksResponse,
  Message,
  SendMessageRequest,
  SendMessageResponse,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
  TaskArtifactUpdateEvent,
  TaskState
} from './a2a/types.js'
import { A2A_METHODS, A2A_PROTOCOL_VERSION, SERVICE_PARAMS } from './a2a/types.js'
import { PaiRpcError } from './errors.js'
import { ErrorCodes, serviceParameter } from './protocol/jsonrpc.js'
import type { JsonRpcRequest } from './protocol/jsonrpc.js'
import type { TaskStore } from './store/task-store.js'
import { appendArtifact, appendHistory, createTask, endsStream, isTaskState, isTerminal, transition } from './task/task.js'
import { EventQueue } from './util/queue.js'
import type { TaskAccess } from './identity/types.js'
export type { TaskAccess }

// A context id that names its caller: "<64 hex>:<name>".
const OWNED_CONTEXT = /^([0-9a-f]{64}):/

// Handed to onMessage handlers to drive the task lifecycle.
export interface TaskHandle {
  readonly task: Task
  // Aborted when a client cancels the task.
  readonly signal: AbortSignal
  update (state: TaskState, message?: Message): Promise<void>
  artifact (artifact: Artifact, opts?: { append?: boolean, lastChunk?: boolean }): Promise<void>
}

// Return a Message without touching the task to reply statelessly (no task
// is stored). Otherwise the call resolves with the Task. A handler may keep
// the handle and update the task after returning; streams stay open until
// the task ends or needs input.
export type MessageHandler = (message: Message, task: TaskHandle) => Promise<Message | void>

type TaskEvent = Extract<StreamResponse, { statusUpdate: unknown } | { artifactUpdate: unknown }>
type Listener = (ev: TaskEvent, task: Task) => void

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

class TaskRunner implements TaskHandle {
  touched = false
  // The agent whose message started or continued the task (undefined for
  // local calls).
  owner: string | undefined
  readonly listeners = new Set<Listener>()
  readonly #abort = new AbortController()
  readonly canceled: Promise<void>
  #markCanceled: () => void = noop

  constructor (private current: Task, private readonly store: TaskStore, private readonly onEnd: (runner: TaskRunner) => void) {
    this.canceled = new Promise((resolve) => { this.#markCanceled = resolve })
  }

  get task (): Task {
    return this.current
  }

  get signal (): AbortSignal {
    return this.#abort.signal
  }

  async update (state: TaskState, message?: Message): Promise<void> {
    const msg = message && this.#own(message)
    this.current = transition(this.current, state, msg)
    if (msg) this.current = appendHistory(this.current, msg)
    await this.save()
    const { id: taskId, contextId, status } = this.current
    this.#emit({ statusUpdate: { taskId, contextId, status } })
  }

  async artifact (artifact: Artifact, opts: { append?: boolean, lastChunk?: boolean } = {}): Promise<void> {
    this.current = appendArtifact(this.current, artifact, opts.append)
    await this.save()
    const ev: TaskArtifactUpdateEvent = { taskId: this.current.id, contextId: this.current.contextId, artifact }
    if (opts.append !== undefined) ev.append = opts.append
    if (opts.lastChunk !== undefined) ev.lastChunk = opts.lastChunk
    this.#emit({ artifactUpdate: ev })
  }

  // Completes the task with the handler's reply, passing through working
  // when the handler never moved the task there itself.
  async finish (reply: Message): Promise<void> {
    if (isTerminal(this.current.status.state)) {
      this.current = appendHistory(this.current, this.#own(reply))
      await this.save()
      return
    }
    if (this.current.status.state !== 'TASK_STATE_WORKING') this.current = transition(this.current, 'TASK_STATE_WORKING')
    await this.update('TASK_STATE_COMPLETED', reply)
  }

  async cancel (): Promise<void> {
    this.#abort.abort()
    try {
      await this.update('TASK_STATE_CANCELED')
    } finally {
      this.#markCanceled()
    }
  }

  async save (): Promise<void> {
    this.touched = true
    await this.store.putTask(this.current)
  }

  #own (message: Message): Message {
    return { ...message, taskId: this.current.id, contextId: this.current.contextId }
  }

  #emit (ev: TaskEvent): void {
    for (const listener of this.listeners) listener(ev, this.current)
    if ('statusUpdate' in ev && endsStream(ev.statusUpdate.status.state)) this.onEnd(this)
  }
}

// Who sent a request: the hex agent id, already authenticated.

export interface DispatchContext {
  peer: string
}

interface Prepared {
  runner: TaskRunner
  message: Message
  resumed: boolean
}

export class Server {
  // Tasks with a live runner: still being worked on, or awaiting their
  // handler's next update. Removed once a task ends or needs input.
  #active = new Map<string, TaskRunner>()
  // Messages being claimed right now, by caller and messageId (see #claim).
  #claims = new Map<string, Promise<void>>()

  // `taskIdPrefix` starts every new task id (an agent with several devices
  // puts its device's there, so follow-ups find the device). `access`, for
  // tasks shared in groups: the members of a task's group read it
  // (ListTasks lists what the caller may read), and its creator or an
  // admin of the group continues and cancels it.
  constructor (private readonly store: TaskStore, private readonly handler: () => MessageHandler | null, private readonly taskIdPrefix = '', private readonly access: (() => TaskAccess | null) = () => null) {}

  dispatch (req: JsonRpcRequest, ctx?: DispatchContext): Promise<unknown> | AsyncIterable<unknown> {
    // An empty version means 0.3, which this agent doesn't speak.
    const version = serviceParameter(req, SERVICE_PARAMS.version) ?? ''
    if (majorMinor(version) !== A2A_PROTOCOL_VERSION) {
      return Promise.reject(PaiRpcError.versionNotSupported(version || '0.3', A2A_PROTOCOL_VERSION))
    }
    const peer = ctx?.peer
    switch (req.method) {
      case A2A_METHODS.sendMessage:
        return this.#sendMessage(req.params as SendMessageRequest, peer)
      case A2A_METHODS.sendStreamingMessage:
        return this.#sendStreamingMessage(req.params as SendMessageRequest, peer)
      case A2A_METHODS.getTask:
        return this.#getTask(req.params as GetTaskRequest, peer)
      case A2A_METHODS.listTasks:
        return this.#listTasks((req.params ?? {}) as ListTasksRequest, peer)
      case A2A_METHODS.cancelTask:
        return this.#cancelTask(req.params as CancelTaskRequest, peer)
      case A2A_METHODS.subscribeToTask:
        return this.#subscribeToTask(req.params as SubscribeToTaskRequest, peer)
      case A2A_METHODS.createTaskPushNotificationConfig:
      case A2A_METHODS.getTaskPushNotificationConfig:
      case A2A_METHODS.listTaskPushNotificationConfigs:
      case A2A_METHODS.deleteTaskPushNotificationConfig:
        return Promise.reject(PaiRpcError.pushNotSupported())
      case A2A_METHODS.getExtendedAgentCard:
        return Promise.reject(PaiRpcError.extendedCardNotConfigured())
      default:
        return Promise.reject(new PaiRpcError(ErrorCodes.MethodNotFound, `Method not found: ${req.method}`))
    }
  }

  // Tasks left submitted or working by a previous run have no handler
  // driving them any more, so they are marked failed.
  async recover (): Promise<void> {
    const orphans: Task[] = []
    for await (const task of this.store.tasks()) {
      const state = task.status.state
      if (state === 'TASK_STATE_SUBMITTED' || state === 'TASK_STATE_WORKING') orphans.push(task)
    }
    for (const task of orphans) {
      await this.store.putTask(transition(task, 'TASK_STATE_FAILED', agentText('Agent restarted before the task finished')))
    }
  }

  async #sendMessage (params: SendMessageRequest, peer?: string): Promise<SendMessageResponse> {
    const historyLength = params.configuration?.historyLength
    const claimed = await this.#claim(params, peer)
    if ('duplicate' in claimed) return { task: withHistory(claimed.duplicate, historyLength) }
    const { runner, message, resumed } = claimed

    if (params.configuration?.returnImmediately === true) {
      await runner.save()
      void this.#run(runner, message, false)
      return { task: withHistory(runner.task, historyLength) }
    }

    const stateless = await Promise.race([this.#run(runner, message, !resumed), runner.canceled.then(() => null)])
    return stateless ? { message: stateless } : { task: withHistory(runner.task, historyLength) }
  }

  async * #sendStreamingMessage (params: SendMessageRequest, peer?: string): AsyncGenerator<StreamResponse> {
    const claimed = await this.#claim(params, peer)
    if ('duplicate' in claimed) {
      const duplicate = claimed.duplicate
      if (this.#active.has(duplicate.id)) yield * this.#subscribeToTask({ id: duplicate.id })
      else yield { task: duplicate }
      return
    }
    const { runner, message, resumed } = claimed
    const queue = new EventQueue<StreamResponse>()
    // The first item of a task stream is the Task itself.
    let sentTask = false
    const sendTask = (): void => {
      if (sentTask) return
      sentTask = true
      queue.push({ task: runner.task })
      if (endsStream(runner.task.status.state)) queue.end()
    }

    const listener: Listener = (ev) => {
      if (!sentTask) sendTask()
      else queue.push(ev)
      if ('statusUpdate' in ev && endsStream(ev.statusUpdate.status.state)) queue.end()
    }
    runner.listeners.add(listener)
    if (resumed) sendTask()

    void this.#run(runner, message, !resumed).then(async (reply) => {
      if (reply) {
        queue.push({ message: reply })
        queue.end()
      } else if (!runner.touched) {
        await runner.save()
        sendTask()
      }
    })

    try {
      yield * queue
    } finally {
      runner.listeners.delete(listener)
    }
  }

  async #getTask (params: GetTaskRequest, peer?: string): Promise<Task> {
    const task = await this.#load(params)
    await this.#checkRead(task, peer)
    return withHistory(task, params.historyLength)
  }

  // Only the caller's own tasks (or, shared in groups, those of the groups
  // it's in), most recently updated first. The page token is the position
  // (status timestamp and id) of the last task returned.
  async #listTasks (params: ListTasksRequest, peer?: string): Promise<ListTasksResponse> {
    const access = this.access()
    if (peer === undefined) return await listPage(this.store.tasks(), params)
    if (!access) return await listPage(this.store.tasksOwnedBy(peer), params)
    if (!access.canRead(peer)) throw PaiRpcError.taskNotFound('*')
    const store = this.store
    async function * readable (): AsyncGenerator<Task> {
      for await (const task of store.tasks()) {
        if (access!.canRead(peer!, task) || await store.getOwner(task.id) === peer) yield task
      }
    }
    return await listPage(readable(), params)
  }

  // With groups, a task is readable by its creator and by the members of
  // the group it's shared in, and nobody else (one with no recorded
  // owner, made by a local call, too). Local calls, and agents that share
  // nothing, pass.
  async #checkRead (task: Task, peer?: string): Promise<void> {
    const access = this.access()
    if (peer === undefined || !access) return
    if (access.canRead(peer, task) || await this.store.getOwner(task.id) === peer) return
    throw PaiRpcError.taskNotFound(task.id)
  }

  async #cancelTask (params: CancelTaskRequest, peer?: string): Promise<Task> {
    if (typeof params?.id !== 'string') throw PaiRpcError.invalidParams('id must be a string', 'id')
    await this.#checkOwner(params.id, peer)
    const runner = this.#active.get(params.id)
    if (runner) {
      await runner.cancel()
      return runner.task
    }
    const task = await this.#load(params)
    if (isTerminal(task.status.state)) throw PaiRpcError.taskNotCancelable(task.id, task.status.state)
    const canceled = transition(task, 'TASK_STATE_CANCELED')
    await this.store.putTask(canceled)
    return canceled
  }

  // The current Task, then live events until the task ends or needs input.
  // A task that has already ended can't be subscribed to.
  async * #subscribeToTask (params: SubscribeToTaskRequest, peer?: string): AsyncGenerator<StreamResponse> {
    const runner = this.#active.get(params?.id)
    if (peer !== undefined) await this.#checkRead(runner?.task ?? await this.#load(params), peer)
    if (!runner) {
      // Not active means it has ended or is waiting for input (see recover).
      const task = await this.#load(params)
      if (isTerminal(task.status.state)) throw PaiRpcError.unsupported(`task ${task.id} is ${task.status.state}`)
      yield { task }
      return
    }
    const queue = new EventQueue<StreamResponse>()
    const listener: Listener = (ev) => {
      queue.push(ev)
      if ('statusUpdate' in ev && endsStream(ev.statusUpdate.status.state)) queue.end()
    }
    runner.listeners.add(listener)
    queue.push({ task: runner.task })
    try {
      yield * queue
    } finally {
      runner.listeners.delete(listener)
    }
  }

  async #prepare (params: SendMessageRequest, peer?: string): Promise<Prepared> {
    const message = params?.message
    const invalid = messageProblem(message)
    if (invalid) throw PaiRpcError.invalidParams(invalid.description, invalid.field)
    if (!this.handler()) throw PaiRpcError.unsupported('agent has no message handler')

    let task: Task
    let resumed = false
    if (message.taskId) {
      // Before anything else, so other agents can't even tell the task exists.
      await this.#checkOwner(message.taskId, peer)
      if (this.#active.has(message.taskId)) throw PaiRpcError.unsupported(`task ${message.taskId} is still running`)
      const existing = await this.store.getTask(message.taskId)
      if (!existing) throw PaiRpcError.taskNotFound(message.taskId)
      // The spec: infer the context from the task, but reject one that
      // contradicts it. proto3: an empty string is the same as unset.
      if (message.contextId && message.contextId !== existing.contextId) {
        throw PaiRpcError.invalidParams(`contextId ${message.contextId} is not task ${existing.id}'s context`, 'message.contextId')
      }
      if (isTerminal(existing.status.state)) {
        throw PaiRpcError.unsupported(`task ${existing.id} is ${existing.status.state} and cannot be resumed`)
      }
      task = appendHistory(existing, { ...message, contextId: existing.contextId })
      resumed = true
    } else {
      const id = `${this.taskIdPrefix}${randomUUID()}`
      // proto3: an empty string is the same as unset. A context named for
      // a caller ("<its id>:<name>", as a group's jobs use) is that
      // caller's alone.
      const contextId = message.contextId || randomUUID()
      const named = OWNED_CONTEXT.exec(contextId)
      if (named && peer !== undefined && named[1] !== peer) throw PaiRpcError.invalidParams(`context ${contextId} belongs to another caller`, 'message.contextId')
      task = createTask(id, contextId, { ...message, taskId: id, contextId })
      // Which group (if any) the task is shared in, for good.
      const group = this.access()?.placement?.(peer, message) ?? null
      if (group !== null) task = { ...task, metadata: { ...(task.metadata ?? {}), 'pai/group': group } }
      if (peer !== undefined) await this.store.putOwner(id, peer)
    }

    const runner = new TaskRunner(task, this.store, (r) => {
      if (this.#active.get(r.task.id) === r) this.#active.delete(r.task.id)
    })
    runner.owner = peer
    this.#active.set(task.id, runner)
    if (resumed) await runner.save()
    await this.store.putMessageTask(peer ?? '', message.messageId, task.id)
    return { runner, message: task.history?.at(-1) ?? message, resumed }
  }

  // The task a message starts or continues, or the one it already went to if
  // it's a retry. Copies of one message arriving together are taken in turn,
  // so only the first runs.
  async #claim (params: SendMessageRequest, peer?: string): Promise<Prepared | { duplicate: Task }> {
    const id = params?.message?.messageId
    const key = typeof id === 'string' ? `${peer ?? ''}\n${id}` : null
    const before = key === null ? undefined : this.#claims.get(key)
    let release: () => void = noop
    const mine = new Promise<void>((resolve) => { release = resolve })
    if (key !== null) this.#claims.set(key, mine)
    try {
      await before
      const duplicate = await this.#duplicate(params, peer)
      if (duplicate) return { duplicate }
      return await this.#prepare(params, peer)
    } finally {
      release()
      if (key !== null && this.#claims.get(key) === mine) this.#claims.delete(key)
    }
  }

  // A message this caller already sent, by messageId (a retry, say): the task
  // it went to, which the retry gets instead of running again.
  async #duplicate (params: SendMessageRequest, peer?: string): Promise<Task | null> {
    const message = params?.message
    if (messageProblem(message)) return null
    const taskId = await this.store.getMessageTask(peer ?? '', message.messageId)
    if (taskId === null || (message.taskId && message.taskId !== taskId)) return null
    return this.#active.get(taskId)?.task ?? await this.store.getTask(taskId)
  }

  // Runs the handler and settles the task from its outcome. Returns the
  // reply when it is a stateless Message (no task kept). Never rejects.
  async #run (runner: TaskRunner, message: Message, allowStateless: boolean): Promise<Message | null> {
    const handler = this.handler()
    try {
      const reply = handler ? await handler(message, runner) : undefined
      if (!reply) return null
      if (!runner.touched && allowStateless) {
        this.#active.delete(runner.task.id)
        // No task is kept, so neither is its owner, and a retry runs again.
        await this.store.delOwner(runner.task.id).catch(noop)
        await this.store.delMessageTask(runner.owner ?? '', message.messageId).catch(noop)
        return { ...reply, contextId: runner.task.contextId }
      }
      await runner.finish(reply)
    } catch (err) {
      if (!isTerminal(runner.task.status.state)) {
        await runner.update('TASK_STATE_FAILED', agentText(err instanceof Error ? err.message : String(err))).catch(noop)
      }
    }
    return null
  }

  // Only the agent that created a task may cancel or continue it. Anyone
  // else gets TaskNotFound, the same answer as for an id that doesn't exist.
  // Reads (GetTask, SubscribeToTask) follow #checkRead. Local calls (no
  // peer) pass, and, for agents that share nothing, tasks with no recorded
  // owner.
  async #checkOwner (taskId: string, peer?: string): Promise<void> {
    if (peer === undefined) return
    const owner = await this.store.getOwner(taskId)
    if (owner === peer) return
    const access = this.access()
    if (!access) {
      if (owner === null) return
      throw PaiRpcError.taskNotFound(taskId)
    }
    // A task shared in a group: readable by its members (see GetTask), but
    // only its creator or an admin of the group may act on it.
    const task = await this.store.getTask(taskId)
    if (access.canRead(peer, task)) {
      if (access.canControl(owner, peer, task)) return
      throw PaiRpcError.a2a(ErrorCodes.InvalidRequest, 'NOT_TASK_OWNER', `Only the agent that created task ${taskId}, or a group admin, can continue or cancel it`)
    }
    throw PaiRpcError.taskNotFound(taskId)
  }

  async #load (params: { id?: unknown } | undefined): Promise<Task> {
    if (typeof params?.id !== 'string') throw PaiRpcError.invalidParams('id must be a string', 'id')
    const task = await this.store.getTask(params.id)
    if (!task) throw PaiRpcError.taskNotFound(params.id)
    return task
  }
}

// historyLength 0 omits the history; a positive one keeps the latest.
export function withHistory (task: Task, historyLength?: number): Task {
  if (historyLength === undefined || !task.history) return task
  if (historyLength <= 0) {
    const { history: _history, ...rest } = task
    return rest
  }
  return { ...task, history: task.history.slice(-historyLength) }
}

// Why a request's message isn't a valid A2A Message, or null.
function messageProblem (m: unknown): { field: string, description: string } | null {
  if (typeof m !== 'object' || m === null) return { field: 'message', description: 'message must be an A2A Message' }
  const msg = m as Partial<Message>
  if (typeof msg.messageId !== 'string' || msg.messageId === '') return { field: 'message.messageId', description: 'messageId is required' }
  if (msg.role !== 'ROLE_USER' && msg.role !== 'ROLE_AGENT') return { field: 'message.role', description: 'role must be ROLE_USER or ROLE_AGENT' }
  if (!Array.isArray(msg.parts) || msg.parts.length === 0) return { field: 'message.parts', description: 'At least one part is required' }
  const bad = msg.parts.findIndex((p) => !isPart(p))
  if (bad >= 0) return { field: `message.parts[${bad}]`, description: 'A part needs exactly one of text, raw, url or data' }
  return null
}

function isPart (p: unknown): boolean {
  if (typeof p !== 'object' || p === null) return false
  const content = ['text', 'raw', 'url', 'data'].filter((k) => k in p)
  if (content.length !== 1) return false
  const key = content[0] as 'text' | 'raw' | 'url' | 'data'
  return key === 'data' || typeof (p as Record<string, unknown>)[key] === 'string'
}

function majorMinor (version: string): string {
  return version.split('.').slice(0, 2).join('.')
}

export function updatedAt (task: Task): number {
  return task.status.timestamp ? Date.parse(task.status.timestamp) : 0
}

// One ListTasks page over `source`, most recently updated first. The page
// token is the position (status timestamp and id) of the last task
// returned, so it orders tasks from any number of sources.
export async function listPage (source: AsyncIterable<Task>, params: ListTasksRequest): Promise<ListTasksResponse> {
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw PaiRpcError.invalidParams(`pageSize must be between 1 and ${MAX_PAGE_SIZE}`, 'pageSize')
  }
  if (params.status !== undefined && !isTaskState(params.status)) throw PaiRpcError.invalidParams('status must be a TaskState', 'status')
  const after = params.statusTimestampAfter === undefined ? null : Date.parse(params.statusTimestampAfter)
  if (after !== null && Number.isNaN(after)) throw PaiRpcError.invalidParams('statusTimestampAfter must be an ISO 8601 timestamp', 'statusTimestampAfter')
  const cursor = params.pageToken ? decodeCursor(params.pageToken) : null

  // A task may come from several sources (devices, a group's copy): the
  // newest copy counts, before any filter or the cursor looks at it.
  const newest = new Map<string, Task>()
  for await (const task of source) {
    const prev = newest.get(task.id)
    if (!prev || updatedAt(task) > updatedAt(prev)) newest.set(task.id, task)
  }
  const matching: Task[] = []
  for (const task of newest.values()) {
    if (params.contextId !== undefined && task.contextId !== params.contextId) continue
    if (params.status !== undefined && task.status.state !== params.status) continue
    if (after !== null && updatedAt(task) <= after) continue
    matching.push(task)
  }
  matching.sort(newestFirst)

  const start = cursor ? matching.findIndex((t) => newestFirst(t, cursor) > 0) : 0
  const page = start < 0 ? [] : matching.slice(start, start + pageSize)
  const last = page.at(-1)
  const more = last !== undefined && start + pageSize < matching.length
  return {
    tasks: page.map((t) => {
      const listed = withHistory(t, params.historyLength)
      if (params.includeArtifacts === true) return listed
      const { artifacts: _artifacts, ...rest } = listed
      return rest
    }),
    nextPageToken: more ? encodeCursor(last) : '',
    pageSize,
    totalSize: matching.length
  }
}

interface Cursor { t: number, id: string }

// Newest first; ties broken by id, so the order is total and stable (also
// across an identity's devices, whose task ids differ).
export function newestFirst (a: Task | Cursor, b: Task | Cursor): number {
  const ta = 'status' in a ? updatedAt(a) : a.t
  const tb = 'status' in b ? updatedAt(b) : b.t
  if (ta !== tb) return tb - ta
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function encodeCursor (task: Task): string {
  return Buffer.from(JSON.stringify({ t: updatedAt(task), id: task.id })).toString('base64url')
}

function decodeCursor (token: string): Cursor {
  try {
    const cursor = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8')) as Cursor
    if (typeof cursor.t === 'number' && typeof cursor.id === 'string') return cursor
  } catch {}
  throw PaiRpcError.invalidParams('pageToken is not valid', 'pageToken')
}

function agentText (text: string): Message {
  return { role: 'ROLE_AGENT', messageId: randomUUID(), parts: [{ text }] }
}

function noop (): void {}
