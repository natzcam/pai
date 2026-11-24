import { randomBytes } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PaiRpcError } from '../src/errors.js'
import { ErrorCodes } from '../src/protocol/jsonrpc.js'
import { TestIdentity, agentText, taskOf, text, useTestnet } from './helpers.js'

const { agent, tempdir } = useTestnet()

describe('identity records', () => {
  it('remembers peers it has met, so resolve() answers for them', async () => {
    const identity = new TestIdentity()
    const a = await agent('alice', { identity })
    const b = await agent('bob')

    // Agents on one topic meet on their own, so "not yet met" is any other id.
    expect(await identity.resolve(randomBytes(32))).toBeNull()
    await a.connect(b.id)
    const record = await identity.resolve(b.id)
    expect(record && Buffer.from(record.id).equals(Buffer.from(b.id))).toBe(true)
  })
})

describe('protocol versions', () => {
  it('refuses a peer on another pai protocol version, and both sides say why', async () => {
    const a = await agent('alice')
    const b = await agent('bob', { options: { protocolVersion: 2, timeout: 3000 } })
    await expect(a.connect(b.id)).rejects.toThrow(/newer pai \(protocol v2; this agent speaks v1\)/)
    await expect(b.connect(a.id)).rejects.toThrow(/older pai \(protocol v1; this agent speaks v2\)/)
  })
})

describe('local storage', () => {
  it('keeps tasks as files in its own folder, out of reach of path-like ids', async () => {
    const storage = await tempdir('files')
    const bob = await agent('bob', { storage, handler: async (_m, task) => { await task.update('TASK_STATE_COMPLETED', agentText('done')) } })
    const alice = await agent('alice')
    const peer = await alice.connect(bob.id)
    const task = taskOf(await peer.send(text('hi')))

    expect(await readdir(join(storage, 'tasks'))).toEqual([`${task.id}.json`])
    for (const id of ['../owners/x', '..', '/etc/passwd', `${task.id}/../${task.id}`]) {
      const err = await peer.getTask(id).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PaiRpcError)
      expect((err as PaiRpcError).code).toBe(ErrorCodes.TaskNotFound)
    }
  })
})
