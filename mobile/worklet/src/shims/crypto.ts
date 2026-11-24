// The part of `node:crypto` pai's core uses, for Bare (the phone's worklet
// runtime), where the worklet bundle maps `node:crypto` here. Built on
// sodium-universal, which Bare and Node both run, so the same code is
// tested under Node against the real thing (test/crypto.test.ts).
//
// Covered: SHA-256 hashes and HMACs, HKDF-SHA256, random bytes and UUIDs,
// constant-time compare, and Ed25519 keys given as JWKs with sign/verify.
// Not covered: ciphers (only mailboxes use them, and the phone runs none).

import sodium from 'sodium-universal'

type Data = Uint8Array | string

// A copy, as Node takes the bytes when it's given them: a caller may
// reuse its buffer before digest().
function bytes (data: Data): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data)
}

function only (what: string, algorithm: string): void {
  if (algorithm.toLowerCase() !== 'sha256') throw new Error(`${what}: only sha256 is available here, not ${algorithm}`)
}

function sha256 (data: Uint8Array): Buffer {
  const out = Buffer.alloc(32)
  sodium.crypto_hash_sha256(out, data)
  return out
}

class Digest {
  readonly #parts: Buffer[] = []
  #done = false

  constructor (readonly finish: (data: Buffer) => Buffer) {}

  update (data: Data): this {
    if (this.#done) throw new Error('Digest already called')
    this.#parts.push(bytes(data))
    return this
  }

  digest (): Buffer
  digest (encoding: BufferEncoding): string
  digest (encoding?: BufferEncoding): Buffer | string {
    if (this.#done) throw new Error('Digest already called')
    this.#done = true
    const out = this.finish(Buffer.concat(this.#parts))
    return encoding === undefined ? out : out.toString(encoding)
  }
}

export function createHash (algorithm: string): Digest {
  only('createHash', algorithm)
  return new Digest(sha256)
}

// RFC 2104, over SHA-256 (64-byte blocks).
function hmac (key: Uint8Array, data: Uint8Array): Buffer {
  let k: Buffer = Buffer.from(key)
  if (k.byteLength > 64) k = sha256(k)
  const block = Buffer.alloc(64)
  k.copy(block)
  const inner = Buffer.alloc(64)
  const outer = Buffer.alloc(64)
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i]! ^ 0x36
    outer[i] = block[i]! ^ 0x5c
  }
  return sha256(Buffer.concat([outer, sha256(Buffer.concat([inner, data]))]))
}

export function createHmac (algorithm: string, key: Data): Digest {
  only('createHmac', algorithm)
  const k = bytes(key)
  return new Digest((data) => hmac(k, data))
}

// RFC 5869. Returns an ArrayBuffer, as Node's does.
export function hkdfSync (digest: string, ikm: Data, salt: Data, info: Data, length: number): ArrayBuffer {
  only('hkdfSync', digest)
  if (!Number.isInteger(length) || length < 0 || length > 255 * 32) throw new RangeError('hkdfSync: bad length')
  // (An empty salt is the same key to HMAC as RFC 5869's zeros.)
  const prk = hmac(bytes(salt), bytes(ikm))
  const inf = bytes(info)
  const out = Buffer.alloc(length)
  let t: Buffer = Buffer.alloc(0)
  for (let i = 0, at = 0; at < length; i++) {
    t = hmac(prk, Buffer.concat([t, inf, Buffer.from([i + 1])]))
    at += t.copy(out, at)
  }
  return out.buffer.slice(out.byteOffset, out.byteOffset + length)
}

export function randomBytes (size: number): Buffer {
  const out = Buffer.alloc(size)
  sodium.randombytes_buf(out)
  return out
}

export function randomUUID (): string {
  const b = randomBytes(16)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function timingSafeEqual (a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) throw new RangeError('Input buffers must have the same byte length')
  return sodium.sodium_memcmp(a, b)
}

// Ed25519 keys, as pai gives them: JWKs (OKP, Ed25519).
interface Jwk { kty: string, crv: string, x: string, d?: string }
export class KeyObject {
  constructor (readonly type: 'private' | 'public', readonly raw: Buffer) {}
}

function okp (opts: { key: Jwk, format: string }): Jwk {
  const { key, format } = opts
  if (format !== 'jwk' || key.kty !== 'OKP' || key.crv !== 'Ed25519') throw new Error('Only Ed25519 keys given as JWKs are available here')
  return key
}

export function createPrivateKey (opts: { key: Jwk, format: string }): KeyObject {
  const key = okp(opts)
  if (key.d === undefined) throw new Error('A private key needs d')
  const seed = Buffer.from(key.d, 'base64url')
  const pk = Buffer.alloc(32)
  const sk = Buffer.alloc(64)
  sodium.crypto_sign_seed_keypair(pk, sk, seed)
  if (!pk.equals(Buffer.from(key.x, 'base64url'))) throw new Error('The JWK\'s x is not the public key of its d')
  return new KeyObject('private', sk)
}

export function createPublicKey (opts: { key: Jwk, format: string }): KeyObject {
  const raw = Buffer.from(okp(opts).x, 'base64url')
  if (raw.byteLength !== 32) throw new Error('An Ed25519 public key is 32 bytes')
  return new KeyObject('public', raw)
}

export function sign (algorithm: null | undefined, data: Uint8Array, key: KeyObject): Buffer {
  if (algorithm != null || key.type !== 'private') throw new Error('sign: Ed25519 with a private key only')
  const sig = Buffer.alloc(64)
  sodium.crypto_sign_detached(sig, data, key.raw)
  return sig
}

export function verify (algorithm: null | undefined, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean {
  if (algorithm != null || key.type !== 'public') throw new Error('verify: Ed25519 with a public key only')
  return signature.byteLength === 64 && sodium.crypto_sign_verify_detached(signature, data, key.raw)
}

function unavailable (name: string): never {
  throw new Error(`${name} is not available in pai's mobile worklet`)
}
export function createCipheriv (): never { return unavailable('createCipheriv') }
export function createDecipheriv (): never { return unavailable('createDecipheriv') }

export default { createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual, createPrivateKey, createPublicKey, sign, verify, createCipheriv, createDecipheriv, KeyObject }
