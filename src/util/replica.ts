import { EventEmitter } from 'node:events'
import Autobase from 'autobase'
import FastForward from 'autobase/lib/fast-forward.js'
import type Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import type { ApplyNode, Host, View } from '../group/state.js'

// How often a replica checks that its signed state keeps up with what the
// indexers signed, how long it may lag without moving before it counts as
// stalled, and how long after a repair it waits before trying another.
const STALL_CHECK = 15_000
const STALL_AFTER = 60_000
const REPAIR_EVERY = 5 * 60_000
// Stalling again this soon after a repair means the builds differ.
const DIVERGED_WITHIN = 30 * 60_000
// Indexers sign on Autobase's ack timer (randomized to 1 to 2 times
// ACK_INTERVAL). An op someone waits to see signed (see `urgent`) gets an
// ack sooner: ACK_LINGER after it's applied, so ops landing together share
// one, and at most one per ACK_GAP, so replaying or catching up on a long
// log (or a member's flood of claims) can't make an indexer ack nonstop.
// An ack that leaves the view unsigned (Autobase was busy appending, or
// other indexers have yet to sign) is tried once more after ACK_GAP.
// Autobase writes an ack only when there's something to sign.
const ACK_INTERVAL = 1000
const ACK_LINGER = 25
const ACK_GAP = 100

export interface ReplicaOptions {
  // The base's state rules: folds ops into the view. `bootstrap` is the
  // base's key, whose writer alone may start it.
  apply (nodes: ApplyNode[], view: View, host: Host, bootstrap: Uint8Array): Promise<void>
  // Whether `nodes` hold an op someone waits to see signed: an indexer
  // then acks within ACK_LINGER instead of on its timer.
  urgent? (nodes: ApplyNode[]): boolean
  encryptionKey?: Uint8Array
}

// One replica of an Autobase whose view is a Hyperbee (string keys, JSON
// values): the lifecycle the group and identity bases share. Subclasses
// read their state out of the view in `read`, which runs one at a time
// after each update; 'change' is emitted (outside the refresh, so a
// throwing listener can't fail an append) when it reports a change.
export abstract class Replica extends EventEmitter {
  readonly base: Autobase<Hyperbee>
  #refreshing: Promise<void> = Promise.resolve()
  #closed = false
  #watch: NodeJS.Timeout | null = null
  #lag = { signed: -1, since: 0, repairedAt: 0 }
  #ackSoon: NodeJS.Timeout | null = null
  #ackedAt = 0

