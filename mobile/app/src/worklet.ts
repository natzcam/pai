// The app's side of pai's worklet (../worklet/src/ipc.ts): pai runs in a
// Bare worklet on its own thread, and this talks to it over the worklet's
// IPC, newline-delimited JSON. react-native-bare-kit suspends and resumes
// the worklet with the app.
import b4a from 'b4a'
import { Paths } from 'expo-file-system'
import { Worklet } from 'react-native-bare-kit'
import bundleBase64 from '../worklet/app.bundle'
import { forgetSecrets, loadSecrets, saveSecrets } from './secrets'
import type { FlowSummary, FlowView, Inbox, Job, Member, PhoneSecrets, Status } from './types'

type Pending = { resolve: (v: unknown) => void, reject: (e: Error) => void }

class Pai {
  #worklet: Worklet | null = null
  #next = 1
  #pending = new Map<number, Pending>()
  #buffered = ''
  #listeners = new Set<(status: Status) => void>()
  #ready: Promise<Status> | null = null

  // Starts the worklet (once) and pai in it; the status it starts with.
  init (): Promise<Status> {
    if (this.#ready) return this.#ready
    const worklet = new Worklet()
    worklet.start('/app.bundle', b4a.from(bundleBase64, 'base64'))
    worklet.IPC.on('data', (chunk: unknown) => { this.#onData(chunk as Uint8Array) })
    this.#worklet = worklet
    const dir = decodeURIComponent(Paths.document.uri.replace(/^file:\/\//, '')).replace(/\/$/, '') + '/pai'
    this.#ready = loadSecrets().then(async (secrets) => await this.call<Status>('init', { dir, secrets }))
    // Failed: the worklet goes too, so a retry starts a fresh one.
    this.#ready.catch(() => {
      this.#ready = null
      this.#worklet = null
      for (const p of this.#pending.values()) p.reject(new Error('pai stopped'))
      this.#pending.clear()
      worklet.terminate()
    })
    return this.#ready
  }

  onChange (listener: (status: Status) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  status = async (): Promise<Status> => await this.call('status')
  // Joins, then keeps the keys in the OS's key store. If they can't be
  // kept, the phone leaves again (or, with no other device reachable,
  // wipes itself and says which device to remove), rather than run on
  // keys it would lose. Joined but not started (startError): the status
  // says so, and start() tries again.
  join = async (code: string, name: string): Promise<Status> => {
    const { status, secrets } = await this.call<{ status: Status, secrets: PhoneSecrets, startError?: string }>('join', { code, name })
    try {
      await saveSecrets(secrets)
    } catch (err) {
      const left = await this.call('leave', {}, 90_000).then(() => true, async () => { await this.call('wipe').catch(() => {}); return false })
      throw new Error(`Couldn't keep this phone's keys (${(err as Error).message}), so it ${left ? 'left your identity again' : `was wiped; remove it from a computer with: pai device remove ${status.device ?? ''}`}.`)
    }
    return status
  }

  // Starts pai again (after a start that failed); the status after.
  start = async (): Promise<Status> => { await this.call('start'); return await this.status() }

  // Leaves the identity (another of its devices has to be running), or
  // just wipes this phone; either way its keys are forgotten.
  leave = async (): Promise<Status> => { const s = await this.call<Status>('leave', {}, 90_000); await forgetSecrets(); return s }
  wipe = async (): Promise<Status> => { const s = await this.call<Status>('wipe'); await forgetSecrets(); return s }
  inbox = async (): Promise<Inbox> => await this.call('inbox')
  jobs = async (): Promise<Job[]> => await this.call('jobs')
  members = async (): Promise<Member[]> => await this.call('members')
  take = async (id: string): Promise<{ job: Job, mine: boolean, input?: string }> => await this.call('take', { id })
  finish = async (id: string, state: 'done' | 'failed', text: string | null): Promise<Job | null> => await this.call('finish', { id, state, text })
  release = async (id: string): Promise<Job | null> => await this.call('release', { id })
  answer = async (id: string, text: string): Promise<Job> => await this.call('answer', { id, text })
  cancel = async (id: string): Promise<Job> => await this.call('cancel', { id })
  approve = async (pid: string): Promise<void> => { await this.call('approve', { pid }) }
  flows = async (): Promise<FlowSummary[]> => await this.call('flows')
  flow = async (id: string): Promise<FlowView | null> => await this.call('flow', { id })
  rerun = async (from: string, input: string): Promise<FlowView> => await this.call('rerun', { from, input })
  cancelFlow = async (id: string): Promise<void> => { await this.call('cancelFlow', { id }) }
  post = async (text: string, to: string | null, group: string | null): Promise<Job> => await this.call('post', { spec: { text }, ...(to ? { to } : {}), ...(group ? { group } : {}) })

  // A call pai never answers (a request it couldn't read) fails after
  // `timeout`; a join waits on the network, so it gets longer.
  async call<T> (method: string, params: object = {}, timeout = method === 'join' || method === 'init' ? 5 * 60_000 : 60_000): Promise<T> {
    if (!this.#worklet) throw new Error('pai has not started')
    const id = this.#next++
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`pai didn't answer (${method})`))
      }, timeout)
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); (resolve as (v: unknown) => void)(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      this.#worklet!.IPC.write(b4a.from(JSON.stringify({ id, method, params }) + '\n', 'utf8'))
    })
  }

  #onData (chunk: Uint8Array): void {
    this.#buffered += b4a.toString(chunk, 'utf8')
    let nl: number
    while ((nl = this.#buffered.indexOf('\n')) !== -1) {
      const line = this.#buffered.slice(0, nl)
      this.#buffered = this.#buffered.slice(nl + 1)
      if (line.trim() === '') continue
      const msg = JSON.parse(line) as { id?: number, result?: unknown, error?: string, event?: string, status?: Status, secrets?: PhoneSecrets }
      if (msg.event === 'change' && msg.status) {
        for (const l of this.#listeners) l(msg.status)
        continue
      }
      // A group learned from another device: its keys are kept with the
      // rest (else the phone would lose it on its next start, and learn it
      // again).
      if (msg.event === 'secrets' && msg.secrets) {
        saveSecrets(msg.secrets).catch(() => {})
        continue
      }
      const p = msg.id === undefined ? undefined : this.#pending.get(msg.id)
      if (!p) continue
      this.#pending.delete(msg.id!)
      if (msg.error !== undefined) p.reject(new Error(msg.error))
      else p.resolve(msg.result)
    }
  }
}

export const pai = new Pai()
