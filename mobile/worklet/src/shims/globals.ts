// What pai's core takes from Node's globals, for Bare: Buffer, and the
// little of `process` it reads (its pid and liveness checks for the
// storage lock, and an environment). Injected into every worklet bundle
// ahead of pai's code.
import { Buffer } from 'bare-buffer'
import os from 'bare-os'

// A phone app runs no other pai process: a pid that isn't this one (left
// in a lock file by an earlier run) is gone, even when it now belongs to
// another app, which would otherwise answer EPERM, "alive".
function kill (pid: number, signal?: number | string): void {
  if (signal === 0 && pid !== os.pid()) throw Object.assign(new Error('No such process'), { code: 'ESRCH' })
  os.kill(pid, signal as never)
}

const g = globalThis as Record<string, unknown>
if (g.Buffer === undefined) g.Buffer = Buffer
if (g.process === undefined) {
  g.process = {
    pid: os.pid(),
    env: {},
    platform: os.platform(),
    kill,
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => { queueMicrotask(() => { fn(...args) }) }
  }
}
