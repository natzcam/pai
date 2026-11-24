import { describe, expect, it } from 'vitest'
import type { Task } from '../src/a2a/types.js'
import { PaiRpcError } from '../src/errors.js'
import type { Pai } from '../src/pai.js'
import { ErrorCodes } from '../src/protocol/jsonrpc.js'
import type { MessageHandler } from '../src/server.js'
import { agentText, collect, describeEvent, firstText, taskOf, text, useTestnet, waitFor } from './helpers.js'

const { agent } = useTestnet()

// Asks for input on the first message, and completes with what it was given.
const asksForInput: MessageHandler = async (message, task) => {
  if (task.task.history && task.task.history.length > 1) {
    await task.update('TASK_STATE_WORKING')
    await task.update('TASK_STATE_COMPLETED', agentText(`got ${firstText(message)}`))
    return
  }
  await task.update('TASK_STATE_WORKING')
  await task.update('TASK_STATE_INPUT_REQUIRED', agentText('more please'))
}

async function notFound (call: Promise<unknown>): Promise<void> {
  const err = await call.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(PaiRpcError)
  expect((err as PaiRpcError).code).toBe(ErrorCodes.TaskNotFound)
}

describe('task ownership', () => {
  it('another connected agent cannot cancel or continue a task', async () => {
    const bob = await agent('bob', { handler: asksForInput })
    const alice = await (await agent('alice')).connect(bob.id)
    const carol = await (await agent('carol')).connect(bob.id)
    const task = taskOf(await alice.send(text('start')))

    await notFound(carol.cancelTask(task.id))
    await notFound(carol.send(text('from carol', { taskId: task.id })))
    expect((await carol.getTask(task.id)).status.state).toBe('TASK_STATE_INPUT_REQUIRED')
    expect((await alice.cancelTask(task.id)).status.state).toBe('TASK_STATE_CANCELED')
  })

  it('keeps a context named for a caller to that caller', async () => {
    const bob = await agent('bob', { handler: async () => agentText('ok') })
    const alicePai = await agent('alice')
    const carolPai = await agent('carol')
    const alice = await alicePai.connect(bob.id)
    const carol = await carolPai.connect(bob.id)
    const mine = `${Buffer.from(alicePai.id).toString('hex')}:notes`
    expect(await alice.send(text('hi', { contextId: mine }))).toBeTruthy()
    const err = await carol.send(text('me too', { contextId: mine })).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(PaiRpcError)
    expect((err as PaiRpcError).code).toBe(ErrorCodes.InvalidParams)
  })
})
