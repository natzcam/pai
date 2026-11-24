import { createHmac } from 'node:crypto'
import sodium from 'sodium-universal'

// A commitment to a seed, hex: recorded with its epoch, so a device can
// tell that a box holds that epoch's seed. (A seed is 32 random bytes, so
// this gives nothing away.)
export function seedCheck (seed: Uint8Array): string {
  return createHmac('sha256', seed).update('pai/group/seed-check').digest('hex')
}

// A group seed sealed to one device: an anonymous sealed box (X25519, from
// the device's Ed25519 Noise key), as hex. Only that device can open it.
export function sealSeed (seed: Uint8Array, device: Uint8Array): string {
  const pk = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(pk, device)
  const box = Buffer.alloc(seed.byteLength + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(box, seed, pk)
  return box.toString('hex')
}

// Opens a box sealed to this device (`keyPair`, its Noise key pair); null
// if it isn't one, or was changed.
export function openSeed (box: string, keyPair: { publicKey: Uint8Array, secretKey: Uint8Array }): Buffer | null {
  const bytes = Buffer.from(box, 'hex')
  if (bytes.byteLength !== 32 + sodium.crypto_box_SEALBYTES) return null
  const pk = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const sk = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES)
  try {
    sodium.crypto_sign_ed25519_pk_to_curve25519(pk, keyPair.publicKey)
    sodium.crypto_sign_ed25519_sk_to_curve25519(sk, keyPair.secretKey)
    const seed = Buffer.alloc(32)
    return sodium.crypto_box_seal_open(seed, bytes, pk, sk) ? seed : null
  } catch {
    return null
  } finally {
    sk.fill(0)
  }
}
