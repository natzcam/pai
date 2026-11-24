// node:fs/promises for Bare: bare-fs's, except that writeFile honours an
// exclusive flag ('wx', 'ax'...). bare-fs 4.8 has no O_EXCL constant, so
// it opens those as plain 'w': pai's storage lock (lockStorage) would
// overwrite another run's lock instead of failing with EEXIST.
import fs from 'bare-fs'
import os from 'bare-os'

export * from 'bare-fs/promises'

const c = fs.constants as Record<string, number | undefined>
// The platforms' own values: Linux and Android 0x80, Darwin and iOS 0x800.
const O_EXCL = c.O_EXCL ?? (os.platform() === 'darwin' || os.platform() === 'ios' ? 0x800 : 0x80)

const EXCLUSIVE: Record<string, number> = {
  wx: c.O_TRUNC! | c.O_CREAT! | c.O_WRONLY! | O_EXCL,
  xw: c.O_TRUNC! | c.O_CREAT! | c.O_WRONLY! | O_EXCL,
  ax: c.O_APPEND! | c.O_CREAT! | c.O_WRONLY! | O_EXCL,
  xa: c.O_APPEND! | c.O_CREAT! | c.O_WRONLY! | O_EXCL
}

type Opts = { flag?: string, mode?: number, encoding?: BufferEncoding } | BufferEncoding | undefined

export async function writeFile (path: string, data: string | Uint8Array, opts?: Opts): Promise<void> {
  const o = typeof opts === 'string' ? { encoding: opts } : (opts ?? {})
  const flags = o.flag === undefined ? undefined : EXCLUSIVE[o.flag]
  if (flags === undefined) return await (fs.promises.writeFile as (...a: unknown[]) => Promise<void>)(path, data, opts)
  const bytes = typeof data === 'string' ? Buffer.from(data, o.encoding ?? 'utf-8') : data
  const fd = await fs.promises.open(path, flags, o.mode ?? 0o666)
  try {
    let at = 0
    // (bare-fs types write() as a number; it returns { bytesWritten }.)
    while (at < bytes.byteLength) at += (await fd.write(bytes.subarray(at)) as unknown as { bytesWritten: number }).bytesWritten
  } finally {
    await fd.close()
  }
}
