import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import HyperDHT from 'hyperdht'

export const KEY_FILE = 'agent.key'

export interface KeyPair {
  publicKey: Buffer
  // Ed25519 in sodium's layout: the 32-byte seed, then the public key.
  secretKey: Buffer
}

// The agent's Noise key pair, from <storage>/agent.key (the secret key as
// hex, mode 600). A new folder gets a new key pair, so a new agent id.
export async function loadKeyPair (storage: string): Promise<KeyPair> {
  const file = join(storage, KEY_FILE)
  await mkdir(storage, { recursive: true })
  let text: string | null = null
  try {
    text = await readFile(file, 'utf-8')
  } catch {}
  if (text === null) {
    const keyPair = buffers(HyperDHT.keyPair())
    try {
      // 'wx': if another process made one first, use that one instead.
      await writeFile(file, keyPair.secretKey.toString('hex') + '\n', { flag: 'wx', mode: 0o600 })
      await chmod(file, 0o600)
      return keyPair
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      text = await readFile(file, 'utf-8')
    }
  }
  const secretKey = Buffer.from(text.trim(), 'hex')
  if (secretKey.byteLength !== 64) throw new Error(`${file} is not a pai key file (expected a 64-byte secret key, as hex)`)
  const keyPair = buffers(HyperDHT.keyPair(secretKey.subarray(0, 32)))
  if (!keyPair.secretKey.equals(secretKey)) throw new Error(`${file} is damaged: its public half doesn't match its seed`)
  return keyPair
}

function buffers (k: { publicKey: Uint8Array, secretKey: Uint8Array }): KeyPair {
  return { publicKey: Buffer.from(k.publicKey), secretKey: Buffer.from(k.secretKey) }
}
