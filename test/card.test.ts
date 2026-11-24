import { describe, expect, it } from 'vitest'
import { validateCard } from '../src/a2a/card.js'
import type { AgentCard } from '../src/a2a/types.js'
import { PaiCardError } from '../src/errors.js'
import { Pai, withPaiInterface } from '../src/pai.js'
import { Peer } from '../src/peer.js'
import type { CardSource } from '../src/peer.js'
import { RpcConnection } from '../src/protocol/rpc.js'
import { EventQueue } from '../src/util/queue.js'
import { TestIdentity, card, useTestnet, waitFor } from './helpers.js'

const { agent, tempdir } = useTestnet()

const valid = (name = 'alice'): AgentCard => withPaiInterface(card(name), 'abc')

describe('validateCard', () => {
  it('accepts a valid card, and fields pai does not model', () => {
    expect(validateCard(valid())).toEqual([])
    expect(validateCard({ ...valid(), provider: { url: 'https://x', organization: 'x' }, iconUrl: 'https://x/y.png', securitySchemes: {}, futureField: 1 })).toEqual([])
  })

  it('reports each problem', () => {
    const { name: _name, ...noName } = valid()
    expect(validateCard(noName)).toEqual(['name must be a non-empty string'])
    expect(validateCard({ ...valid(), supportedInterfaces: [] })).toEqual(['supportedInterfaces must be a non-empty array'])
    expect(validateCard({ ...valid(), supportedInterfaces: [{ url: 'not a url', protocolBinding: 'x', protocolVersion: '1.0' }] })).toEqual(['supportedInterfaces[0].url must be a valid URL'])
    expect(validateCard({ ...valid(), provider: { organization: 'x' } })).toEqual(['provider must have a valid url and a non-empty organization'])
    expect(validateCard({ ...valid(), capabilities: { streaming: 'yes' } })).toEqual(['capabilities.streaming must be a boolean'])
    expect(validateCard({ ...valid(), defaultInputModes: 'text/plain' })).toEqual(['defaultInputModes must be a non-empty array of strings'])
    expect(validateCard({ ...valid(), skills: [{ id: 's', name: 'S', description: '', tags: [1] }] })).toEqual([
      'skills[0].description must be a non-empty string',
      'skills[0].tags must be a non-empty array of strings'
    ])
    expect(validateCard(null)).toEqual(['card must be an object'])
  })
})

describe('own card', () => {
  it('ready() rejects an invalid card before opening storage', async () => {
    const pai = new Pai({
      identity: new TestIdentity('card validation key'),
      storage: await tempdir('bad'),
      card: { ...card('bad'), skills: 'none' } as unknown as AgentCard
    })
    await expect(pai.ready()).rejects.toBeInstanceOf(PaiCardError)
  })

  it('updateCard() rejects an invalid card and keeps the old one', async () => {
    const a = await agent('alice')
    const before = await a.card()
    const err = await a.updateCard({ ...before!, version: '' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PaiCardError)
    expect((err as PaiCardError).errors).toEqual(['version must be a non-empty string'])
    expect(await a.card()).toEqual(before)
  })
})

describe('remote card strictness', () => {
  // A Peer over a fake card source, so invalid remote cards can be served.
  function peerWith (cards: Array<AgentCard | null | Record<string, unknown>>) {
    const queue = new EventQueue<AgentCard | null>()
    for (const c of cards) queue.push(c as AgentCard | null)
    const source: CardSource = {
      read: async () => cards[cards.length - 1] as AgentCard | null,
      async * watch () { yield * queue }
    }
    const rpc = new RpcConnection({ send: () => {} }, async () => null)
    return { peer: new Peer({ id: new Uint8Array(32) }, rpc, source), queue }
  }

  it('card() throws PaiCardError on an invalid card, unless strict is off', async () => {
    const bad = { ...valid(), skills: undefined }
    const { peer } = peerWith([bad])
    await expect(peer.card()).rejects.toBeInstanceOf(PaiCardError)
    expect(await peer.card({ strict: false })).toEqual(bad)
  })

  it('watchCard() skips invalid versions and reports them', async () => {
    const bad = { ...valid('v2'), name: '' }
    const { peer, queue } = peerWith([null, valid('v1'), bad, valid('v3')])
    queue.end()
    const invalid: PaiCardError[] = []
    const names: string[] = []
    for await (const c of peer.watchCard({ onInvalid: (e) => invalid.push(e) })) names.push(c.name)
    expect(names).toEqual(['v1', 'v3'])
    expect(invalid.map((e) => e.card)).toEqual([bad])
  })
})

describe('watching a remote card', () => {
  async function watchUntil (peer: Peer, edit: () => Promise<void>) {
    const ac = new AbortController()
    const seen: string[] = []
    const done = (async () => {
      for await (const c of peer.watchCard({ signal: ac.signal })) seen.push(c.version)
    })()
    await waitFor(() => seen.length === 1, 15_000, 'the current card')
    await edit()
    await waitFor(() => seen.length === 3, 15_000, 'both edits')
    ac.abort()
    await done
    return seen
  }

  it('sees each edit as it replicates', async () => {
    const a = await agent('alice')
    const b = await agent('bob')
    const peer = await b.connect(a.id)
    const seen = await watchUntil(peer, async () => {
      const current = (await a.card())!
      await a.updateCard({ ...current, version: '1.1.0' })
      await waitFor(async () => (await peer.card())?.version === '1.1.0', 15_000, 'the first edit')
      await a.updateCard({ ...current, version: '1.2.0' })
    })
    expect(seen).toEqual(['1.0.0', '1.1.0', '1.2.0'])
  })

  it('ends when the watching agent closes', async () => {
    const a = await agent('alice')
    const b = await agent('bob', { manual: true })
    const peer = await b.connect(a.id)
    const seen: string[] = []
    const done = (async () => { for await (const c of peer.watchCard()) seen.push(c.version) })()
    await waitFor(() => seen.length === 1, 15_000, 'the current card')
    await b.close()
    await done
  })
})

describe('storage folder', () => {
  it('keeps one agent per folder, and the same id across restarts', async () => {
    const storage = await tempdir('locked')
    const first = await agent('first', { storage, manual: true })
    await expect(agent('second', { storage, manual: true })).rejects.toThrow(/is locked by process/)
    const id = Buffer.from(first.id).toString('hex')
    await first.close()
    const again = await agent('again', { storage })
    expect(Buffer.from(again.id).toString('hex')).toBe(id)
  })

  it('refuses a damaged key file', async () => {
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const storage = await tempdir('damaged')
    await writeFile(join(storage, 'agent.key'), 'ab'.repeat(64))
    await expect(agent('damaged', { storage, manual: true })).rejects.toThrow(/damaged/)
    await writeFile(join(storage, 'agent.key'), 'not hex')
    await expect(agent('damaged', { storage, manual: true })).rejects.toThrow(/not a pai key file/)
  })
})
