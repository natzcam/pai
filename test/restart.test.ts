import { describe, expect, it } from 'vitest'
import { PaiConnectionError } from '../src/errors.js'
import type { MessageHandler } from '../src/server.js'
import { deferred, text, useTestnet, waitFor } from './helpers.js'

const { agent, tempdir } = useTestnet()

// Starts work, then never finishes: only a restart ends it.
function hangs (started: () => void): MessageHandler {
  return async (_m, task) => {
    await task.update('TASK_STATE_WORKING')
    started()
    await new Promise(() => {})
  }
}

describe('restart mid-stream', () => {
  it('server restarts mid-stream: the stream fails fast, and the task is stored as failed', async () => {
    const client = await agent('alice')
    const storage = await tempdir('server')
    const started = deferred()
    const server = await agent('bob', { storage, manual: true, handler: hangs(started.resolve) })

    let taskId = ''
    const peer = await client.connect(server.id)
    const streamed = (async () => {
      for await (const ev of peer.stream(text('long job'))) if ('task' in ev) taskId = ev.task.id
    })()
    await started.promise
    await waitFor(() => taskId !== '', 15_000, 'the first stream event')
    // Attach before closing: the stream rejects while close() is running.
    const failed = expect(streamed).rejects.toBeInstanceOf(PaiConnectionError)
    await server.close()
    await failed

    const restarted = await agent('bob', { storage })
    const task = await (await client.connect(restarted.id)).getTask(taskId)
    expect(task.status.state).toBe('TASK_STATE_FAILED')
  })
})
