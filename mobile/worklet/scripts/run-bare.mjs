// Runs built scripts under the Bare binary bare-sidecar ships, the closest
// runtime to the phone's. That runtime ends when fd 3 (its IPC) closes, so
// it gets a pipe that stays open until it exits.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const bare = join(dirname(require.resolve('bare-sidecar/package')), 'prebuilds', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'bare.exe' : 'bare')
for (const script of process.argv.slice(2)) {
  const code = await new Promise((resolve) => {
    const child = spawn(bare, [script], { stdio: ['inherit', 'inherit', 'inherit', 'pipe'] })
    child.on('error', (err) => { console.error(`Couldn't run Bare (${bare}): ${err.message}`); resolve(1) })
    child.on('exit', (code, signal) => { resolve(signal ? 1 : (code ?? 1)) })
  })
  if (code !== 0) process.exit(code)
}
