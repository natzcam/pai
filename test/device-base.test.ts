import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import Corestore from 'corestore'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceBase } from '../src/devices/base.js'
import { card } from './helpers.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function store (): Promise<Corestore> {
  const dir = await mkdtemp(join(tmpdir(), 'pai-devices-'))
  const s = new Corestore(dir)
  cleanup.push(async () => { await s.close(); await rm(dir, { recursive: true, force: true }) })
  return s
}

async function open (s: Corestore, key: Uint8Array): Promise<DeviceBase> {
  const d = new DeviceBase(s, key)
  await d.ready()
  cleanup.push(() => d.close())
  return d
}

// Replicates two stores in memory; returns a function that cuts the link.
function link (a: Corestore, b: Corestore): () => void {
  const s1 = a.replicate(true) as any
  const s2 = b.replicate(false) as any
  s1.pipe(s2).pipe(s1)
  const cut = (): void => { s1.destroy(); s2.destroy() }
  cleanup.push(async () => { cut() })
  return cut
}

async function until (check: () => boolean, bases: DeviceBase[], ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Promise.all(bases.map(async (b) => { await b.base.update().catch(() => {}); await b.refresh().catch(() => {}) }))
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const id = (): string => randomBytes(32).toString('hex')
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

describe('DeviceBase', () => {
  it('a removed creator stops signing once another device signs', async () => {
    const [sa, sb] = [await store(), await store()]
    const [devA, devB] = [id(), id()]
    const key = await DeviceBase.create(sa, Buffer.from(devA, 'hex'))
    const a = await open(sa, key)
    const b = await open(sb, key)
    link(sa, sb)
    await a.append({ type: 'device.add', device: devB, writer: hex(b.writerKey) })
    await until(() => b.writable, [a, b])
    // B removes the creator before it signs itself: the creator's writer
    // stays (the last that signs) until B's hello.
    await b.append({ type: 'device.remove', device: devA })
    expect(b.state.signers).toEqual([hex(a.writerKey)])
    await b.hello()
    await until(() => b.base.isIndexer && b.state.signers.length === 1 && b.state.signers[0] === hex(b.writerKey) && !a.base.writable, [a, b], 15_000)
    expect(b.hasDevice(devA)).toBe(false)
  })

  it('starts with its creating device, which can set the card', async () => {
    const s = await store()
    const device = id()
    const key = await DeviceBase.create(s, Buffer.from(device, 'hex'), 'laptop')
    const d = await open(s, key)
    expect(d.state.devices.map((x) => [x.device, x.name])).toEqual([[device, 'laptop']])
    expect(d.hasDevice(device)).toBe(true)
    expect(d.hasDevice(id())).toBe('pending')
    await d.append({ type: 'card.set', card: card('me') as any })
    expect(d.state.card?.name).toBe('me')
    await expect(d.append({ type: 'device.remove', device })).resolves.toBeUndefined()
    expect(d.hasDevice(device)).toBe(true) // the last device stays
  })

  it('retires a removed device\'s writer, even if the device comes back', async () => {
    const [sa, sb, sc] = [await store(), await store(), await store()]
    const [devA, devB] = [id(), id()]
    const key = await DeviceBase.create(sa, Buffer.from(devA, 'hex'))
    const a = await open(sa, key)
    const b = await open(sb, key)
    link(sa, sb)
    await a.append({ type: 'device.add', device: devB, writer: hex(b.writerKey) })
    await until(() => b.writable, [a, b])
    await b.append({ type: 'device.remove', device: devA })
    // The creator's old writer can't come back...
    await b.append({ type: 'device.add', device: devA, writer: hex(a.writerKey) })
    expect(b.hasDevice(devA)).toBe(false)
    // ...and if A returns with a new writer, the old one still has no say.
    const c = await open(sc, key)
    link(sb, sc)
    await b.append({ type: 'device.add', device: devA, writer: hex(c.writerKey) })
    expect(b.hasDevice(devA)).toBe(true)
    await until(() => a.state.devices.some((d) => d.writer === hex(c.writerKey)), [a, b, c])
    await a.base.append({ type: 'device.remove', device: devB, at: Date.now() }) // the old writer
    await until(() => b.state.deviceWriters.length === 3, [a, b, c])
    await new Promise((resolve) => setTimeout(resolve, 300))
    await b.base.update()
    await b.refresh()
    expect(b.hasDevice(devB)).toBe(true)
  })

  it('any one device adds and removes others, at once and on every replica', async () => {
    const [sa, sb] = [await store(), await store()]
    const [devA, devB] = [id(), id()]
    const key = await DeviceBase.create(sa, Buffer.from(devA, 'hex'))
    const a = await open(sa, key)
    const b = await open(sb, key)
    link(sa, sb)
    await a.append({ type: 'device.add', device: devB, writer: hex(b.writerKey), name: 'phone' })
    await until(() => b.writable && b.hasDevice(devA) === true && b.hasDevice(devB) === true, [a, b])

    // The new device removes the one that added it.
    await b.append({ type: 'device.remove', device: devA })
    expect(b.hasDevice(devA)).toBe(false)
    await until(() => a.hasDevice(devA) === false, [a, b])
  })

  it('every device signs once it has said hello, and signing goes on after losing one', async () => {
    const [sa, sb, sc] = [await store(), await store(), await store()]
    const [devA, devB, devC] = [id(), id(), id()]
    const key = await DeviceBase.create(sa, Buffer.from(devA, 'hex'))
    const a = await open(sa, key)
    const b = await open(sb, key)
    const c = await open(sc, key)
    link(sa, sb)
    link(sa, sc)
    const cutB = link(sb, sc)
    expect(a.state.signers).toEqual([hex(a.writerKey)])
    await a.append({ type: 'device.add', device: devB, writer: hex(b.writerKey) })
    await a.append({ type: 'device.add', device: devC, writer: hex(c.writerKey) })
    await until(() => b.writable && c.writable, [a, b, c])
    // Not a signer before it has written.
    expect(b.base.isIndexer).toBe(false)
    await b.hello()
    await c.hello()
    await b.hello() // already a signer, or on its way: nothing more
    await until(() => b.base.isIndexer && c.base.isIndexer && a.state.signers.length === 3, [a, b, c], 15_000)

    // B is lost; A removes it; its writer stops signing, and A and C go on.
    cutB()
    await b.close()
    await a.append({ type: 'device.remove', device: devB })
    await until(() => a.state.signers.length === 2 && !a.state.signers.includes(hex(b.writerKey)), [a, c], 15_000)
    const before = a.base.signedLength
    for (let i = 0; i < 5; i++) await a.append({ type: 'card.set', card: { ...card('me'), version: `${i}` } as any })
    await until(() => a.base.signedLength > before && c.hasDevice(devB) === false, [a, c], 15_000)
  })
})
