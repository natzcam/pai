import HyperDHT from 'hyperdht'
import { describe, expect, it } from 'vitest'
import { loadKeyPair } from '../src/store/key-file.js'
import { MAILBOX_METHODS } from '../src/mailbox/postman.js'
import { decodeEnvelope, encodeEnvelope, open, pairKey, seal } from '../src/mailbox/seal.js'
import { OutboxStore } from '../src/mailbox/store.js'
import type { Post } from '../src/mailbox/store.js'
import type { Pai } from '../src/pai.js'
import type { MessageHandler } from '../src/server.js'
import { agentText, firstText, text, useTestnet, waitFor } from './helpers.js'

describe('sealed envelopes', () => {
  const alice = HyperDHT.keyPair()
  const bob = HyperDHT.keyPair()
  const carol = HyperDHT.keyPair()

  it('open only for their recipient, and only as sealed', () => {
    expect(pairKey(alice, bob.publicKey).equals(pairKey(bob, alice.publicKey))).toBe(true)

    const envelope = decodeEnvelope(encodeEnvelope(seal(alice, bob.publicKey, { kind: 'message', message: text('for bob') })))
    const letter = open(bob, envelope)
    expect(letter.kind === 'message' && firstText(letter.message)).toBe('for bob')

    expect(() => open(carol, envelope)).toThrow(/another agent/)
    // Carol relabels it as hers to open: the key no longer matches.
    expect(() => open(carol, { ...envelope, to: carol.publicKey })).toThrow()
    // A mailbox can't redirect it, or claim another sender.
    expect(() => open(bob, { ...envelope, from: carol.publicKey })).toThrow()
    const tampered = Buffer.from(envelope.sealed)
    tampered[0]! ^= 1
    expect(() => open(bob, { ...envelope, sealed: tampered })).toThrow()
  })
})

describe('the outbox', () => {
  it('keeps waiting posts apart from finished ones, and prunes old finished ones', async () => {
    const { mkdtemp, readdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'pai-outbox-'))
    try {
      const outbox = new OutboxStore(dir)
      await outbox.ready()
      const post = (id: string, state: Post['state'], updatedAt: number): Post => ({ id, to: 'b'.repeat(64), kind: 'message', body: text(id), state, createdAt: updatedAt, updatedAt })
      await outbox.put(post('waiting', 'queued', 1))
      await outbox.put(post('old', 'queued', 2))
      await outbox.put(post('old', 'delivered', 3))
      await outbox.put(post('recent', 'deposited', Date.now()))

      expect((await outbox.queued()).map((p) => p.id)).toEqual(['waiting'])
      expect((await outbox.all()).map((p) => p.id)).toEqual(['waiting', 'old', 'recent'])
      expect(await readdir(join(dir, 'outbox', 'queued'))).toEqual(['waiting.json'])

      expect(await outbox.prune(Date.now() - 1000)).toBe(1)
      expect((await outbox.all()).map((p) => p.id)).toEqual(['waiting', 'recent'])
      expect(await outbox.get('old')).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('posting', () => {
  const { agent, tempdir } = useTestnet()
  const FAST = { mailInterval: 100, timeout: 1500 }

  const echo: MessageHandler = async (message, task) => {
    await task.update('TASK_STATE_WORKING')
    await task.update('TASK_STATE_COMPLETED', agentText(`got ${firstText(message)}`))
  }

  // The id an agent will have in this storage, before it ever starts.
  async function idIn (storage: string): Promise<Uint8Array> {
    return (await loadKeyPair(storage)).publicKey
  }

  async function postOf (pai: Pai, id: string): Promise<Post> {
    return (await pai.posts()).find((p) => p.id === id)!
  }

  it('delivers straight to a recipient that is online', async () => {
    const bob = await agent('bob', { handler: echo })
    const alice = await agent('alice', { options: FAST })
    const post = await alice.post(bob.id, text('hi'))
    await waitFor(async () => (await postOf(alice, post.id)).state === 'delivered', 15_000, 'delivery')
    expect((await postOf(alice, post.id)).taskId).toBeTruthy()
  })

  it('leaves mail at a mailbox for an offline recipient, and the reply comes back the same way', async () => {
    const mailbox = await agent('mailbox', { options: { serveMailbox: true } })
    const mailboxes = [mailbox.id]
    const bobStorage = await tempdir('bob')
    const bobId = await idIn(bobStorage)

    // Bob is offline: alice's post goes to the mailbox.
    const aliceStorage = await tempdir('alice')
    let alice = await agent('alice', { storage: aliceStorage, manual: true, options: { ...FAST, mailboxes } })
    const post = await alice.post(bobId, text('while you were out'))
    await waitFor(async () => (await postOf(alice, post.id)).state === 'deposited', 15_000, 'the deposit')
    await alice.close()

    // Bob comes online with alice gone: he collects, runs it, and mails back.
    let ran = 0
    const bob = await agent('bob', { storage: bobStorage, options: { ...FAST, mailboxes }, handler: async (m, t) => { ran++; await echo(m, t) } })
    await waitFor(() => ran === 1, 15_000, 'bob to run the message')
    await waitFor(async () => (await bob.posts()).some((p) => p.kind === 'task' && p.state === 'deposited'), 15_000, 'bob\'s reply at the mailbox')

    // Alice comes back and finds the result.
    alice = await agent('alice', { storage: aliceStorage, options: { ...FAST, mailboxes } })
    await waitFor(async () => (await postOf(alice, post.id)).task?.status.state === 'TASK_STATE_COMPLETED', 15_000, 'the reply')
    expect(firstText((await postOf(alice, post.id)).task?.status.message)).toBe('got while you were out')
    expect(ran).toBe(1)
  })

  it('keeps a post queued, with the reason, when nothing can take it', async () => {
    const bobId = await idIn(await tempdir('bob'))
    const alice = await agent('alice', { options: FAST })
    const post = await alice.post(bobId, text('nobody home'))
    await waitFor(async () => (await postOf(alice, post.id)).lastError !== undefined, 15_000, 'a first attempt')
    const after = await postOf(alice, post.id)
    expect(after.state).toBe('queued')
    expect(after.lastError).toMatch(/no mailbox configured/)
  })

  it('a mailbox only takes envelopes from their sender, and hands them only to their recipient', async () => {
    const mailbox = await agent('mailbox', { options: { serveMailbox: true } })
    const carol = await agent('carol')
    const bob = await agent('bob')
    const viaCarol = await carol.connect(mailbox.id)

    // Carol deposits an envelope someone else sealed.
    const stranger = HyperDHT.keyPair()
    const forged = Buffer.from(encodeEnvelope(seal(stranger, bob.id, { kind: 'message', message: text('forged') }))).toString('base64url')
    await expect(viaCarol.rpc.request(MAILBOX_METHODS.deposit, { to: Buffer.from(bob.id).toString('hex'), envelope: forged })).rejects.toThrow(/not from this agent/)

    // Alice really leaves mail for an agent that's offline; carol sees none of it.
    const alice = await agent('alice', { options: { ...FAST, mailboxes: [mailbox.id] } })
    const post = await alice.post(await idIn(await tempdir('away')), text('for someone else'))
    await waitFor(async () => (await postOf(alice, post.id)).state === 'deposited', 15_000, 'the deposit')
    expect(await viaCarol.rpc.request(MAILBOX_METHODS.collect, {})).toEqual({ envelopes: [] })

    // A plain agent isn't a mailbox.
    const plain = await carol.connect(bob.id)
    await expect(plain.rpc.request(MAILBOX_METHODS.collect, {})).rejects.toThrow(/not a mailbox/)
  })
})
