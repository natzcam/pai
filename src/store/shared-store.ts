import type { Task } from '../a2a/types.js'
import type { SharedTasks } from '../identity/types.js'
import { TaskStore } from './task-store.js'
import { isTrimmed } from '../group/state.js'
import { updatedAt } from '../server.js'

// A TaskStore whose tasks are shared in groups (Identity.tasks): every write
// is published, and a task this device doesn't hold, or holds an older
// copy of, is read from the groups' replicas. So any device of the serving
// identity can pick up a task another one ran.
// `shared` is null until the identity has opened its group: until then this
// is a plain TaskStore.
export class SharedTaskStore extends TaskStore {
  constructor (storage: string, private readonly sharing: () => SharedTasks | null) {
    super(storage)
  }

  // The newer of this device's file and the group's copy, except that a
  // cut-down group copy (fitTask) never replaces a whole local one.
  override async getTask (id: string): Promise<Task | null> {
    const local = await super.getTask(id)
    const remote = (await this.sharing()?.get(id))?.task ?? null
    if (!remote) return local
    if (local && (isTrimmed(remote) || updatedAt(local) >= updatedAt(remote))) return local
    return remote
  }

  // Publishes every task this device holds that's newer than the group's
  // copy (or missing from it): what it changed before its groups opened,
  // such as tasks recovery failed after a crash.
  async publishNewer (): Promise<void> {
    const shared = this.sharing()
    if (!shared) return
    for await (const local of super.tasks()) {
      const remote = (await shared.get(local.id))?.task ?? null
      if (!remote || updatedAt(local) > updatedAt(remote)) shared.put(local, await this.getOwner(local.id))
    }
  }

  override async putTask (task: Task): Promise<void> {
    await super.putTask(task)
    this.sharing()?.put(task, await this.getOwner(task.id))
  }

  override async getOwner (taskId: string): Promise<string | null> {
    return await super.getOwner(taskId) ?? (await this.sharing()?.get(taskId))?.owner ?? null
  }

  override async putOwner (taskId: string, agentId: string): Promise<void> {
    await super.putOwner(taskId, agentId)
    // The owner goes out with the task's next write (putTask follows).
  }

  // This agent's tasks: its own files, plus what its other devices served.
  override async * tasks (): AsyncGenerator<Task> {
    const seen = new Set<string>()
    // super.tasks() reads through getTask above: already the newer copy.
    for await (const task of super.tasks()) {
      seen.add(task.id)
      yield task
    }
    const shared = this.sharing()
    if (!shared) return
    for await (const { task } of shared.list()) {
      if (!seen.has(task.id)) yield task
    }
  }
}

