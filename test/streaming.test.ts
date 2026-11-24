import { describe, expect, it } from 'vitest'
import { ErrorCodes } from '../src/protocol/jsonrpc.js'
import { agentText, collect, deferred, describeEvent, firstText, taskOf, text, useTestnet } from './helpers.js'

const { agent, tempdir } = useTestnet()

describe('SendStreamingMessage', () => {
  it('streams the task, artifact chunks and the final status', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async (_message, task) => {
      await task.update('TASK_STATE_WORKING')
      await task.artifact({ artifactId: 'out', parts: [{ text: 'hel' }] })
      await task.artifact({ artifactId: 'out', parts: [{ text: 'lo' }] }, { append: true, lastChunk: true })
      await task.update('TASK_STATE_COMPLETED')
    })

    const peer = await a.connect(b.id)
    const events = await collect(peer.stream(text('go')))
    expect(events.map(describeEvent)).toEqual([
      'task:working',
      'artifact:out',
      'artifact:out:append:last',
      'status:completed'
    ])

    const first = events[0]
    if (!first || !('task' in first)) throw new Error('expected the task first')
    const stored = await peer.getTask(first.task.id)
    expect(stored.artifacts).toHaveLength(1)
    expect(stored.artifacts?.[0]?.parts.map((p) => 'text' in p && p.text)).toEqual(['hel', 'lo'])
  })

  it('streams a single Message for a stateless reply', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async () => agentText('hi back'))

    const peer = await a.connect(b.id)
    const events = await collect(peer.stream(text('hi')))
    expect(events.map(describeEvent)).toEqual(['message'])
  })

  it('ends the stream when the task needs input', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async (_message, task) => {
      await task.update('TASK_STATE_WORKING')
      await task.update('TASK_STATE_INPUT_REQUIRED', agentText('more please'))
    })

    const peer = await a.connect(b.id)
    const events = await collect(peer.stream(text('hi')))
    expect(events.map(describeEvent)).toEqual(['task:working', 'status:input-required'])
  })

  it('surfaces handler failure as a final failed status', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async (_message, task) => {
      await task.update('TASK_STATE_WORKING')
      throw new Error('kaput')
    })

    const peer = await a.connect(b.id)
    const events = await collect(peer.stream(text('hi')))
    expect(events.map(describeEvent)).toEqual(['task:working', 'status:failed'])
  })
})

describe('CancelTask', () => {
  it('cancels a running task, aborts the handler and ends its stream', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    let aborted = false
    b.onMessage(async (_message, task) => {
      await task.update('TASK_STATE_WORKING')
      await new Promise<void>((resolve) => task.signal.addEventListener('abort', () => resolve()))
      aborted = true
    })

    const peer = await a.connect(b.id)
    const labels: string[] = []
    for await (const ev of peer.stream(text('long job'))) {
      labels.push(describeEvent(ev))
      if ('task' in ev) {
        const canceled = await peer.cancelTask(ev.task.id)
        expect(canceled.status.state).toBe('TASK_STATE_CANCELED')
      }
    }
    expect(labels).toEqual(['task:working', 'status:canceled'])
    expect(aborted).toBe(true)
  })

  it('cancels a task waiting for input', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async (_m, task) => { await task.update('TASK_STATE_WORKING'); await task.update('TASK_STATE_INPUT_REQUIRED') })

    const peer = await a.connect(b.id)
    const task = taskOf(await peer.send(text('hi')))
    expect((await peer.cancelTask(task.id)).status.state).toBe('TASK_STATE_CANCELED')
    expect((await peer.getTask(task.id)).status.state).toBe('TASK_STATE_CANCELED')
  })

  it('refuses to cancel a finished task', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async (_m, task) => { await task.update('TASK_STATE_WORKING'); await task.update('TASK_STATE_COMPLETED') })

    const peer = await a.connect(b.id)
    const task = taskOf(await peer.send(text('hi')))
    await expect(peer.cancelTask(task.id)).rejects.toMatchObject({ code: ErrorCodes.TaskNotCancelable })
    await expect(peer.cancelTask('missing')).rejects.toMatchObject({ code: ErrorCodes.TaskNotFound })
  })
})

describe('returnImmediately and SubscribeToTask', () => {
  it('returns a submitted task at once and streams the rest on subscribe', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    const gate = deferred()
    b.onMessage(async (_message, task) => {
      await gate.promise
      await task.update('TASK_STATE_WORKING')
      await task.update('TASK_STATE_COMPLETED', agentText('done'))
    })

    const peer = await a.connect(b.id)
    const submitted = taskOf(await peer.send(text('later'), { returnImmediately: true }))
    expect(submitted.status.state).toBe('TASK_STATE_SUBMITTED')

    const labels: string[] = []
    for await (const ev of peer.subscribe(submitted.id)) {
      labels.push(describeEvent(ev))
      if ('task' in ev) gate.resolve()
    }
    expect(labels).toEqual(['task:submitted', 'status:working', 'status:completed'])
    expect(firstText((await peer.getTask(submitted.id)).status.message)).toBe('done')
  })

  it('completes a non-blocking task whose handler just returns a reply', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async () => agentText('quick'))

    const peer = await a.connect(b.id)
    const submitted = taskOf(await peer.send(text('hi'), { returnImmediately: true }))
    const events = await collect(peer.subscribe(submitted.id))
    expect(events.at(-1) && describeEvent(events.at(-1)!)).toMatch(/completed/)
  })

  it('subscribing to a finished task is an unsupported operation', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async (_m, task) => { await task.update('TASK_STATE_WORKING'); await task.update('TASK_STATE_COMPLETED') })

    const peer = await a.connect(b.id)
    const task = taskOf(await peer.send(text('hi')))
    await expect(collect(peer.subscribe(task.id))).rejects.toMatchObject({ code: ErrorCodes.UnsupportedOperation })
  })

  it('subscribing to a task waiting for input yields just the task', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    b.onMessage(async (_m, task) => { await task.update('TASK_STATE_WORKING'); await task.update('TASK_STATE_INPUT_REQUIRED') })

    const peer = await a.connect(b.id)
    const task = taskOf(await peer.send(text('hi')))
    const events = await collect(peer.subscribe(task.id))
    expect(events.map(describeEvent)).toEqual(['task:input-required'])
  })
})

describe('restart recovery', () => {
  it('fails tasks that were still running when the agent stopped', async () => {
    const storage = await tempdir('recover')
    const a = await agent('alice')
    const first = await agent('bob', { storage, manual: true })
    const started = deferred()
    first.onMessage(async (_m, task) => {
      await task.update('TASK_STATE_WORKING')
      started.resolve()
      await new Promise(() => {})
    })

    const submitted = taskOf(await (await a.connect(first.id)).send(text('never finishes'), { returnImmediately: true }))
    await started.promise
    await first.close()

    const second = await agent('bob', { storage })
    const task = await (await a.connect(second.id)).getTask(submitted.id)
    expect(task.status.state).toBe('TASK_STATE_FAILED')
    expect(firstText(task.status.message)).toMatch(/restarted/)
  })
})
