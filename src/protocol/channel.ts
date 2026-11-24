import Protomux from 'protomux'
import c from 'compact-encoding'
import type { JsonRpcMessage } from './jsonrpc.js'

export const PROTOCOL = 'a2a/v1'

// The pai protocol version this build speaks (BINDING.md, Section 2.2):
// what goes over a connection and how it's checked. Two agents speak only
// on the same version. (A group's rules have their own version, in the
// group's log: see RULES in src/group/state.ts.)
export const PAI_VERSION = 1

// Sent once in each direction when the a2a/v1 channel opens.
export interface ChannelHandshake {
  // The sender's pai protocol version.
  version: number
  // Identity proof (see Identity.proof).
  proof: Uint8Array
}

const handshakeEncoding = {
  preencode (state: unknown, m: ChannelHandshake) {
    c.uint.preencode(state, m.version)
    c.buffer.preencode(state, m.proof)
  },
  encode (state: unknown, m: ChannelHandshake) {
    c.uint.encode(state, m.version)
    c.buffer.encode(state, m.proof)
  },
  // The version first, on its own: a handshake from another version may
  // carry what this one can't read, and its version still gets read (so
  // the refusal can say which it is).
  decode (state: unknown): ChannelHandshake {
    const version = c.uint.decode(state)
    let proof: Uint8Array = new Uint8Array(0)
    try {
      proof = c.buffer.decode(state) ?? proof
    } catch {}
    return { version, proof }
  }
}

export interface ChannelHandlers {
  onopen (remote: ChannelHandshake): void | Promise<void>
  onmessage (msg: unknown): void
  onclose (): void
}

export interface A2AChannel {
  open (handshake: ChannelHandshake): void
  send (msg: JsonRpcMessage): boolean
  close (): void
}

// One a2a/v1 channel per connection. JSON-RPC envelopes travel as JSON
// messages; tasks are multiplexed by JSON-RPC id.
export function createChannel (stream: unknown, handlers: ChannelHandlers): A2AChannel | null {
  const mux = Protomux.from(stream)
  const channel = mux.createChannel({
    protocol: PROTOCOL,
    unique: true,
    handshake: handshakeEncoding,
    onopen: handlers.onopen,
    onclose: handlers.onclose
  })
  if (channel === null) return null

  const rpc = channel.addMessage({ encoding: c.json, onmessage: handlers.onmessage })

  return {
    open: (handshake) => channel.open(handshake),
    send: (msg) => rpc.send(msg),
    close: () => channel.close()
  }
}
