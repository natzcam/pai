// The worklet under Bare, end to end: built as the phone builds it, run
// by bare-sidecar's Bare with its IPC on fd 3 (as react-native-bare-kit
// wires it), joined to an admin running here in Node over a DHT testnet.
import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Duplex } from 'node:stream'
import { beforeAll, describe, expect, it } from 'vitest'
import { GroupIdentity, createGroup, createIdentity } from '../../../src/identity/group.js'
import { loadKeyPair } from '../../../src/store/key-file.js'
import { useTestnet, waitFor } from '../../../test/helpers.js'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(here, 'package.json'))
// Bare comes with the worklet's own install (cd mobile/worklet && npm
// install); without it this test is skipped.
const sidecar = ((): string | null => { try { return dirname(require.resolve('bare-sidecar/package')) } catch { return null } })()
const bare = sidecar === null ? '' : join(sidecar, 'prebuilds', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'bare.exe' : 'bare')

// Talks to the worklet as the app does.
class App {
  #next = 1
  #waiting = new Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>()
  changes: any[] = []

  constructor (readonly child: ChildProcess, ipc: Duplex) {
    let buffered = ''
    ipc.setEncoding('utf-8')
    ipc.on('error', () => {})
    // The worklet died: nothing will answer.
    child.on('exit', (code) => {
      for (const w of this.#waiting.values()) w.reject(new Error(`The worklet exited (${code})`))
      this.#waiting.clear()
    })
    ipc.on('data', (s: string) => {
      buffered += s
      let nl: number
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buffered.slice(0, nl))
        buffered = buffered.slice(nl + 1)
        if (msg.event === 'change') { this.changes.push(msg.status); continue }
        const w = this.#waiting.get(msg.id)
        this.#waiting.delete(msg.id)
        if (msg.error !== undefined) w?.reject(new Error(msg.error))
        else w?.resolve(msg.result)
      }
    })
    this.write = (line) => { ipc.write(line) }
  }

  write: (line: string) => void

  async call (method: string, params: object = {}): Promise<any> {
    const id = this.#next++
    return await new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject })
      this.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
}

describe.skipIf(sidecar === null)('the worklet under Bare (needs mobile/worklet\'s npm install)', () => {
  const { agent, tempdir, bootstrap } = useTestnet()

  beforeAll(() => {
    execFileSync(process.execPath, [join(here, 'scripts/build.mjs'), 'src/worklet.ts'], { stdio: 'inherit' })
  }, 60_000)

  it('joins an identity and finishes a job, from Bare', async () => {
    const storage = await tempdir('admin')
    const keyPair = await loadKeyPair(storage)
    const keys = await createIdentity({ storage, keyPair, name: 'boss' })
    const entry = await createGroup({ storage, keys, keyPair, name: 'team', member: 'boss' })
    const boss = new GroupIdentity({ storage, keys, groups: [entry] })
    await agent('admin', { storage, identity: boss })
    const team = boss.group()

    const child = spawn(bare, [join(here, 'dist/worklet.cjs')], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] })
    const exited = new Promise((resolve) => child.on('exit', resolve))
    const app = new App(child, child.stdio[3] as Duplex)
    try {
      const dir = await tempdir('phone')
      expect(await app.call('init', { dir, bootstrap: bootstrap(), timeout: 20_000 })).toMatchObject({ joined: false })
      await expect(app.call('inbox')).rejects.toThrow(/hasn't joined/)
      await expect(app.call('nope')).rejects.toThrow(/No such method/)

      const { code } = await boss.inviteDevice()
      const joined = await app.call('join', { code, name: 'pocket' })
      expect(joined.status).toMatchObject({ joined: true, running: true, identity: boss.self })
      expect(joined.secrets).toMatchObject({ pai: 'phone/1', name: 'pocket' })
      await waitFor(() => app.changes.some((s) => s.writable), 30_000)

      const job = await team.postJob({ text: 'ship it?' }, { to: boss.self })
      await waitFor(async () => (await app.call('inbox')).open.some((j: any) => j.id === job.id), 30_000)
      expect(await app.call('take', { id: job.id })).toMatchObject({ mine: true, input: 'ship it?' })
      await app.call('finish', { id: job.id, state: 'done', text: 'shipped' })
      await waitFor(async () => (await team.getJob(job.id))?.state === 'done', 30_000)
      expect((await team.getJob(job.id))?.result).toBe('shipped')
    } finally {
      child.kill('SIGTERM')
      await exited
    }
  }, 150_000)
})
