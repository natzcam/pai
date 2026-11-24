import type Corestore from 'corestore'
import type Hyperbee from 'hyperbee'
import { Replica, hex, viewMark } from '../util/replica.js'
import { apply, readDevices } from './state.js'
import type { DeviceOp, Devices } from './state.js'

// Where in an agent's group Corestore its own identity base lives, and
// where replicas of other members' identity bases do.
export const OWN_IDENTITY = 'identity'

export function replicaNamespace (identity: string): string {
  return `identity/${identity}`
}

// One replica of an identity's Autobase: its devices, card and signers.
// Emits 'change' when that state moves.
export class DeviceBase extends Replica {
  protected override readonly what = 'its identity\'s devices'
  state: Devices = { devices: [], removed: [], card: null, signers: [], deviceWriters: [] }
  #mark = ''
  #greeting: Promise<void> | null = null

  // `namespace` is where in `store` this base lives (see Replica).
  constructor (store: Corestore, key: Uint8Array | null, namespace = OWN_IDENTITY) {
    super(store, namespace, key, { apply })
  }

  // A new identity with `device` as its only device, in `store`'s
  // OWN_IDENTITY namespace; returns its key (the identity id).
  static async create (store: Corestore, device: Uint8Array, name?: string): Promise<Uint8Array> {
    const identity = new DeviceBase(store, null)
    try {
      await identity.ready()
      await identity.appendOp({ type: 'init', device: hex(device), ...(name ? { name: name.slice(0, 200) } : {}) })
      if (!identity.state.devices.some((d) => d.device === hex(device))) throw new Error('The new identity did not record its device')
      return Buffer.from(identity.base.key)
    } finally {
      await identity.close()
    }
  }

  // Whether `device` (a Noise key, hex) acts for this identity: true if
  // listed, false if removed, 'pending' if this replica doesn't know it
  // (yet). Uses the latest state: one device is enough to change it.
  hasDevice (device: string): boolean | 'pending' {
    if (this.state.devices.some((d) => d.device === device)) return true
    return this.state.removed.includes(device) ? false : 'pending'
  }

  // As a device of this identity.
  async append (op: Exclude<DeviceOp, { type: 'init' | 'device.hello' }>): Promise<void> {
    if (!this.writable) throw new Error('This device is not a writer of the identity yet (still syncing?)')
    await this.appendOp(op)
  }

  // As a device: says hello once it can write and doesn't sign yet, so
  // the rules make it a signer (see state.ts).
  async hello (): Promise<void> {
    // One hello at a time: calls made before it's read back share it.
    if (this.#greeting) return await this.#greeting
    const me = hex(this.writerKey)
    if (!this.writable || this.state.signers.includes(me) || !this.state.devices.some((d) => d.writer === me)) return
    this.#greeting = this.appendOp({ type: 'device.hello' }).finally(() => { this.#greeting = null })
    await this.#greeting
  }

  protected async read (view: Hyperbee): Promise<boolean> {
    const mark = viewMark(view)
    if (mark === this.#mark) return false
    this.state = await readDevices(view)
    this.#mark = mark
    return true
  }
}
