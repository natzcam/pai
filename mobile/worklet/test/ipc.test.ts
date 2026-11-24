import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { serve } from '../src/ipc.js'
import type { PhoneNode } from '../src/node.js'

// A stream pair's worklet end: what the app writes comes in as data;
// what the worklet writes is collected as parsed lines.
function pipe (): { stream: EventEmitter & { write: (s: string) => void }, sent: any[], send: (s: string | Buffer) => void } {
  const sent: any[] = []
  const stream = Object.assign(new EventEmitter(), { write: (s: string) => { for (const l of s.split('\n').filter(Boolean)) sent.push(JSON.parse(l)) } })
  return { stream, sent, send: (s) => { stream.emit('data', typeof s === 'string' ? Buffer.from(s) : s) } }
}

const tick = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 10)) }

describe('the worklet\'s IPC', () => {
  it('tries init again after a start that failed', async () => {
    const { stream, sent, send } = pipe()
    let starts = 0
    const fake = (): PhoneNode => Object.assign(new EventEmitter(), {
      start: async () => { if (++starts === 1) throw new Error('storage locked'); return true },
      close: async () => {},
      status: () => ({ running: true })
    }) as unknown as PhoneNode
    serve(stream, fake)
    send('{"id":1,"method":"init","params":{"dir":"/x"}}\n')
    await tick()
    expect(sent.pop()).toEqual({ id: 1, error: 'storage locked' })
    send('{"id":2,"method":"init","params":{"dir":"/x"}}\n')
    await tick()
    expect(sent.pop()).toEqual({ id: 2, result: { running: true } })
    expect(starts).toBe(2)
  })

  it('drops a line too long whole, and reads the next one; splits lines on bytes', async () => {
    const { stream, sent, send } = pipe()
    serve(stream, () => { throw new Error('unused') })
    send(Buffer.alloc(1024 * 1024 + 10, 'x'))
    send('yyyy')
    send('yyyy\n{"id":3,"method":"status"}\n')
    await tick()
    expect(sent).toEqual([{ id: null, error: 'Line too long' }, { id: 3, error: 'Call init first' }])
    // A character split across chunks still decodes.
    const line = Buffer.from('{"id":4,"method":"é"}\n')
    send(line.subarray(0, 18))
    send(line.subarray(18))
    await tick()
    expect(sent.pop()).toEqual({ id: 4, error: 'No such method: é' })
  })
})
