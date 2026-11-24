// Builds pai's worklet (../worklet: scripts/build.mjs makes
// dist/worklet.cjs) and packs it with bare-pack into one bundle per
// platform, which react-native-bare-kit's Worklet runs: worklet/app.bundle
// .<platform>.js, `export default "<base64>"`, picked by Metro per
// platform (src/worklet.ts imports ../worklet/app.bundle).
//
// From lahar's build, which found these the hard way:
// - `--linked` leaves native addons (sodium, udx, rocksdb...) as links;
//   scripts/link-addons.mjs builds them into the app.
// - `--base` is pai's root, so every file (the worklet's and pai's
//   node_modules) keys inside the mounted bundle; a key escaping it can't
//   be read on the device (CANNOT_READ), so it's checked here.
// - Inside a bundle a `.js` file is always CommonJS: the entry is `.cjs`,
//   and an ES module `.js` anywhere would fail on the device, also checked.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import b4a from 'b4a'
import Bundle from 'bare-bundle'

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const workletDir = path.join(appDir, '..', 'worklet')
const root = path.join(appDir, '..', '..')
const entry = path.join(workletDir, 'dist', 'worklet.cjs')
const outDir = path.join(appDir, 'worklet')
const require = createRequire(import.meta.url)
const barePack = path.join(path.dirname(require.resolve('bare-pack/package')), 'bin.js')

execFileSync(process.execPath, [path.join(workletDir, 'scripts', 'build.mjs'), 'src/worklet.ts'], { stdio: 'inherit', cwd: workletDir })
fs.mkdirSync(outDir, { recursive: true })

const HOSTS = { ios: 'ios-arm64', android: 'android-arm64' }
for (const [platform, host] of Object.entries(HOSTS)) {
  const out = path.join(outDir, `app.bundle.${platform}.js`)
  execFileSync(process.execPath, [barePack, '--host', host, '--linked', '--base', root, '--format', 'bundle.mjs', '--encoding', 'base64', '--out', out, entry], { stdio: 'inherit', cwd: root })

  const bundle = Bundle.from(b4a.from(readDefaultExport(out), 'base64'))
  const escaping = [bundle.main, ...bundle.keys()].filter((key) => key.startsWith('/../'))
  if (escaping.length > 0) throw new Error(`bare-pack keyed ${escaping.length} file(s) outside ${root}, unreadable on the device: ${escaping.slice(0, 5).join(', ')}`)
  const esm = [...bundle.keys()].filter((key) => key.endsWith('.js') && /^\s*(?:import|export)[\s{*]/m.test(bundle.read(key).toString()))
  if (esm.length > 0) throw new Error(`${esm.length} ES module(s) with a .js extension, which Bare reads as CommonJS: ${esm.slice(0, 5).join(', ')}`)
  console.log(`packed ${platform} (${host}) -> ${path.relative(appDir, out)} (${fs.statSync(out).size} bytes, ${[...bundle.keys()].length} files)`)
}

function readDefaultExport (file) {
  const match = fs.readFileSync(file, 'utf8').match(/^export default "([^"]*)"/)
  if (match === null) throw new Error(`Unexpected bare-pack output in ${file}`)
  return match[1]
}
