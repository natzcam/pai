import * as node from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as shim from '../src/shims/crypto.js'

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64url')

describe('the worklet\'s node:crypto', () => {
  it('hashes and MACs as Node does', () => {
    for (const data of ['', 'abc', 'x'.repeat(1000)]) {
      expect(shim.createHash('sha256').update(data).digest('hex')).toBe(node.createHash('sha256').update(data).digest('hex'))
      expect(shim.createHash('sha256').update(data).update(Buffer.from([1, 2])).digest()).toEqual(node.createHash('sha256').update(data).update(Buffer.from([1, 2])).digest())
      for (const key of [Buffer.alloc(0), Buffer.from('key'), Buffer.alloc(64, 7), Buffer.alloc(100, 9)]) {
        expect(shim.createHmac('sha256', key).update(data).digest()).toEqual(node.createHmac('sha256', key).update(data).digest())
      }
    }
    expect(() => shim.createHash('sha512')).toThrow(/sha256/)
    // The bytes are taken when given, as Node does: reusing a buffer after
    // update() changes nothing.
    const scratch = Buffer.from('abc')
    const h = shim.createHash('sha256').update(scratch)
    const key = Buffer.from('key')
    const m = shim.createHmac('sha256', key).update(scratch)
    scratch.fill(0)
    key.fill(0)
    expect(h.digest('hex')).toBe(node.createHash('sha256').update('abc').digest('hex'))
    expect(m.digest('hex')).toBe(node.createHmac('sha256', 'key').update('abc').digest('hex'))
  })

  it('derives keys with HKDF as Node does', () => {
    for (const [ikm, salt, info, length] of [[node.randomBytes(32), Buffer.from('salt'), Buffer.from('label'), 32], [Buffer.from('ikm'), Buffer.alloc(0), 'info', 100], [node.randomBytes(16), node.randomBytes(80), Buffer.alloc(0), 64]] as const) {
      expect(Buffer.from(shim.hkdfSync('sha256', ikm, salt, info, length))).toEqual(Buffer.from(node.hkdfSync('sha256', ikm, salt, info, length)))
    }
  })

  it('signs and verifies Ed25519 as Node does', () => {
    const { publicKey, privateKey } = node.generateKeyPairSync('ed25519')
    const jwk = privateKey.export({ format: 'jwk' }) as { kty: string, crv: string, x: string, d: string }
    const data = Buffer.from('join me')
    const sig = shim.sign(null, data, shim.createPrivateKey({ key: jwk, format: 'jwk' }))
    expect(sig).toEqual(node.sign(null, data, privateKey)) // Ed25519 is deterministic
    const pub = shim.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' })
    expect(shim.verify(null, data, pub, sig)).toBe(true)
    expect(node.verify(null, data, publicKey, sig)).toBe(true)
    expect(shim.verify(null, Buffer.from('other'), pub, sig)).toBe(false)
    expect(() => shim.createPrivateKey({ key: { ...jwk, x: b64(Buffer.alloc(32)) }, format: 'jwk' })).toThrow(/public key/)
  })

  it('makes random bytes, UUIDs, and compares in constant time', () => {
    expect(shim.randomBytes(32)).toHaveLength(32)
    expect(shim.randomBytes(32)).not.toEqual(shim.randomBytes(32))
    expect(shim.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(shim.timingSafeEqual(Buffer.from('ab'), Buffer.from('ab'))).toBe(true)
    expect(shim.timingSafeEqual(Buffer.from('ab'), Buffer.from('ac'))).toBe(false)
    expect(() => shim.timingSafeEqual(Buffer.from('a'), Buffer.from('ab'))).toThrow()
    expect(() => shim.createCipheriv()).toThrow(/not available/)
  })
})
