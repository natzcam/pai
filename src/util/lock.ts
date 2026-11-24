import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LOCK_FILE = 'pai.lock'

// One agent per storage folder: a lock file holding the owner's pid. A lock
// left by a process that has gone away is taken over.
export async function lockStorage (storage: string): Promise<() => Promise<void>> {
  const file = join(storage, LOCK_FILE)
  const token = `${process.pid}\n`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, token, { flag: 'wx' })
      return async () => {
        if (await readFile(file, 'utf-8').catch(() => null) === token) await rm(file, { force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const pid = Number((await readFile(file, 'utf-8').catch(() => '')).trim())
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      throw new Error(`Storage ${storage} is locked by process ${pid} (is another pai agent using it?)`)
    }
    await rm(file, { force: true })
  }
  throw new Error(`Storage ${storage} is locked (${file}); remove it if no pai agent is running`)
}

function alive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
