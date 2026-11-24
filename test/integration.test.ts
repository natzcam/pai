import { describe, expect, it } from 'vitest'
import { PaiAuthError, PaiRpcError } from '../src/errors.js'
import { ErrorCodes } from '../src/protocol/jsonrpc.js'
import type { Identity } from '../src/identity/types.js'
import { TestIdentity, agentText, firstText, messageOf, taskOf, text, useTestnet } from './helpers.js'
import { PAI_BINDING } from '../src/a2a/types.js'

const { agent, tempdir } = useTestnet()

describe('two agents over Hyperswarm', () => {
  it('connects, reads the remote card, and completes a task with message/send', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async (message, task) => {
      await task.update('TASK_STATE_WORKING')
      await task.artifact({ artifactId: 'echo', parts: [{ text: firstText(message)!.toUpperCase() }] })
      await task.update('TASK_STATE_COMPLETED')
    })

    const peer = await a.connect(b.id)

    const remoteCard = await peer.card()
    expect(remoteCard?.name).toBe('bob')
    expect(remoteCard?.supportedInterfaces[0]).toEqual({ url: `pai://${Buffer.from(b.id).toString('hex')}`, protocolBinding: PAI_BINDING, protocolVersion: '1.0' })

    const result = taskOf(await peer.send(text('hello')))
    expect(result.status.state).toBe('TASK_STATE_COMPLETED')
    expect(result.artifacts?.[0]?.parts[0]).toEqual({ text: 'HELLO' })

    const fetched = await peer.getTask(result.id)
    expect(fetched.status.state).toBe('TASK_STATE_COMPLETED')
    expect(fetched.history?.[0]?.taskId).toBe(result.id)
  })

  it('returns a bare Message when the handler replies without touching the task', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async (message) => agentText(`pong:${firstText(message)}`))

    const peer = await a.connect(b.id)
    const reply = messageOf(await peer.send(text('ping', { contextId: 'ctx-1' })))
    expect(firstText(reply)).toBe('pong:ping')
    expect(reply.contextId).toBe('ctx-1')
  })

  it('resumes an input-required task with a follow-up message', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async (message, task) => {
      if (task.task.history!.length === 1) {
        await task.update('TASK_STATE_WORKING')
        await task.update('TASK_STATE_INPUT_REQUIRED', agentText('which language?'))
        return
      }
      return agentText(`hola (${firstText(message)})`)
    })

    const peer = await a.connect(b.id)
    const first = taskOf(await peer.send(text('translate hello')))
    expect(first.status.state).toBe('TASK_STATE_INPUT_REQUIRED')
    expect(firstText(first.status.message)).toBe('which language?')

    const second = taskOf(await peer.send(text('spanish', { taskId: first.id })))
    expect(second.id).toBe(first.id)
    expect(second.status.state).toBe('TASK_STATE_COMPLETED')
    expect(firstText(second.status.message)).toBe('hola (spanish)')
    expect(second.history).toHaveLength(4)
  })

  it('marks the task failed when the handler throws', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async () => { throw new Error('boom') })

    const peer = await a.connect(b.id)
    const result = taskOf(await peer.send(text('hi')))
    expect(result.status.state).toBe('TASK_STATE_FAILED')
    expect(firstText(result.status.message)).toBe('boom')
  })

  it('surfaces A2A errors as PaiRpcError', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    const peer = await a.connect(b.id)

    await expect(peer.getTask('nope')).rejects.toMatchObject({ code: ErrorCodes.TaskNotFound, reason: 'TASK_NOT_FOUND' })
    await expect(peer.send(text('hi'))).rejects.toBeInstanceOf(PaiRpcError)
  })

  it('works in both directions on one connection', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    a.onMessage(async () => agentText('alice'))
    b.onMessage(async () => agentText('bob'))

    const toB = await a.connect(b.id)
    const toA = await b.connect(a.id)
    expect(firstText(messageOf(await toB.send(text('?'))))).toBe('bob')
    expect(firstText(messageOf(await toA.send(text('?'))))).toBe('alice')
  })

  it('rejects a peer whose identity doesn\'t trust it', async () => {
    const a = await agent('alice')
    const mallory = await agent('mallory', { key: 'some other key' })

    await expect(mallory.connect(a.id)).rejects.toBeInstanceOf(PaiAuthError)
    expect(a.peers).toHaveLength(0)
  })

  it('keeps its id, card and tasks across restarts', async () => {
    const storage = await tempdir('restart')
    const first = await agent('bob', { storage, manual: true })
    first.onMessage(async (_m, task) => { await task.update('TASK_STATE_WORKING'); await task.update('TASK_STATE_COMPLETED') })
    const a = await agent('alice')
    const task = taskOf(await (await a.connect(first.id)).send(text('persist me')))
    const id = Buffer.from(first.id)
    await first.close()

    const second = await agent('bob', { storage })
    expect(Buffer.from(second.id).equals(id)).toBe(true)
    expect((await second.card())?.name).toBe('bob')

    const peer = await a.connect(second.id)
    expect((await peer.getTask(task.id)).status.state).toBe('TASK_STATE_COMPLETED')
  })
})

describe('simultaneous dials', () => {
  // Both sides dial at once, so Hyperswarm may open two connections and
  // close one as a duplicate. That must not fail connect().
  it('connect() survives a duplicate connection being dropped', async () => {
    for (let round = 0; round < 8; round++) {
      const a = await agent(`a${round}`)
      const b = await agent(`b${round}`)
      const [toB, toA] = await Promise.all([a.connect(b.id), b.connect(a.id)])
      expect(toB.closed).toBe(false)
      expect(toA.closed).toBe(false)
    }
  })
})

describe('refusal', () => {
  it('a peer that is refused hears so at once, instead of timing out', async () => {
    const bob = await agent('bob')
    // Accepts everyone, but its proofs are made with the wrong key.
    const wrong = new TestIdentity('not the key bob trusts')
    const lenient: Identity = {
      discover: async () => {},
      proof: (ctx) => wrong.proof(ctx),
      authenticate: async () => true,
      resolve: async () => null
    }
    const mallory = await agent('mallory', { identity: lenient, options: { timeout: 20_000 } })
    const started = Date.now()
    await expect(mallory.connect(bob.id)).rejects.toThrow('Peer refused this agent')
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
