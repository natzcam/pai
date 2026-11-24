#!/usr/bin/env node
// The app end to end on an Android device or emulator (one attached, as
// adb sees it), against a pai daemon run here, over the public DHT:
// joins as a device of a fresh identity, takes a workflow's approval step
// and answers it with the step's choice button, and checks on the
// computer that the workflow went down that branch.
//
//   npm run e2e:android [-- --apk path/to/app.apk]
//
// Builds nothing: by default it installs the release APK from
// android/app/build (npm run android:release builds it). Needs pai built
// at the root (npm run build there). Finds elements by their text or
// accessibility label (uiautomator), so it doesn't depend on layout.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const root = path.join(appDir, '..', '..')
const bin = path.join(root, 'dist', 'bin.js')
const adbPath = path.join(process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? '', 'platform-tools', 'adb')
const apk = process.argv.includes('--apk') ? process.argv[process.argv.indexOf('--apk') + 1] : path.join(appDir, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
const PACKAGE = 'dev.pai.mobile'

const adb = (...args) => execFileSync(adbPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const step = (what) => { console.log(`- ${what}`) }

// The screen's elements: text, accessibility label, and centre.
function elements () {
  const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty')
  return [...xml.matchAll(/<node [^>]*>/g)].map(([n]) => {
    const attr = (k) => (n.match(new RegExp(`${k}="([^"]*)"`)) ?? [])[1] ?? ''
    const [x1, y1, x2, y2] = attr('bounds').match(/\d+/g)?.map(Number) ?? [0, 0, 0, 0]
    return { text: attr('text'), label: attr('content-desc'), x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
  })
}

async function find (match, { timeout = 60_000 } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    const hit = elements().find((e) => match(e.text) || match(e.label))
    if (hit) return hit
    if (Date.now() > end) throw new Error(`Not on screen in ${timeout / 1000}s: ${match}`)
    await sleep(1000)
  }
}

const exactly = (s) => Object.assign((v) => v === s, { toString: () => JSON.stringify(s) })
const containing = (s) => Object.assign((v) => v.includes(s), { toString: () => `…${s}…` })

async function tap (match, opts) {
  const e = await find(match, opts)
  adb('shell', 'input', 'tap', String(e.x), String(e.y))
  await sleep(500)
}

async function type (match, text) {
  await tap(match)
  adb('shell', 'input', 'text', text.replace(/ /g, '%s'))
  adb('shell', 'input', 'keyevent', '4') // the keyboard away
  await sleep(500)
}

const work = mkdtempSync(path.join(tmpdir(), 'pai-e2e-'))
const desk = path.join(work, 'desk')
const pai = (...args) => execFileSync(process.execPath, [bin, ...args], { cwd: desk, encoding: 'utf8' }).trim()
let daemon = null

try {
  step('a fresh identity on this computer, and its daemon')
  execFileSync('mkdir', ['-p', desk])
  pai('init', '--name', 'desk', '--group')
  pai('group', 'create')
  daemon = spawn(process.execPath, [bin, 'daemon', '--listen', '127.0.0.1:0'], { cwd: desk, stdio: ['ignore', 'pipe', 'inherit'] })
  const id = await new Promise((resolve, reject) => {
    let out = ''
    daemon.stdout.on('data', (d) => { out += d; const m = out.match(/^id: ([0-9a-f]{64})$/m); if (m) resolve(m[1]) })
    daemon.on('exit', () => { reject(new Error(`The daemon stopped: ${out}`)) })
  })
  const code = pai('device', 'invite').split('\n')[0]

  step(`the app, with clean data (${path.relative(process.cwd(), apk)})`)
  adb('install', '-r', apk)
  adb('shell', 'pm', 'clear', PACKAGE)
  adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`)

  step('joins as a device of the identity')
  await type(exactly('Invite code'), code)
  await tap(exactly('Join'))
  await find(exactly('Inbox'), { timeout: 180_000 })

  step('a workflow waits on the phone\'s approval')
  const flow = path.join(work, 'flow.json')
  writeFileSync(flow, JSON.stringify({
    name: 'approve-it',
    steps: [
      { name: 'approve', to: id, text: 'Ship {{input}}?' },
      { name: 'ship', to: 'role:nobody', after: ['approve'], if: { step: 'approve', equals: 'approved' }, text: 'Ship it' },
      { name: 'rejected', to: 'role:nobody', after: ['approve'], if: { step: 'approve', failed: true }, text: 'Rejected' }
    ]
  }))
  const flowId = pai('flow', 'start', flow, 'v1.2').split(/\s/)[0]
  await tap(exactly('Take it'), { timeout: 120_000 })

  step('answers with the step\'s choice button')
  await tap(exactly('approved → ship'))
  const end = Date.now() + 60_000
  for (;;) {
    const status = pai('flow', 'get', flowId)
    if (/ship\s+\S+\s+job/.test(status) || /approve\s+\S+\s+done/.test(status)) break
    if (Date.now() > end) throw new Error(`The workflow didn't move on:\n${status}`)
    await sleep(2000)
  }
  console.log('ok: the phone joined, and its approval moved the workflow on')
} catch (err) {
  // E2E_HOLD=<seconds>: keep the daemon (and its folder) up after a
  // failure, to look at the phone.
  if (process.env.E2E_HOLD) {
    console.error(err)
    console.error(`holding ${process.env.E2E_HOLD}s; the daemon's folder: ${desk}`)
    await sleep(Number(process.env.E2E_HOLD) * 1000)
  }
  throw err
} finally {
  daemon?.kill('SIGINT')
  rmSync(work, { recursive: true, force: true })
}
