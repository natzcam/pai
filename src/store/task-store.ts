import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Task } from '../a2a/types.js'
import { atomicWrite, checkId, isId, list, readJson } from '../util/files.js'

// The agent's tasks, as files in its storage folder. Local only: nothing here
// is replicated or served to peers except through the A2A methods.
//   tasks/<taskId>.json              persisted Task snapshots
//   owners/<taskId>                  hex id of the agent that created the task
//   by-owner/<agentId>/<taskId>      the same, indexed by agent (for ListTasks)
//   messages/<hash>                  the task a caller's messageId went to, so a
//                                    retried message gets the same task
// Files are written to a temporary name and renamed into place, so a crash
// never leaves half a task.
export class TaskStore {
  readonly #tasks: string
  readonly #owners: string
  readonly #byOwner: string
  readonly #messages: string

  constructor (readonly dir: string) {
    this.#tasks = join(dir, 'tasks')
    this.#owners = join(dir, 'owners')
    this.#byOwner = join(dir, 'by-owner')
    this.#messages = join(dir, 'messages')
  }

  async ready (): Promise<void> {
    for (const d of [this.#tasks, this.#owners, this.#byOwner, this.#messages]) await mkdir(d, { recursive: true })
  }

  // `caller` is the sender's agent id (or '' for local calls); message ids
  // are only unique per sender.
  async getMessageTask (caller: string, messageId: string): Promise<string | null> {
    try {
      return (await readFile(this.#messageFile(caller, messageId), 'utf-8')).trim() || null
    } catch {
      return null
    }
  }

  async putMessageTask (caller: string, messageId: string, taskId: string): Promise<void> {
    await atomicWrite(this.#messageFile(caller, messageId), checkId(taskId))
  }

  async delMessageTask (caller: string, messageId: string): Promise<void> {
    await rm(this.#messageFile(caller, messageId), { force: true })
  }

  #messageFile (caller: string, messageId: string): string {
    return join(this.#messages, createHash('sha256').update(`${caller}\n${messageId}`).digest('hex'))
  }

  // Ids come from peers, so anything that isn't a plain id is just not found,
  // and can never name a path outside the store.
  async getTask (id: string): Promise<Task | null> {
    if (!isId(id)) return null
    return await readJson<Task>(join(this.#tasks, `${id}.json`))
  }

  async putTask (task: Task): Promise<void> {
    await atomicWrite(join(this.#tasks, `${checkId(task.id)}.json`), JSON.stringify(task))
  }

  // Kept outside the Task, which is returned to callers as A2A defines it.
  async getOwner (taskId: string): Promise<string | null> {
    if (!isId(taskId)) return null
    try {
      return (await readFile(join(this.#owners, taskId), 'utf-8')).trim() || null
    } catch {
      return null
    }
  }

  async putOwner (taskId: string, agentId: string): Promise<void> {
    checkId(taskId)
    checkId(agentId)
    await mkdir(join(this.#byOwner, agentId), { recursive: true })
    await atomicWrite(join(this.#byOwner, agentId, taskId), '')
    await atomicWrite(join(this.#owners, taskId), agentId)
  }

  async delOwner (taskId: string): Promise<void> {
    const owner = await this.getOwner(taskId)
    await rm(join(this.#owners, checkId(taskId)), { force: true })
    if (owner !== null && isId(owner)) await rm(join(this.#byOwner, owner, taskId), { force: true })
  }

  // Tasks created by one agent.
  async * tasksOwnedBy (agentId: string): AsyncGenerator<Task> {
    if (!isId(agentId)) return
    for (const taskId of await list(join(this.#byOwner, agentId))) {
      const task = await this.getTask(taskId)
      if (task) yield task
    }
  }

  async * tasks (): AsyncGenerator<Task> {
    for (const name of await list(this.#tasks)) {
      if (!name.endsWith('.json')) continue
      const task = await this.getTask(name.slice(0, -'.json'.length))
      if (task) yield task
    }
  }

  async close (): Promise<void> {}
}
