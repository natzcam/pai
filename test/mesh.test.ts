import { describe, expect, it } from 'vitest'
import type { Pai } from '../src/pai.js'
import type { MessageHandler } from '../src/server.js'
import { agentText, firstText, taskOf, text, useTestnet, waitFor } from './helpers.js'

const { agent } = useTestnet()

const hex = (id: Uint8Array): string => Buffer.from(id).toString('hex')
const peerIds = (pai: Pai): string[] => pai.peers.map((p) => hex(p.id)).sort()

// Answers each message with its own name, counting what it handled.
function named (name: string, seen: string[]): MessageHandler {
  return async (message, task) => {
    seen.push(firstText(message)!)
    await task.update('TASK_STATE_WORKING')
    await task.update('TASK_STATE_COMPLETED', agentText(name))
  }
}

describe('three agents on one secret', () => {
  it('find each other through the topic, without connect(), and read each other\'s cards', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    await waitFor(() => a.peers.length === 1 && b.peers.length === 1, 15_000, 'alice and bob to connect')

    // A late joiner meets both, and both meet it.
    const c = await agent('carol')
    const all = [a, b, c]
    await waitFor(() => all.every((pai) => pai.peers.length === 2), 15_000, 'a full mesh')

    for (const pai of all) {
      expect(peerIds(pai)).toEqual(all.filter((o) => o !== pai).map((o) => hex(o.id)).sort())
    }

    const names = new Map(all.map((pai, i) => [hex(pai.id), ['alice', 'bob', 'carol'][i]]))
    for (const pai of all) {
      for (const peer of pai.peers) expect((await peer.card())?.name).toBe(names.get(hex(peer.id)))
    }
  })

  it('keeps calls between the two agents involved, and tasks with their creator', async () => {
    const bobSaw: string[] = []
    const carolSaw: string[] = []
    const a = await agent('alice')
    const b = await agent('bob', { handler: named('bob', bobSaw) })
    const c = await agent('carol', { handler: named('carol', carolSaw) })

    const aliceToCarol = await a.connect(c.id)
    const bobToCarol = await b.connect(c.id)

    const task = taskOf(await aliceToCarol.send(text('from alice')))
    expect(firstText(task.status.message)).toBe('carol')
    expect(carolSaw).toEqual(['from alice'])
    expect(bobSaw).toEqual([])

    // Bob can read alice's task on carol, but it isn't listed as his.
    expect((await bobToCarol.getTask(task.id)).status.state).toBe('TASK_STATE_COMPLETED')
    expect((await bobToCarol.listTasks()).tasks).toEqual([])
    expect((await aliceToCarol.listTasks()).tasks.map((t) => t.id)).toEqual([task.id])

    const own = taskOf(await bobToCarol.send(text('from bob')))
    expect((await bobToCarol.listTasks()).tasks.map((t) => t.id)).toEqual([own.id])
    expect((await aliceToCarol.listTasks()).tasks.map((t) => t.id)).toEqual([task.id])
    expect(carolSaw).toEqual(['from alice', 'from bob'])
  })
})
