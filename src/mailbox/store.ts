import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Task } from '../a2a/types.js'
import { atomicWrite, checkId, isId, list, readJson } from '../util/files.js'

export const MAX_ENVELOPE_BYTES = 256 * 1024
export const MAX_WAITING = 1000

// An envelope held by a mailbox for its recipient.
export interface Held {
  id: string
  from: string
  // Milliseconds since the Unix epoch.
  at: number
  // The encoded envelope, base64url.
  envelope: string
}

// A mailbox's envelopes, as files: mailbox/<recipient>/<id>.json.
export class MailboxStore {
  readonly #dir: string

  constructor (storage: string) {
    this.#dir = join(storage, 'mailbox')
  }

  async ready (): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
  }

  async deposit (to: string, from: string, envelope: string): Promise<Held> {
    const dir = join(this.#dir, checkId(to))
    await mkdir(dir, { recursive: true })
    if ((await list(dir)).length >= MAX_WAITING) throw new Error(`mailbox for ${to.slice(0, 8)}… is full`)
    // Time first, so a listing is oldest first.
    const held: Held = { id: `${Date.now().toString().padStart(15, '0')}-${randomUUID()}`, from, at: Date.now(), envelope }
    await atomicWrite(join(dir, `${held.id}.json`), JSON.stringify(held))
    return held
  }

  async collect (to: string, limit: number): Promise<Held[]> {
    if (!isId(to)) return []
    const out: Held[] = []
    for (const name of (await list(join(this.#dir, to))).slice(0, limit)) {
      const held = await readJson<Held>(join(this.#dir, to, name))
      if (held) out.push(held)
    }
    return out
  }

  async ack (to: string, ids: string[]): Promise<void> {
    if (!isId(to)) return
    for (const id of ids) if (isId(id)) await rm(join(this.#dir, to, `${id}.json`), { force: true })
  }
}

// failed: the recipient got the message and refused it, so retrying won't help.
export type PostState = 'queued' | 'delivered' | 'deposited' | 'failed'

// A letter this agent has to get to another agent: a message it sent with
// post(), or a task it owes a reply for. Kept until it's delivered or handed
// to a mailbox, so it survives restarts.
export interface Post {
  id: string
  to: string
  kind: 'message' | 'task'
  // The letter, as sent: the A2A Message or Task.
  body: unknown
  state: PostState
  createdAt: number
  updatedAt: number
  // How it went: the direct delivery's task id, or the mailbox it went to.
  taskId?: string
  mailbox?: string
  // The recipient's task, as last reported back through a mailbox.
  task?: Task
  lastError?: string
}

// Posts that are done (delivered, deposited, failed) are kept this long
// after their last change, so their replies can still attach.
export const DONE_RETENTION = 30 * 24 * 60 * 60 * 1000

// outbox/queued/<id>.json for posts still to send, outbox/done/<id>.json for
// the rest, so a retry pass reads only what's waiting; replies-owed/<from>/
// <taskId> marks tasks that came through a mailbox and still owe a reply.
export class OutboxStore {
  readonly #queued: string
  readonly #done: string
  readonly #replies: string

  constructor (storage: string) {
    this.#queued = join(storage, 'outbox', 'queued')
    this.#done = join(storage, 'outbox', 'done')
    this.#replies = join(storage, 'replies-owed')
  }

  async ready (): Promise<void> {
    for (const d of [this.#queued, this.#done, this.#replies]) await mkdir(d, { recursive: true })
  }

  // Written to the folder for its state, then removed from the other one.
  async put (post: Post): Promise<void> {
    const name = `${checkId(post.id)}.json`
    const [to, from] = post.state === 'queued' ? [this.#queued, this.#done] : [this.#done, this.#queued]
    await atomicWrite(join(to, name), JSON.stringify(post))
    await rm(join(from, name), { force: true })
  }

  async get (id: string): Promise<Post | null> {
    if (!isId(id)) return null
    return await readJson<Post>(join(this.#queued, `${id}.json`)) ?? await readJson<Post>(join(this.#done, `${id}.json`))
  }

  async queued (): Promise<Post[]> {
    return sorted(await readAll(this.#queued))
  }

  async done (): Promise<Post[]> {
    return sorted(await readAll(this.#done))
  }

  async all (): Promise<Post[]> {
    return sorted([...await readAll(this.#queued), ...await readAll(this.#done)])
  }

  // Drops done posts last changed before `before`.
  async prune (before: number): Promise<number> {
    let dropped = 0
    for (const post of await readAll(this.#done)) {
      if (post.updatedAt < before) {
        await rm(join(this.#done, `${checkId(post.id)}.json`), { force: true })
        dropped++
      }
    }
    return dropped
  }

  async oweReply (from: string, taskId: string): Promise<void> {
    await mkdir(join(this.#replies, checkId(from)), { recursive: true })
    await atomicWrite(join(this.#replies, from, checkId(taskId)), '')
  }

  async settleReply (from: string, taskId: string): Promise<void> {
    if (isId(from) && isId(taskId)) await rm(join(this.#replies, from, taskId), { force: true })
  }

  async repliesOwed (): Promise<Array<{ from: string, taskId: string }>> {
    const out: Array<{ from: string, taskId: string }> = []
    for (const from of await list(this.#replies)) {
      for (const taskId of await list(join(this.#replies, from))) out.push({ from, taskId })
    }
    return out
  }
}

async function readAll (dir: string): Promise<Post[]> {
  const out: Post[] = []
  for (const name of await list(dir)) {
    const post = await readJson<Post>(join(dir, name))
    if (post) out.push(post)
  }
  return out
}

function sorted (posts: Post[]): Post[] {
  return posts.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}
