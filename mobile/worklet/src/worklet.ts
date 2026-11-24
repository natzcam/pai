// The worklet's entry: serves PhoneNode to the app over Bare.IPC (see
// ipc.ts). react-native-bare-kit suspends the worklet when the app goes to
// the background and resumes it after: pai's swarm winds down and comes
// back with it. The root test suite runs this under bare-sidecar's Bare,
// which wires Bare.IPC the same way (test/bare.test.ts).

import Suspendify from 'suspendify'
import { serve } from './ipc.js'
import type { Duplex } from './ipc.js'

declare const Bare: {
  IPC: Duplex
  on (event: 'suspend', listener: (linger: number) => void): unknown
  on (event: 'teardown' | 'resume', listener: () => void): unknown
}

// How much of the OS's background grace (`linger`: iOS gives ~30 s) to
// keep back for winding the swarm down before the app freezes.
const SUSPEND_MARGIN = 10_000

const served = serve(Bare.IPC)
// Bare's signals are synchronous and can come quickly one after another;
// winding the swarm down and back up is async. Suspendify keeps them in
// order: a resume that comes while a suspend is still running isn't lost
// (Hyperswarm's resume does nothing until its suspend has finished, which
// left the phone asleep after a quick switch back), and one within the
// grace period cancels the suspend.
const lifecycle = new Suspendify({
  suspend: async () => { await served.suspend() },
  resume: async () => { await served.resume() }
})
Bare.on('suspend', (linger) => { lifecycle.suspend(Math.max((linger ?? 0) - SUSPEND_MARGIN, 0)) })
Bare.on('resume', () => { lifecycle.resume() })
// Best effort: Bare doesn't wait for it. The storage folder survives an
// unclean end: the next app process takes over the lock this one left (a
// pid not its own is gone, see shims/globals.ts), and RocksDB recovers
// its log.
Bare.on('teardown', () => { served.close().catch(() => {}) })