  // `namespace` keeps this base's cores (its local writer above all) apart
  // from other bases in the same Corestore. Autobase gets its own namespaced
  // session, which it closes; the caller keeps `store`. (A namespace's
  // session() falls back to the root namespace, hence namespace(), fresh.)
  constructor (store: Corestore, namespace: string, key: Uint8Array | null, opts: ReplicaOptions) {
    super()
    let bootstrap: Uint8Array | null = key
    this.base = new Autobase<Hyperbee>(store.namespace(namespace), key, {
      ...(opts.encryptionKey ? { encryptionKey: opts.encryptionKey, encrypt: true } : {}),
      valueEncoding: 'json',
      ackInterval: ACK_INTERVAL,
      open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false }),
      // A new base has no key until it's ready; its key is its own local
      // writer, which the rules check `init` against.
      apply: async (nodes, view, host) => {
        await opts.apply(nodes, view, host, bootstrap ?? this.base.key)
        if (opts.urgent?.(nodes) === true) this.#ackShortly()
      }
    })
    // A failed read is retried on the next update.
    this.base.on('update', () => { this.refresh().catch(() => {}) })
    // The rules stopped applying (host.interrupt): the base closes.
    this.base.on('interrupt', (reason: unknown) => {
      this.interrupted = String(reason ?? 'interrupted')
      this.emit('interrupt', this.interrupted)
    })
    // Passed on only to someone listening: an unheard 'error' would throw.
    this.base.on('error', (err: unknown) => { if (this.listenerCount('error') > 0) this.emit('error', err) })
    void this.base.ready().then(() => { bootstrap = this.base.key }, () => {})
  }

  // Acks soon, as an indexer (see ACK_LINGER; Autobase's ack does nothing
  // otherwise, or with nothing to sign).
  #ackShortly (retry = true): void {
    if (this.#ackSoon !== null || this.#closed || !this.base.isIndexer) return
    const wait = Math.max(ACK_LINGER, this.#ackedAt + ACK_GAP - Date.now())
    this.#ackSoon = setTimeout(() => {
      this.#ackSoon = null
      if (this.#closed) return
      this.#ackedAt = Date.now()
      this.base.ack().then(() => {
        const core = this.base.view.core
        if (retry && core.signedLength < core.length) this.#ackShortly(false)
      }, () => {})
    }, wait)
    this.#ackSoon.unref()
  }

  async ready (): Promise<void> {
    await this.base.ready()
    await this.refresh()
    if (this.#watch === null && !this.#closed) {
      this.#watch = setInterval(() => { this.checkSigning() }, STALL_CHECK)
      this.#watch.unref()
    }
  }

  // What this replica holds, for messages.
  protected readonly what: string = 'a shared log'

  // Set when this replica's signed state stopped following the indexers'
  // again soon after a repair: its build applies the log differently from
  // theirs. Cleared once a while passes with no repair.
  stalled: string | null = null

  // A replica that doesn't index takes the indexers' signatures only for
  // a state it computed the same way. One whose apply came out different
  // (a build whose rules differ from theirs) never signs anything again,
  // and Autobase says nothing. Seen here as a signed length that stays
  // below the indexers' and doesn't move: the repair adopts their signed
  // state and applies on from there (see adoptSigned). A repair is what
  // catches it up, so catching up proves nothing; stalling again soon
  // after one does.
  checkSigning (now = Date.now()): void {
    if (this.#closed || this.interrupted !== null || this.base.isIndexer) return
    const lag = this.#lag
    if (this.stalled !== null && now - lag.repairedAt >= DIVERGED_WITHIN) {
      this.stalled = null
      this.emit('stall', null)
    }
    const theirs = indexersSigned(this.base)
    const mine = this.base.signedLength
    if (theirs === null || theirs <= mine) {
      lag.since = 0
      return
    }
    if (lag.since === 0 || mine !== lag.signed) {
      lag.signed = mine
      lag.since = now
      return
    }
    if (now - lag.since < STALL_AFTER || this.base.isFastForwarding()) return
    if (now - lag.repairedAt < REPAIR_EVERY) return
    const again = lag.repairedAt > 0 && now - lag.repairedAt < DIVERGED_WITHIN
    lag.repairedAt = now
    lag.since = 0
    if (again && this.stalled === null) {
      this.stalled = `This device's copy of ${this.what} stopped matching what its signers signed, so it no longer sees settled changes. Its pai applies that log differently from theirs: run the same pai version as they do.`
      this.emit('stall', this.stalled)
    }
    adoptSigned(this.base, theirs).catch(() => {})
  }

  get key (): Uint8Array {
    return this.base.key
  }

  get writerKey (): Uint8Array {
    return this.base.local.key
  }

  get writable (): boolean {
    return this.base.writable && this.interrupted === null
  }

  // Why the base stopped applying, if it did (see Host.interrupt).
  interrupted: string | null = null

  // Where the view stands (see viewMark): equal marks, equal contents.
  get mark (): string {
    return viewMark(this.base.view)
  }

  // Appends `op` stamped with the time, then waits for it to be applied
  // and read back.
  // (`at` may be given: a caller that needs to know its op's time.)
  protected async appendOp (op: object): Promise<void> {
    await this.base.append({ at: Date.now(), ...op })
    await this.base.update()
    await this.refresh()
  }

  // Reads the state out of `view`; returns whether it changed.
  protected abstract read (view: Hyperbee): Promise<boolean>

  async refresh (): Promise<void> {
    const next = this.#refreshing.then(async () => {
      if (this.#closed) return
      const view = this.base.view
      await view.ready()
      if (!await this.read(view)) return
      queueMicrotask(() => {
        try {
          this.emit('change')
        } catch {}
      })
    })
    this.#refreshing = next.catch(() => {})
    await next
  }

  async close (): Promise<void> {
    this.#closed = true
    if (this.#watch !== null) clearInterval(this.#watch)
    if (this.#ackSoon !== null) clearTimeout(this.#ackSoon)
    await this.#refreshing
    await this.base.close().catch(() => {})
  }
}

// The length of the base's system core that its indexers have signed, as
// far as this replica has it (Autobase keeps it on the shared core under
// its own session), or null if it can't be read.
function indexersSigned (base: Autobase<Hyperbee>): number | null {
  const length: unknown = base.core.core?.state?.length
  return typeof length === 'number' ? length : null
}

// Moves the base to the indexers' signed state at `length` and applies
// what's left of its own from there: Autobase's fast-forward, forced, with
// the checks its own callers make. Autobase skips a fast-forward when this
// replica's unsigned state is longer than theirs, which is how a replica
// that went its own way ends up; its public forceFastForward() goes back
// to the last flush its own views agree with instead, which is no help.
// These are Autobase internals (7.x): if they change, the public repair
// is the fallback.
async function adoptSigned (base: Autobase<Hyperbee>, length: number): Promise<void> {
  const b = base as unknown as { core: { key: Uint8Array }, fastForwardEnabled?: boolean, _interrupting?: boolean, _runFastForward?: (ff: unknown) => Promise<void> }
  if (typeof b._runFastForward !== 'function' || typeof FastForward !== 'function') {
    await base.forceFastForward()
    return
  }
  if (b.fastForwardEnabled === false || b._interrupting === true || base.isFastForwarding()) return
  await b._runFastForward(new FastForward(base, b.core.key, { force: true, length }))
}

// Where a view's contents stand: changes when it grows or is reordered (a
// reorder truncates it, bumping the fork, and can keep the length).
export function viewMark (view: Hyperbee): string {
  return `${view.core.fork}:${view.core.length}`
}

export function hex (b: Uint8Array): string {
  return Buffer.from(b).toString('hex')
}
