// An identity's shared state: the devices allowed to act as it, its card,
// and who signs its history. Like the group's state (src/group/state.ts),
// `apply` is a pure function of the ops and the view.
//
// Any one device can change the identity: there are no proposals here.
// The identity's own devices sign it (they're its Autobase indexers), so it
// belongs to no group and serves all of them. A device joins as a writer;
// once it has written (`device.hello`, appended when it first can) it
// signs too, since Autobase stalls on indexers that never write. Device
// checks use the latest view, so nothing waits for signing.

import type { ApplyNode, Host, View } from '../group/state.js'
import { isId } from '../group/state.js'
import type { AgentCard } from '../a2a/types.js'
import { hex } from '../util/replica.js'

export type DeviceOp =
  | { type: 'init', device: string, name?: string }
  | { type: 'device.add', device: string, writer: string, name?: string }
  | { type: 'device.remove', device: string }
  | { type: 'card.set', card: AgentCard }
  | { type: 'device.hello' }

export type Op = DeviceOp & { at: number }

export interface DeviceRecord {
  // The device's Noise key (what it connects with), hex.
  device: string
  // Its Autobase writer in this identity's base, hex.
  writer: string
  name: string | null
  addedBy: string | null
  at: number
}

export interface Devices {
  devices: DeviceRecord[]
  removed: string[]
  card: AgentCard | null
  // The writers that sign (the base's indexers): the creator's, and each
  // device's once it has said hello. A removed device's stays only while
  // Autobase can't remove it (the last one that signs).
  signers: string[]
  // Every writer a device has ever had, removed ones too: none of them
  // can be a device's writer again.
  deviceWriters: string[]
}

// Folds `nodes` into `view`. Only the base's bootstrap writer may `init`;
// everything else must come from a current device. Bad ops are skipped.
export async function apply (nodes: ApplyNode[], view: View, host: Host, bootstrap: Uint8Array): Promise<void> {
  for (const node of nodes) {
    const op = parseOp(node.value)
    if (op === null) continue
    await applyOp(op, hex(node.from.key), view, host, bootstrap)
  }
}

async function applyOp (op: Op, writer: string, view: View, host: Host, bootstrap: Uint8Array): Promise<void> {
  if (op.type === 'init') {
    if (writer !== hex(bootstrap) || await view.get('meta') !== null) return
    await view.put('meta', { by: op.device, creatorWriter: writer, at: op.at })
    await view.put(`writer/${writer}`, op.device)
    await view.put(`device/${op.device}`, { device: op.device, writer, name: op.name ?? null, addedBy: null, at: op.at } satisfies DeviceRecord)
    // The bootstrap writer signs from the start.
    await view.put(`signer/${writer}`, { at: op.at })
    return
  }
  const author = await deviceOf(view, writer)
  if (author === null) return
  switch (op.type) {
    case 'device.add': {
      if (await view.get(`device/${op.device}`) !== null) return
      // A writer serves one device, once: not one a device had before (a
      // removed device's writer stays retired, even if that device is
      // added again with a new one).
      if (await view.get(`writer/${op.writer}`) !== null) return
      await view.del(`removed/${op.device}`)
      await view.put(`writer/${op.writer}`, op.device)
      await view.put(`device/${op.device}`, { device: op.device, writer: op.writer, name: op.name ?? null, addedBy: author, at: op.at } satisfies DeviceRecord)
      await host.addWriter(Buffer.from(op.writer, 'hex'), { indexer: false })
      return
    }
    case 'device.hello': {
      // The device has written (this op): it can sign now.
      if (await view.get(`signer/${writer}`) === null) {
        await host.addWriter(Buffer.from(writer, 'hex'), { indexer: true })
        await view.put(`signer/${writer}`, { at: op.at })
      }
      await retireSigners(view, host)
      return
    }
    case 'device.remove': {
      const rec = await view.get(`device/${op.device}`)
      if (rec === null) return
      // The last device stays: an identity with none can't be changed again.
      if ((await deviceIds(view)).length === 1) return
      await view.del(`device/${op.device}`)
      await view.put(`removed/${op.device}`, { by: author, at: op.at })
      const key = Buffer.from(rec.value.writer, 'hex')
      if (await view.get(`signer/${rec.value.writer}`) === null) {
        if (host.removeable(key)) await host.removeWriter(key)
        return
      }
      // A signer goes once another device signs (see retireSigners).
      await retireSigners(view, host)
      return
    }
    case 'card.set':
      await view.put('card', op.card)
  }
}

// Removes the writers of removed devices that still sign, as far as
// Autobase allows (it keeps the last indexer): one stays until a remaining
// device says hello.
async function retireSigners (view: View, host: Host): Promise<void> {
  for (const w of await keys(view, 'signer/')) {
    if (await deviceOf(view, w) !== null) continue
    const key = Buffer.from(w, 'hex')
    if (!host.removeable(key)) continue
    await host.removeWriter(key)
    await view.del(`signer/${w}`)
  }
}

// The current device a writer is the writer of, or null: a writer from
// before a device was removed (and maybe re-added) no longer counts.
async function deviceOf (view: View, writer: string): Promise<string | null> {
  const id: string | null = (await view.get(`writer/${writer}`))?.value ?? null
  if (id === null) return null
  const rec = await view.get(`device/${id}`)
  return rec !== null && rec.value.writer === writer ? id : null
}

async function deviceIds (view: View): Promise<string[]> {
  const ids: string[] = []
  for await (const { key } of view.createReadStream({ gt: 'device/', lt: 'device0' })) ids.push(key.slice('device/'.length))
  return ids
}

export async function readDevices (view: View): Promise<Devices> {
  const devices: DeviceRecord[] = []
  for await (const { value } of view.createReadStream({ gt: 'device/', lt: 'device0' })) devices.push(value)
  const removed: string[] = []
  for await (const { key } of view.createReadStream({ gt: 'removed/', lt: 'removed0' })) removed.push(key.slice('removed/'.length))
  return {
    devices,
    removed,
    card: (await view.get('card'))?.value ?? null,
    signers: await keys(view, 'signer/'),
    deviceWriters: await keys(view, 'writer/')
  }
}

async function keys (view: View, prefix: string): Promise<string[]> {
  const out: string[] = []
  for await (const { key } of view.createReadStream({ gt: prefix, lt: prefix.slice(0, -1) + '0' })) out.push(key.slice(prefix.length))
  return out
}

export function parseOp (value: unknown): Op | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, any>
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return null
  const name = v.name === undefined || (typeof v.name === 'string' && v.name.length <= 200)
  switch (v.type) {
    case 'init':
      return isId(v.device) && name ? v as Op : null
    case 'device.add':
      return isId(v.device) && isId(v.writer) && name ? v as Op : null
    case 'device.remove':
      return isId(v.device) ? v as Op : null
    case 'card.set':
      return typeof v.card === 'object' && v.card !== null && typeof v.card.name === 'string' ? v as Op : null
    case 'device.hello':
      return v as Op
    default:
      return null
  }
}
