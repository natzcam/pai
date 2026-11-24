// The app's line to the worklet: newline-delimited JSON over the
// worklet's IPC stream. The app sends requests, `{ id, method, params }`;
// the worklet answers each with `{ id, result }` or `{ id, error }`, and
// tells of changes on its own: `{ event: 'change', status }`, and
// `{ event: 'secrets', secrets }` when the keys change (a group learned
// from another device), for the app to keep.
//
// The first request is `init` with `{ dir, secrets }` (the app's folder for
// pai, the keys it keeps if the phone has joined, and optionally DHT
// `bootstrap` nodes): it makes the PhoneNode and starts it if joined.
// Every other method is one of PhoneNode's.

import { PhoneNode } from './node.js'
import type { PhoneNodeOptions } from './node.js'

export interface Duplex {
  on (event: 'data', listener: (chunk: Uint8Array | string) => void): unknown
  on (event: 'end' | 'close', listener: () => void): unknown
  write (data: string): unknown
}

type Params = Record<string, unknown>

// What the app may call, and how its params map onto PhoneNode's.
const METHODS: Record<string, (node: PhoneNode, p: Params) => Promise<unknown> | unknown> = {
  status: (n) => n.status(),
  start: async (n) => await n.start(),
  join: async (n, p) => await n.join(p.code as string, p.name as string),
  inbox: async (n) => await n.inbox(),
  jobs: async (n) => await n.jobs(),
  members: (n) => n.members(),
  job: async (n, p) => await n.job(p.id as string),
  take: async (n, p) => await n.take(p.id as string),
  finish: async (n, p) => await n.finish(p.id as string, p.state as 'done' | 'failed', (p.text ?? null) as string | null),
  release: async (n, p) => await n.release(p.id as string),
  answer: async (n, p) => await n.answer(p.id as string, p.text as string),
  cancel: async (n, p) => await n.cancel(p.id as string),
  post: async (n, p) => await n.post(p.spec as never, { ...(typeof p.to === 'string' ? { to: p.to } : {}), ...(typeof p.group === 'string' ? { group: p.group } : {}) }),
  approve: async (n, p) => { await n.approve(p.pid as string); return null },
  flows: async (n) => await n.flows(),
  flow: async (n, p) => await n.flow(p.id as string),
  rerun: async (n, p) => await n.rerun(p.from as string, p.input as string),
  cancelFlow: async (n, p) => { await n.cancelFlow(p.id as string); return null },
  leave: async (n) => { await n.leave(); return n.status() },
  wipe: async (n) => { await n.wipe(); return n.status() }
}

// Largest line accepted from the app (a job's spec is up to 16 KiB).
const MAX_LINE = 1024 * 1024

export function serve (stream: Duplex, make: (opts: PhoneNodeOptions) => PhoneNode = (o) => new PhoneNode(o)): { suspend: () => Promise<void>, resume: () => Promise<void>, close: () => Promise<void> } {
  let node: PhoneNode | null = null
  // Bytes until a newline (Bare has no TextDecoder; a newline byte never
  // falls inside a UTF-8 character, so lines split on it decode whole).
  let buffered = Buffer.alloc(0)
  // Past a line too long, until its end: dropped.
  let skipping = false

  const send = (msg: unknown): void => { stream.write(JSON.stringify(msg) + '\n') }

  async function call (method: string, params: Params): Promise<unknown> {
    if (method === 'init') {
      if (node) return node.status()
      if (typeof params.dir !== 'string' || params.dir === '') throw new Error('init needs the app\'s folder (dir)')
      const fresh = make({
        dir: params.dir,
        ...(params.secrets ? { secrets: params.secrets as PhoneNodeOptions['secrets'] } : {}),
        ...(Array.isArray(params.bootstrap) ? { bootstrap: params.bootstrap as PhoneNodeOptions['bootstrap'] } : {}),
        ...(typeof params.timeout === 'number' ? { timeout: params.timeout } : {})
      })
      try {
        await fresh.start()
      } catch (err) {
        // Not kept: a later init tries again from scratch.
        await fresh.close().catch(() => {})
        throw err
      }
      node = fresh
      fresh.on('change', () => { send({ event: 'change', status: fresh.status() }) })
      fresh.on('secrets', (secrets: unknown) => { send({ event: 'secrets', secrets }) })
      return fresh.status()
    }
    const fn = Object.hasOwn(METHODS, method) ? METHODS[method] : undefined
    if (!fn) throw new Error(`No such method: ${method}`)
    if (!node) throw new Error('Call init first')
    return await fn(node, params)
  }

  function onLine (line: string): void {
    if (line.trim() === '') return
    let req: { id?: unknown, method?: unknown, params?: unknown }
    try {
      req = JSON.parse(line)
    } catch {
      return send({ id: null, error: 'Not JSON' })
    }
    const id = req.id
    if (typeof req.method !== 'string') return send({ id, error: 'A request has a method' })
    const params = (typeof req.params === 'object' && req.params !== null ? req.params : {}) as Params
    call(req.method, params).then(
      (result) => { send({ id, result: result ?? null }) },
      (err: unknown) => { send({ id, error: err instanceof Error ? err.message : String(err) }) }
    )
  }

  stream.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
    let nl: number
    while ((nl = buffered.indexOf(10)) !== -1) {
      const line = buffered.subarray(0, nl)
      buffered = buffered.subarray(nl + 1)
      if (skipping) skipping = false
      else onLine(line.toString('utf-8'))
    }
    if (buffered.byteLength > MAX_LINE) {
      // Its id is in what was dropped: the app times out on it.
      buffered = Buffer.alloc(0)
      if (!skipping) send({ id: null, error: 'Line too long' })
      skipping = true
    }
  })

  return {
    suspend: async () => { await node?.suspend() },
    resume: async () => { await node?.resume() },
    close: async () => { await node?.close() }
  }
}
