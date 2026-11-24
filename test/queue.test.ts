import { describe, expect, it } from 'vitest'
import { EventQueue } from '../src/util/queue.js'

describe('EventQueue', () => {
  it('delivers buffered and later items in order, then ends', async () => {
    const q = new EventQueue<number>()
    q.push(1)
    setTimeout(() => { q.push(2); q.end(); q.push(3) }, 5)
    const out: number[] = []
    for await (const n of q) out.push(n)
    expect(out).toEqual([1, 2])
  })

  it('rejects a waiting consumer on fail', async () => {
    const q = new EventQueue<number>()
    setTimeout(() => q.fail(new Error('nope')), 5)
    await expect((async () => { for await (const _ of q) {} })()).rejects.toThrow('nope')
  })
})
