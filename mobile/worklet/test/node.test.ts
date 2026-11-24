import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GroupMembership } from '../../../src/group/membership.js'
import { GroupIdentity, createGroup, createIdentity } from '../../../src/identity/group.js'
import { loadKeyPair } from '../../../src/store/key-file.js'
import { useTestnet, waitFor } from '../../../test/helpers.js'
import { PhoneNode, choicesOf } from '../src/node.js'
import type { PhoneSecrets } from '../src/node.js'

describe('PhoneNode', () => {
  const { agent, tempdir, bootstrap } = useTestnet()

  async function admin (): Promise<{ identity: GroupIdentity, group: GroupMembership }> {
    const storage = await tempdir('admin')
    const keyPair = await loadKeyPair(storage)
    const keys = await createIdentity({ storage, keyPair, name: 'boss' })
    const entry = await createGroup({ storage, keys, keyPair, name: 'team', member: 'boss' })
    const identity = new GroupIdentity({ storage, keys, groups: [entry] })
    await agent('admin', { storage, identity })
    return { identity, group: identity.group() }
  }

  it('joins an identity as a device, and does a person\'s part of jobs from there', async () => {
    const boss = await admin()
    const dir = await tempdir('phone')
    const phone = new PhoneNode({ dir, bootstrap: bootstrap(), timeout: 20_000 })
    let secrets: PhoneSecrets | null = null
    let changes = 0
    phone.on('change', () => { changes++ })
    // The keys the app would keep, as they change.
    const kept: PhoneSecrets[] = []
    phone.on('secrets', (s: PhoneSecrets) => { kept.push(structuredClone(s)) })
    try {
      expect(await phone.start()).toBe(false) // not joined yet
      await expect(phone.inbox()).rejects.toThrow(/hasn't joined/)

      const { code } = await boss.identity.inviteDevice()
      const joined = await phone.join(code, 'pocket')
      expect(joined.status).toMatchObject({ joined: true, running: true, name: 'pocket', identity: boss.identity.self })
      secrets = joined.secrets
      expect(secrets).toMatchObject({ pai: 'phone/1', name: 'pocket', identity: boss.identity.self })
      // The keys are the app's to keep: no key files.
      await expect(access(join(dir, 'agent', 'agent.key'))).rejects.toThrow()
      // Its group comes from the identity's other device, and the app is
      // given the keys with it.
      await waitFor(() => phone.status().writable, 30_000)
      expect(phone.status().groups).toMatchObject([{ id: boss.group.id, name: 'team', writable: true }])
      expect(kept.at(-1)?.groups.map((g) => g.name)).toEqual(['team'])
      expect(changes).toBeGreaterThan(0)

      // A job for the identity: the phone takes it and finishes it.
      const job = await boss.group.postJob({ text: 'approve the draft?' }, { to: boss.identity.self })
      await waitFor(async () => (await phone.inbox()).open.some((j) => j.id === job.id), 20_000)
      const taken = await phone.take(job.id)
      expect(taken.mine).toBe(true)
      expect(taken.input).toBe('approve the draft?')
      expect((await phone.inbox()).held.map((j) => j.id)).toEqual([job.id])
      await phone.finish(job.id, 'done', 'approved')
      await waitFor(async () => (await boss.group.getJob(job.id))?.state === 'done', 20_000)
      expect((await boss.group.getJob(job.id))?.result).toBe('approved')

      // A question on a job the identity posted: answered from the phone.
      const asked = await boss.group.postJob({ text: 'write it' }, { to: boss.identity.self })
      await boss.group.claimJob(asked.id)
      await boss.group.askJob(asked.id, 1, 'which tone?')
      await waitFor(async () => (await phone.inbox()).questions.some((j) => j.id === asked.id), 20_000)
      await phone.answer(asked.id, 'friendly')
      await waitFor(async () => (await boss.group.getJob(asked.id))?.question?.answer === 'friendly', 20_000)

      // Only a job it holds can be finished from the phone.
      await expect(phone.finish(asked.id, 'done', 'x')).rejects.toThrow(/take it first/)
      await expect(phone.join(code, 'again')).rejects.toThrow(/already joined/)
      // Proposal ids are 64 hex characters: one reaches the group's check.
      await expect(phone.approve('ab'.repeat(32))).rejects.toThrow(/No open proposal/)
      await expect(phone.approve('ab'.repeat(16))).rejects.toThrow(/64 hex/)
    } finally {
      await phone.close()
    }

    // Restarted with its keys, it runs as the same device; without, it's
    // not joined.
    expect(await new PhoneNode({ dir }).start()).toBe(false)
    const again = new PhoneNode({ dir, secrets, bootstrap: bootstrap(), timeout: 20_000 })
    try {
      expect(await again.start()).toBe(true)
      expect(again.status().groups.map((g) => g.name)).toEqual(['team'])
      expect(again.status()).toMatchObject({ name: 'pocket', identity: boss.identity.self })
      const device = again.status().device!

      // A workflow: rerun from the phone with new input.
      const first = await boss.group.startFlow({ name: 'ask', steps: [{ name: 'check', to: boss.identity.self, text: 'Check {{input}}' }] }, 'one')
      await waitFor(async () => (await again.flows()).some((f) => f.id === first.id), 20_000)
      const rerun = await again.rerun(first.id, 'two')
      expect(rerun).toMatchObject({ name: 'ask', input: 'two' })

      // Leaving: removed from the identity (the admin's device confirms),
      // and its data gone.
      await again.leave()
      expect(again.status()).toMatchObject({ joined: false, running: false })
      await expect(access(join(dir, 'agent'))).rejects.toThrow()
      await waitFor(() => boss.identity.own.hasDevice(device) === false, 20_000)
    } finally {
      await again.close()
    }
  }, 120_000)

  it('reads a step\'s choices off the steps that test it', () => {
    const steps = [
      { name: 'draft', to: null, text: 'x' },
      { name: 'approve', to: null, text: 'x' },
      { name: 'publish', to: null, text: 'x', if: { step: 'approve', equals: 'approved' } },
      { name: 'announce', to: null, text: 'x', if: { step: 'approve', equals: 'approved' } },
      { name: 'hold', to: null, text: 'x', if: { step: 'approve', contains: 'later' } },
      { name: 'revise', to: null, text: 'x', if: { step: 'approve', equals: 'approved', not: true } },
      { name: 'rejected', to: null, text: 'x', if: { step: 'approve', failed: true as const } },
      { name: 'other', to: null, text: 'x', if: { step: 'draft', equals: 'x' } }
    ]
    expect(choicesOf({ steps }, 'approve')).toEqual({
      // 'later' isn't 'approved', so it starts revise too.
      answers: [{ text: 'approved', leadsTo: ['publish', 'announce'] }, { text: 'later', leadsTo: ['hold', 'revise'] }],
      otherwise: ['revise'],
      onFail: ['rejected']
    })
    expect(choicesOf({ steps }, 'publish')).toEqual({ answers: [], otherwise: [], onFail: [] })
    // A repeat that tests the step: its answer goes on, any other goes
    // round again (until the last round); one until a step stops failing
    // goes round again on a failure.
    const loop = [
      { name: 'draft', to: null, text: 'x' },
      { name: 'review', to: null, text: 'x', after: ['draft'], repeat: { from: 'draft', until: { step: 'review', equals: 'approved' }, max: 3 } },
      { name: 'publish', to: null, text: 'x', after: ['review'] }
    ]
    expect(choicesOf({ steps: loop }, 'review')).toEqual({ answers: [{ text: 'approved', leadsTo: ['publish'] }], otherwise: ['draft again'], onFail: [] })
    expect(choicesOf({ steps: loop, loops: { review: { round: 2, over: false } } }, 'review')).toEqual({ answers: [], otherwise: ['publish'], onFail: [] })
    const tests = [
      { name: 'fix', to: null, text: 'x' },
      { name: 'test', to: null, text: 'x', after: ['fix'], repeat: { from: 'fix', until: { step: 'test', failed: true as const, not: true }, max: 3 } }
    ]
    expect(choicesOf({ steps: tests }, 'test')).toEqual({ answers: [], otherwise: ['the end'], onFail: ['fix again'] })
    // A step that runs once the other's done, whatever its result.
    const after = [{ name: 'a', to: null, text: 'x' }, { name: 'log', to: null, text: 'x', if: { step: 'a', failed: true as const, not: true } }]
    expect(choicesOf({ steps: after }, 'a')).toEqual({ answers: [], otherwise: ['log'], onFail: [] })
  })
})
