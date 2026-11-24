import { randomBytes } from 'node:crypto'
import { readdir, readFile, rename, writeFile } from 'node:fs/promises'

// File names built from ids that may come from peers. Anything else is
// treated as not found, so it can never name a path outside a folder.
const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/

export function isId (id: unknown): id is string {
  return typeof id === 'string' && ID.test(id)
}

export function checkId (id: string): string {
  if (!isId(id)) throw new Error(`Not a storable id: ${JSON.stringify(id)}`)
  return id
}

// Written to a temporary name and renamed into place, so a crash never
// leaves half a file.
export async function atomicWrite (file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

export async function readJson<T> (file: string): Promise<T | null> {
  let text: string
  try {
    text = await readFile(file, 'utf-8')
  } catch {
    return null
  }
  return JSON.parse(text) as T
}

// A folder's entries, sorted, without temporary files; empty if it's missing.
export async function list (dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => !n.endsWith('.tmp')).sort()
  } catch {
    return []
  }
}
