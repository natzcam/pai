// A command run in its own process group, so stopping it also stops what
// it started (a pipeline, a sleep, a harness's tools), and an abort
// signal stops it.

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

const STDERR_TAIL = 4096

export interface Group {
  child: ChildProcessWithoutNullStreams
  // Its exit code (null when killed), the end of its stderr, and an error
  // if it couldn't start.
  done: Promise<{ code: number | null, stderr: string, error: NodeJS.ErrnoException | null }>
}

export interface Running {
  add (pid: number): void
  delete (pid: number): void
}

export function spawnGroup (command: string, args: string[], opts: { cwd?: string, env?: NodeJS.ProcessEnv, shell?: boolean }, signal: AbortSignal, running: Running): Group {
  const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, shell: opts.shell === true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  if (child.pid !== undefined) running.add(child.pid)
  const onAbort = (): void => { killGroup(child.pid) }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  child.stdin.on('error', () => {}) // it may not read stdin
  let stderr = ''
  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (s: string) => { stderr = (stderr + s).slice(-STDERR_TAIL) })
  const done = new Promise<{ code: number | null, stderr: string, error: NodeJS.ErrnoException | null }>((resolve) => {
    let settled = false
    const finish = (code: number | null, error: NodeJS.ErrnoException | null): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (child.pid !== undefined) running.delete(child.pid)
      resolve({ code, stderr, error })
    }
    // A command that couldn't start reports only an error.
    child.on('error', (err) => { finish(127, err) })
    child.on('close', (code) => { finish(code, null) })
  })
  return { child, done }
}

export function killGroup (pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {}
}
