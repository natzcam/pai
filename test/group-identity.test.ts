import { randomBytes } from 'node:crypto'
import BlindPairing from 'blind-pairing'
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import { describe, expect, it } from 'vitest'
import { PaiConnectionError } from '../src/errors.js'
import { groupId, groupNamespace, localWriter, storeDir } from '../src/group/base.js'
import { DeviceBase } from '../src/devices/base.js'
import type { GroupMembership } from '../src/group/membership.js'
import { GroupIdentity, createGroup, createIdentity, joinDevice, joinGroup } from '../src/identity/group.js'
import type { GroupEntry, IdentityKeys } from '../src/identity/group.js'
import { loadKeyPair } from '../src/store/key-file.js'
import type { Pai } from '../src/pai.js'
import type { MessageHandler } from '../src/server.js'
import { agentText, firstText, messageOf, taskOf, text, useTestnet, waitFor } from './helpers.js'
import type { Message } from '../src/a2a/types.js'

interface Agent { pai: Pai, identity: GroupIdentity, keys: IdentityKeys, entry: GroupEntry, group: GroupMembership, storage: string }

describe('GroupIdentity', () => {
  const { agent, tempdir, bootstrap } = useTestnet()

  const echo = async (message: Message): Promise<Message> => agentText(`echo: ${firstText(message)}`)

  // A new group (`title`), with an admin agent running it.
  async function admin (name = 'admin', title = 'team'): Promise<Agent> {
    const storage = await tempdir(name)
    const keyPair = await loadKeyPair(storage)
    const keys = await createIdentity({ storage, keyPair, name })
    const entry = await createGroup({ storage, keys, keyPair, name: title, member: name })
    const identity = new GroupIdentity({ storage, keys, groups: [entry] })
    const pai = await agent(name, { storage, identity, handler: echo })
    return { pai, identity, keys, entry, group: identity.group(), storage }
  }

  // Redeems `code` in a new folder (a new identity) and starts the agent.
  async function joiner (name: string, code: string, handler: MessageHandler = echo, opts: { manual?: boolean } = {}): Promise<Agent> {
    const storage = await tempdir(name)
    const keyPair = await loadKeyPair(storage)
    const keys = await createIdentity({ storage, keyPair, name })
    const entry = await joinGroup({ storage, keyPair, code, name, keys, bootstrap: bootstrap(), timeout: 20_000 })
    const identity = new GroupIdentity({ storage, keys, groups: [entry] })
    const pai = await agent(name, { storage, identity, handler, ...(opts.manual ? { manual: true } : {}) })
    return { pai, identity, keys, entry, group: identity.group(), storage }
  }

  it('admits an agent through an invite, and drops it when removed', async () => {
    const boss = await admin()
    const { code } = await boss.group.invite()
    const worker = await joiner('worker', code)
    const workerId = worker.identity.self
    expect(workerId).not.toBe(hex(worker.pai.id)) // an identity, not the device
    expect(boss.group.roster().members.find((m) => m.id === workerId)?.name).toBe('worker')
    // The code carried the group's own name: the joiner's name for it.
    expect(worker.group.name).toBe('team')
    expect(worker.group.id).toBe(boss.group.id)

    const peer = await worker.pai.connect(boss.pai.id)
    expect(firstText(messageOf(await peer.send(text('hi'))))).toBe('echo: hi')
    const back = await boss.pai.connect(worker.pai.id)
    expect(firstText(messageOf(await back.send(text('yo'))))).toBe('echo: yo')

    // The worker's one device signs its identity.
    expect(worker.identity.own.state.signers).toEqual([hex(worker.identity.own.writerKey)])

    await boss.group.act({ type: 'member.remove', id: workerId })
    await waitFor(() => peer.closed)
    // Refused outright on a new connection, or (while Hyperswarm backs off
    // redialing) a timeout that says it was refused.
    await expect(worker.pai.connect(boss.pai.id)).rejects.toThrow(/refused/)
    // The invite was used up.
    expect(boss.group.roster().invites).toEqual([])
  }, 60_000)

  it('lets a seed holder outside the roster sync but not call, until an admin adds it', async () => {
    const boss = await admin()
    const storage = await tempdir('outsider')
    const keyPair = await loadKeyPair(storage)
    const keys = await createIdentity({ storage, keyPair })
    const identity = new GroupIdentity({ storage, keys, groups: [{ ...boss.entry, slot: 'outsider' }] })
    const outsider = await agent('outsider', { storage, identity, handler: echo, options: { timeout: 3000 } })

    const err = await outsider.connect(boss.pai.id).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PaiConnectionError)
    expect((err as Error).message).toMatch(/not admitted/)

    await boss.group.act({ type: 'member.add', id: identity.self, writer: hex(identity.group().base.writerKey) })
    await waitFor(() => identity.admits(boss.pai.id) === true && boss.identity.admits(outsider.id) === true)
    const peer = await outsider.connect(boss.pai.id)
    expect(firstText(messageOf(await peer.send(text('let me in'))))).toBe('echo: let me in')
  }, 60_000)

  it('never admits a device its claimed identity doesn\'t list', async () => {
    const boss = await admin()
    // Claims the admin's identity without its key: refused.
    const forger = await tempdir('forger')
    const claim = new GroupIdentity({ storage: forger, keys: { identity: boss.keys.identity, secret: randomBytes(32) }, groups: [boss.entry] })
    const fake = await agent('forger', { storage: forger, identity: claim, handler: echo, options: { timeout: 4000 } })
    await expect(fake.connect(boss.pai.id)).rejects.toThrow(/refused/)
    expect(boss.identity.admits(fake.id)).not.toBe(true)

    // With the key, but a device the identity doesn't list: held.
    const storage = await tempdir('impostor')
    const identity = new GroupIdentity({ storage, keys: boss.keys, groups: [boss.entry] })
    const impostor = await agent('impostor', { storage, identity, handler: echo, options: { timeout: 4000 } })
    await expect(impostor.connect(boss.pai.id)).rejects.toThrow(/not admitted/)
    expect(boss.identity.admits(impostor.id)).toBe('pending')
  }, 60_000)

  // A second device for `of`'s identity: its writers, vouched for in both
  // bases by `of`, then started with the same groups.
  async function secondDevice (of: Agent, name: string): Promise<{ pai: Pai, identity: GroupIdentity, device: string }> {
    const storage = await tempdir(name)
    const device = hex((await loadKeyPair(storage)).publicKey)
    const store = new Corestore(storeDir(storage))
    const replica = new DeviceBase(store, of.identity.own.key)
    await replica.ready()
    const identityWriter = hex(replica.writerKey)
    await replica.close()
    const groupWriter = hex(await localWriter(store, groupNamespace(of.entry.slot)))
    await store.close()
    await of.identity.own.append({ type: 'device.add', device, writer: identityWriter, name })
    // A joiner's copy of the roster lists it, and lets it write, only once
    // it has synced.
    await waitFor(() => of.group.base.writable && of.group.roster().members.some((m) => m.id === of.identity.self), 15_000, 'a writable roster that lists this identity')
    await of.group.addDevice(device, groupWriter)
    const identity = new GroupIdentity({ storage, keys: of.keys, groups: [of.entry] })
    const pai = await agent(name, { storage, identity, handler: echo })
    return { pai, identity, device }
  }

  it('admits a second device once its identity lists it', async () => {
    const boss = await admin()
    const first = await joiner('laptop', (await boss.group.invite()).code)
    const phone = await secondDevice(first, 'phone')
    const peer = await phone.pai.connect(boss.pai.id)
    expect(firstText(messageOf(await peer.send(text('from my phone'))))).toBe('echo: from my phone')
    expect(phone.identity.self).toBe(first.identity.self)
    await waitFor(() => phone.identity.group().base.writable && phone.identity.own.writable)
  }, 60_000)

  it('an admin\'s second device signs too, and a removed one loses its group writer', async () => {
    const boss = await admin()
    await joiner('worker', (await boss.group.invite()).code)
    const tablet = await secondDevice(boss, 'tablet')
    await waitFor(() => tablet.identity.group().base.writable && tablet.identity.own.writable, 20_000)
    // The tablet signs the boss's identity too, once it has said hello.
    await waitFor(() => boss.identity.own.state.signers.length === 2, 20_000)
    const before = boss.group.base.base.length
    await new Promise((resolve) => setTimeout(resolve, 3000))
    expect(boss.group.base.base.length - before).toBeLessThan(10)

    // The tablet leaves the identity; its group writer is retired.
    await boss.identity.own.append({ type: 'device.remove', device: tablet.device })
    await waitFor(() => boss.group.roster().members.find((m) => m.id === boss.identity.self)!.writers.length === 1, 20_000)
    await waitFor(() => boss.identity.own.state.signers.length === 1, 20_000)
  }, 90_000)

  it('adds a device once: it gets every group, a later one too, and goes again when removed', async () => {
    const boss = await admin()
    const other = await admin('other', 'side')
    const worker = await joiner('worker', (await boss.group.invite()).code)
    const { code } = await worker.identity.inviteDevice()
    const storage = await tempdir('worker-phone')
    const keys = await joinDevice({ storage, keyPair: await loadKeyPair(storage), code, name: 'phone', bootstrap: bootstrap(), timeout: 20_000 })
    expect(hex(keys.identity)).toBe(worker.identity.self)
    expect(hex(keys.secret)).toBe(hex(worker.keys.secret))
    // In no group yet: it learns them from the worker's device.
    const kept: GroupEntry[][] = []
    const identity = new GroupIdentity({ storage, keys, groups: [], onGroups: (groups) => { kept.push(groups) } })
    const phone = await agent('worker-phone', { storage, identity, handler: echo })
    await waitFor(() => identity.groups().length === 1 && identity.group().base.writable, 30_000)
    expect(identity.group().id).toBe(boss.group.id)
    expect(kept.at(-1)?.map((g) => g.name)).toEqual(['team'])
    const peer = await phone.connect(boss.pai.id)
    expect(firstText(messageOf(await peer.send(text('new phone'))))).toBe('echo: new phone')
    // The code was used up.
    const again = await tempdir('worker-tablet')
    await expect(joinDevice({ storage: again, keyPair: await loadKeyPair(again), code, bootstrap: bootstrap(), timeout: 6000 })).rejects.toThrow(/Nobody answered/)

    // A group the worker joins later reaches the phone.
    const side = await worker.identity.joinGroup((await other.group.invite()).code, { member: 'worker', timeout: 20_000 })
    expect(side.name).toBe('side')
    await waitFor(() => identity.groups().length === 2 && identity.group('side').base.writable, 30_000)
    const call = await phone.connect(other.pai.id)
    expect(firstText(messageOf(await call.send(text('both'))))).toBe('echo: both')

    await worker.identity.removeDevice(hex(phone.id))
    await waitFor(() => peer.closed, 20_000)
    await expect(worker.identity.removeDevice(hex(worker.pai.id))).rejects.toThrow(/device you're on/)
  }, 120_000)

  it('is in two groups: either admits it, each task is shared in one, policy counts per group', async () => {
    const tasky = async (message: Message, t: any): Promise<void> => {
      await t.update('TASK_STATE_WORKING')
      await t.update('TASK_STATE_COMPLETED', agentText(`done: ${firstText(message)}`))
    }
    const boss = await admin()
    const other = await admin('other', 'side')
    const worker = await joiner('worker', (await boss.group.invite()).code, tasky)
    await worker.identity.joinGroup((await other.group.invite()).code, { member: 'worker', timeout: 20_000 })
    expect(worker.identity.groups().map((g) => g.name)).toEqual(['team', 'side'])
    expect(groupId(worker.entry.seed)).toBe(boss.group.id)

    // Both groups' admins reach it, each through its own group.
    const fromBoss = await boss.pai.connect(worker.pai.id)
    const fromOther = await other.pai.connect(worker.pai.id)

    // A task is shared in the group both sides are in: only its members read it.
    const inTeam = taskOf(await fromBoss.send(text('team work')))
    expect(inTeam.status.state).toBe('TASK_STATE_COMPLETED')
    expect(inTeam.metadata?.['pai/group']).toBe(boss.group.id)
    await waitFor(async () => (await boss.identity.tasks()!.getOf(worker.identity.self, inTeam.id)) !== null, 20_000)
    expect(await other.identity.tasks()!.getOf(worker.identity.self, inTeam.id)).toBeNull()
    await expect(fromOther.getTask(inTeam.id)).rejects.toThrow(/not found/i)
    expect((await fromOther.listTasks()).tasks.map((t) => t.id)).not.toContain(inTeam.id)

    // A message naming a group both are in is shared there.
    const inSide = taskOf(await fromOther.send(text('side work', { metadata: { 'pai/group': other.group.id } })))
    expect(inSide.metadata?.['pai/group']).toBe(other.group.id)
    expect((await fromOther.getTask(inSide.id)).id).toBe(inSide.id)

    // The side group's policy denies its members calling the worker; the
    // team's still lets the boss.
    await other.group.act({ type: 'policy.set', rule: { name: 'quiet', from: '*', to: worker.identity.self, allow: false } })
    await waitFor(() => worker.identity.group('side').base.roster.policy.length === 1, 20_000)
    await expect(fromOther.send(text('now?'))).rejects.toThrow(/policy/)
    expect(taskOf(await fromBoss.send(text('still'))).status.state).toBe('TASK_STATE_COMPLETED')
  }, 120_000)

  it('keeps running its other groups when it was removed from one, and keeps that one\'s keys', async () => {
    const boss = await admin()
    const other = await admin('other', 'side')
    const worker = await joiner('worker', (await boss.group.invite()).code, echo, { manual: true })
    await worker.identity.joinGroup((await other.group.invite()).code, { member: 'worker', timeout: 20_000 })
    const side = worker.identity.group('side')
    await waitFor(() => side.base.writable, 20_000)
    await other.group.act({ type: 'member.remove', id: worker.identity.self })
    await waitFor(() => side.base.roster.removed.includes(worker.identity.self), 20_000)
    const entries = worker.identity.groups().map((g) => g.entry)
    await worker.pai.close()

    // Back: the side group won't open, the team still runs, and both are kept.
    const kept: GroupEntry[][] = []
    const identity = new GroupIdentity({ storage: worker.storage, keys: worker.keys, groups: entries, onGroups: (groups) => { kept.push(groups) } })
    const again = await agent('worker-again', { storage: worker.storage, identity, handler: echo })
    expect(identity.groups().map((g) => g.name)).toEqual(['team'])
    expect(identity.unopened()).toMatchObject([{ name: 'side', problem: expect.stringMatching(/removed from the group/) }])
    expect(identity.problem).toMatch(/^side: /)
    const peer = await again.connect(boss.pai.id)
    expect(firstText(messageOf(await peer.send(text('still in the team'))))).toBe('echo: still in the team')
    await identity.createGroup('more')
    expect(kept.at(-1)?.map((g) => g.name).sort()).toEqual(['more', 'side', 'team'])
  }, 90_000)

  it('delivers a durable send to an identity through one of its devices, and refuses re-adding a device', async () => {
    const boss = await admin()
    const worker = await joiner('worker', (await boss.group.invite()).code)
    const post = await boss.pai.post(Buffer.from(worker.identity.self, 'hex'), text('later'))
    await waitFor(async () => (await boss.pai.posts()).find((p) => p.id === post.id)?.state === 'delivered', 20_000)

    // The worker's own device can't redeem a device invite for itself.
    const { code } = await worker.identity.inviteDevice()
    const storage = await tempdir('again')
    const keyPair = { publicKey: worker.pai.id, secretKey: (await loadKeyPair(worker.pai.options.storage)).secretKey }
    await expect(joinDevice({ storage, keyPair, code, bootstrap: bootstrap(), timeout: 8000 })).rejects.toThrow()
  }, 60_000)

  it('routes calls to an identity: any device, follow-ups to the task\'s device, tasks merged', async () => {
    const boss = await admin()
    // Two devices of one identity, each answering with a task that says
    // which device ran it.
    const tasky = (name: string) => async (message: Message, task: any) => {
      await task.update('TASK_STATE_WORKING')
      await task.artifact({ artifactId: 'out', parts: [{ text: `${name}: ${firstText(message)}` }] })
      await task.update('TASK_STATE_COMPLETED')
    }
    const laptopAgent = await joiner('laptop', (await boss.group.invite()).code, tasky('laptop'), { manual: true })
    const laptop = laptopAgent.pai
    const phone = await secondDevice(laptopAgent, 'phone')
    phone.pai.onMessage(tasky('phone'))
    const who = Buffer.from(laptopAgent.identity.self, 'hex')
    await waitFor(() => boss.pai.devicesOf(who).length === 2, 20_000)

    // One task on each device, made through the identity's own devices.
    const onLaptop = taskOf(await (await boss.pai.connect(laptop.id)).send(text('a')))
    const onPhone = taskOf(await (await boss.pai.connect(phone.pai.id)).send(text('b')))
    expect(onLaptop.id.startsWith(hex(laptop.id).slice(0, 16) + '.')).toBe(true)

    const w = boss.pai.agent(who)
    expect(outText(await w.getTask(onPhone.id))).toBe('phone: b')
    expect(outText(await w.getTask(onLaptop.id))).toBe('laptop: a')
    const listed = await w.listTasks({ pageSize: 1 })
    expect(listed.tasks).toHaveLength(1)
    const rest = await w.listTasks({ pageSize: 1, pageToken: listed.nextPageToken })
    expect([listed.tasks[0]!.id, rest.tasks[0]!.id].sort()).toEqual([onLaptop.id, onPhone.id].sort())
    expect(rest.nextPageToken).toBe('')

    // A call to the identity reaches whichever device is there.
    await laptop.close()
    await waitFor(() => boss.pai.devicesOf(who).length === 1, 20_000)
    expect(outText(taskOf(await w.send(text('c'))))).toBe('phone: c')
  }, 90_000)

  it('shares tasks with the group: any member reads them, owners and admins control them, siblings take them up', async () => {
    const boss = await admin()
    // Asks for more input, then finishes on the next message.
    const asker = (name: string) => async (message: Message, task: any) => {
      const resumed = (task.task.history?.length ?? 0) > 1
      await task.update('TASK_STATE_WORKING')
      if (resumed) {
        await task.artifact({ artifactId: 'out', parts: [{ text: `${name} finished: ${firstText(message)}` }] })
        await task.update('TASK_STATE_COMPLETED')
      } else {
        await task.update('TASK_STATE_INPUT_REQUIRED', agentText('more?'))
      }
    }
    const workerAgent = await joiner('worker', (await boss.group.invite()).code, asker('laptop'), { manual: true })
    const worker = workerAgent.pai
    const workerIdentity = workerAgent.identity
    const phone = await secondDevice(workerAgent, 'worker-phone')
    phone.pai.onMessage(asker('phone'))
    const client = await joiner('client', (await boss.group.invite()).code)
    const nosy = await joiner('nosy', (await boss.group.invite()).code)
    const who = Buffer.from(workerIdentity.self, 'hex')

    // The client starts a task on the laptop; it waits for input.
    const task = taskOf(await (await client.pai.connect(worker.id)).send(text('start')))
    expect(task.status.state).toBe('TASK_STATE_INPUT_REQUIRED')

    // Another member, not its creator, reads it from its replica, also once
    // the laptop is gone.
    await waitFor(async () => (await nosy.identity.tasks()!.getOf(workerIdentity.self, task.id))?.task.status.state === 'TASK_STATE_INPUT_REQUIRED', 20_000)
    await worker.close()
    await waitFor(() => nosy.pai.devicesOf(who).every((p) => hex(p.record.id) !== hex(worker.id)), 20_000)
    expect((await nosy.pai.agent(who).getTask(task.id)).status.state).toBe('TASK_STATE_INPUT_REQUIRED')
    expect((await nosy.pai.agent(who).listTasks()).tasks.map((t) => t.id)).toContain(task.id)

    // Only its creator (or an admin) may act on it.
    await waitFor(() => nosy.pai.devicesOf(who).length === 1, 20_000)
    await expect(nosy.pai.agent(who).cancelTask(task.id)).rejects.toThrow(/Only the agent that created/)

    // The creator continues it; the phone takes it up from the group's copy.
    const done = taskOf(await client.pai.agent(who).send(text('go on', { taskId: task.id, contextId: task.contextId })))
    expect(done.status.state).toBe('TASK_STATE_COMPLETED')
    expect(outText(done)).toBe('phone finished: go on')

    // An admin may cancel a task it didn't create.
    const waiting = taskOf(await client.pai.agent(who).send(text('another')))
    expect((await boss.pai.agent(who).cancelTask(waiting.id)).status.state).toBe('TASK_STATE_CANCELED')
  }, 120_000)

  it('refuses calls the group\'s policy denies, by role or by id', async () => {
    const boss = await admin()
    const worker = await joiner('worker', (await boss.group.invite({ roles: ['worker'] })).code)
    expect(boss.group.roster().members.find((m) => m.id === worker.identity.self)?.roles).toEqual(['worker'])
    await boss.group.act({ type: 'policy.set', rule: { name: 'workers-only-answer', from: 'role:worker', to: 'role:admin', allow: false } })
    await waitFor(() => worker.group.base.roster.policy.length === 1)
    const peer = await worker.pai.connect(boss.pai.id)
    await expect(peer.send(text('hi'))).rejects.toThrow(/policy/)
    // The other way is allowed (no rule names it).
    const back = await boss.pai.connect(worker.pai.id)
    expect(firstText(messageOf(await back.send(text('yo'))))).toBe('echo: yo')
    // A rule naming the worker beats the role rule.
    await boss.group.act({ type: 'policy.set', rule: { name: 'this-one', from: worker.identity.self, to: '*', allow: true } })
    expect(firstText(messageOf(await peer.send(text('now?'))))).toBe('echo: now?')
  }, 60_000)

  it('rotates the seed: members move on, devices that missed it and new joiners catch up, a removed member is shut out', async () => {
    const boss = await admin()
    const worker = await joiner('worker', (await boss.group.invite()).code)
    const ex = await joiner('ex', (await boss.group.invite()).code)
    // The worker is offline through the rotation.
    await worker.pai.close()
    await boss.group.act({ type: 'member.remove', id: ex.identity.self })
    await boss.group.rotateSeed() // one admin: passes at once
    expect(boss.group.roster().seed.epoch).toBe(1)
    expect(boss.group.epoch).toBe(1)
    expect(Object.keys(boss.group.roster().seed.boxes)).not.toContain(hex(ex.pai.id))

    // Back, it finds the admin on the first topic and catches up.
    const identity = new GroupIdentity({ storage: worker.storage, keys: worker.keys, groups: [worker.entry] })
    const again = await agent('worker-again', { storage: worker.storage, identity, handler: echo })
    await waitFor(() => identity.group().epoch === 1, 30_000)
    expect(identity.group().topic.equals(boss.group.topic)).toBe(true)
    const peer = await again.connect(boss.pai.id)
    expect(firstText(messageOf(await peer.send(text('still here'))))).toBe('echo: still here')

    // A new member gets only the first seed when it joins, and an empty
    // roster: it lets the admin (a later epoch) sync it, then catches up.
    // The removed member is offline, so it can't be what helps.
    const exProof = (to: Uint8Array): Uint8Array => ex.identity.proof({ handshakeHash: Buffer.alloc(32, 7), localPublicKey: ex.pai.id, remotePublicKey: to })
    await ex.pai.close()
    const late = await joiner('late', (await boss.group.invite()).code)
    await waitFor(() => late.group.epoch === 1, 30_000)
    const call = await late.pai.connect(boss.pai.id)
    expect(firstText(messageOf(await call.send(text('late'))))).toBe('echo: late')

    // The removed member proves only the first seed: the roster no longer
    // vouches for it, on the admin or on the new member.
    for (const side of [boss, late]) {
      const ctx = { handshakeHash: Buffer.alloc(32, 7), localPublicKey: side.pai.id, remotePublicKey: ex.pai.id }
      expect(await side.identity.authenticate(ctx, exProof(side.pai.id))).toBe(true) // the first seed checks out...
      expect(side.identity.admits(ex.pai.id)).toBe(false) // ...but that's all
    }
  }, 120_000)

  it('won\'t admit a join signed for another device, and refuses ops the rules would skip', async () => {
    const boss = await admin()
    const { code } = await boss.group.invite()
    // A candidate claiming the admin's id, without its key.
    const swarm = new Hyperswarm({ bootstrap: bootstrap() })
    const pairing = new BlindPairing(swarm, { poll: 1000 })
    let confirmed = false
    pairing.addCandidate({
      invite: Buffer.from(code.split('.')[0]!, 'base64url'),
      userData: Buffer.from(JSON.stringify({ identity: 'ef'.repeat(32), device: hex(boss.pai.id), writer: 'ab'.repeat(32), sig: 'cd'.repeat(32) })),
      onadd: () => { confirmed = true }
    })
    await new Promise((resolve) => setTimeout(resolve, 4000))
    await pairing.close()
    await swarm.destroy()
    expect(confirmed).toBe(false)
    expect(boss.group.roster().invites).toHaveLength(1) // not used up by a forgery

    // The real redeemer still gets in.
    const worker = await joiner('worker', code)
    const workerId = worker.identity.self
    await expect(boss.group.act({ type: 'member.remove', id: boss.identity.self })).rejects.toThrow(/is an admin/)
    await expect(boss.group.act({ type: 'propose', pid: 'ef'.repeat(32), op: { type: 'admin.add', id: 'aa'.repeat(32) } })).rejects.toThrow(/not a member/)
    await expect(boss.group.act({ type: 'propose', pid: 'ef'.repeat(32), op: { type: 'admin.remove', id: boss.identity.self } })).rejects.toThrow(/last admin/)
    await expect(boss.group.act({ type: 'approve', pid: 'ef'.repeat(32) })).rejects.toThrow(/No open proposal/)
    await boss.group.act({ type: 'member.remove', id: workerId })
    await expect(boss.group.act({ type: 'member.remove', id: workerId })).rejects.toThrow(/not a member/)
  }, 60_000)

  it('refuses an expired invite, and a used one gets nobody in', async () => {
    const boss = await admin()
    const lapsed = await boss.group.invite({ expiresIn: -1 })
    const storage = await tempdir('late')
    const keyPair = await loadKeyPair(storage)
    const keys = await createIdentity({ storage, keyPair })
    await expect(joinGroup({ storage, keyPair, keys, code: lapsed.code, bootstrap: bootstrap() })).rejects.toThrow(/expired/)
    await expect(joinGroup({ storage, keyPair, keys, code: 'nonsense', bootstrap: bootstrap() })).rejects.toThrow(/not a pai invite/)

    const { code } = await boss.group.invite()
    await joiner('first', code)
    const second = await tempdir('second')
    const secondPair = await loadKeyPair(second)
    const secondKeys = await createIdentity({ storage: second, keyPair: secondPair })
    await expect(joinGroup({ storage: second, keyPair: secondPair, keys: secondKeys, code, bootstrap: bootstrap(), timeout: 8000 })).rejects.toThrow(/No group admin answered/)
  }, 60_000)
})

function outText (task: { artifacts?: Array<{ parts: unknown[] }> }): string | undefined {
  return (task.artifacts?.[0]?.parts[0] as { text?: string } | undefined)?.text
}

function hex (b: Uint8Array): string {
  return Buffer.from(b).toString('hex')
}
