import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import c from 'compact-encoding'
import sodium from 'sodium-universal'
import type { Message, Task } from '../a2a/types.js'

// What travels in an envelope: a message for the recipient to run, or the
// recipient's task, sent back once it ends or needs input.
export type Letter = { kind: 'message', message: Message } | { kind: 'task', task: Task }

// A sealed letter. Only `from` and `to` can open it: the key comes from an
// X25519 exchange of their Noise keys, so a mailbox holding it can't.
export interface Envelope {
  from: Uint8Array
  to: Uint8Array
  nonce: Uint8Array
  // AES-256-GCM ciphertext, with the 16-byte tag at the end.
  sealed: Uint8Array
}

const VERSION = 1
const SALT = Buffer.from('pai/mailbox/v1')
const TAG = 16

const envelopeEncoding = {
  preencode (state: unknown, m: Envelope) {
    c.uint.preencode(state, VERSION)
    c.fixed32.preencode(state, m.from)
    c.fixed32.preencode(state, m.to)
    c.buffer.preencode(state, m.nonce)
    c.buffer.preencode(state, m.sealed)
  },
  encode (state: unknown, m: Envelope) {
    c.uint.encode(state, VERSION)
    c.fixed32.encode(state, m.from)
    c.fixed32.encode(state, m.to)
    c.buffer.encode(state, m.nonce)
    c.buffer.encode(state, m.sealed)
  },
  decode (state: unknown): Envelope {
    const version = c.uint.decode(state)
    if (version !== VERSION) throw new Error(`Unknown envelope version ${version}`)
    return {
      from: c.fixed32.decode(state),
      to: c.fixed32.decode(state),
      nonce: c.buffer.decode(state) ?? new Uint8Array(0),
      sealed: c.buffer.decode(state) ?? new Uint8Array(0)
    }
  }
}

export function encodeEnvelope (e: Envelope): Uint8Array {
  return c.encode(envelopeEncoding, e)
}

export function decodeEnvelope (bytes: Uint8Array): Envelope {
  return c.decode(envelopeEncoding, bytes)
}

// The key two agents share: the same whichever side computes it.
// `keyPair` is the agent's own Noise key pair (Ed25519, 64-byte secret key).
export function pairKey (keyPair: { publicKey: Uint8Array, secretKey: Uint8Array }, peer: Uint8Array): Buffer {
  const ownSecret = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES)
  const peerPublic = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_sign_ed25519_sk_to_curve25519(ownSecret, keyPair.secretKey)
  sodium.crypto_sign_ed25519_pk_to_curve25519(peerPublic, peer)
  const shared = Buffer.alloc(sodium.crypto_scalarmult_BYTES)
  sodium.crypto_scalarmult(shared, ownSecret, peerPublic)
  ownSecret.fill(0)
  // A low-order public key gives an all-zero secret anyone could compute.
  if (shared.every((b) => b === 0)) throw new Error('Unusable peer key')
  const [a, b] = [Buffer.from(keyPair.publicKey), Buffer.from(peer)].sort(Buffer.compare)
  return Buffer.from(hkdfSync('sha256', shared, SALT, Buffer.concat([a!, b!]), 32))
}

export function seal (keyPair: { publicKey: Uint8Array, secretKey: Uint8Array }, to: Uint8Array, letter: Letter): Envelope {
  const from = keyPair.publicKey
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', pairKey(keyPair, to), nonce)
  cipher.setAAD(aad(from, to))
  const sealed = Buffer.concat([cipher.update(JSON.stringify(letter)), cipher.final(), cipher.getAuthTag()])
  return { from, to, nonce, sealed }
}

// Opens an envelope addressed to this agent. Throws if it isn't, or if it was
// changed or wasn't sealed by `from`.
export function open (keyPair: { publicKey: Uint8Array, secretKey: Uint8Array }, envelope: Envelope): Letter {
  if (!Buffer.from(envelope.to).equals(Buffer.from(keyPair.publicKey))) throw new Error('Envelope is for another agent')
  if (envelope.sealed.byteLength < TAG) throw new Error('Envelope is too short')
  const decipher = createDecipheriv('aes-256-gcm', pairKey(keyPair, envelope.from), envelope.nonce)
  decipher.setAAD(aad(envelope.from, envelope.to))
  decipher.setAuthTag(envelope.sealed.subarray(envelope.sealed.byteLength - TAG))
  const plain = Buffer.concat([decipher.update(envelope.sealed.subarray(0, envelope.sealed.byteLength - TAG)), decipher.final()])
  const letter = JSON.parse(plain.toString('utf-8')) as Letter
  if (letter?.kind !== 'message' && letter?.kind !== 'task') throw new Error('Unknown letter')
  return letter
}

function aad (from: Uint8Array, to: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from('pai/mailbox/v1/envelope\n'), from, to])
}
