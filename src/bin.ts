#!/usr/bin/env node
import { run } from './cli/main.js'

const controller = new AbortController()
let stopping = false
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(130) // a second Ctrl-C doesn't wait for a clean close
    stopping = true
    controller.abort()
  })
}

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  signal: controller.signal
})
process.exit(code)
