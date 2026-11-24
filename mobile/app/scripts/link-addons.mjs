// Builds the worklet's native addons (sodium, udx, rocksdb...) for each
// platform into react-native-bare-kit, which embeds them in the app: the
// other half of pack-worklet.mjs's `--linked`. Each run starts from empty,
// so an addon the worklet stopped using doesn't linger (lahar's lesson).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import link from 'bare-link'

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const workletDir = path.join(appDir, '..', 'worklet')
const require = createRequire(import.meta.url)
const bareKitDir = path.dirname(require.resolve('react-native-bare-kit/package.json'))

const TARGETS = [
  // 64-bit only (app.json's buildArchs): some addons ship no 32-bit
  // prebuild (bare-inspect's android-arm is an empty file), and a phone on
  // Android 10+ (minSdkVersion 29) is 64-bit all but always.
  { platform: 'android', hosts: ['android-arm64', 'android-x64'], out: path.join(bareKitDir, 'android', 'src', 'main', 'addons') },
  { platform: 'ios', hosts: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'], out: path.join(bareKitDir, 'ios', 'addons') }
]
const only = process.argv.includes('--platform') ? process.argv[process.argv.indexOf('--platform') + 1] : undefined

for (const { platform, hosts, out } of TARGETS.filter((t) => !only || t.platform === only)) {
  fs.rmSync(out, { recursive: true, force: true })
  let count = 0
  for await (const resource of link(workletDir, { hosts, out })) {
    count++
    if (process.env.VERBOSE) console.log(`  ${resource}`)
  }
  if (count === 0) throw new Error(`bare-link found no addons for ${platform}: the worklet would fail with ADDON_NOT_FOUND`)
  console.log(`linked ${count} ${platform} addon librar${count === 1 ? 'y' : 'ies'} -> ${path.relative(appDir, out)}`)
}

// An addon built against a newer Bare than the one react-native-bare-kit
// embeds fails on the device only, when loaded ("cannot locate symbol";
// bare-type 1.5+ needs js_is_detachable_arraybuffer, which bare-kit 0.16's
// runtime lacks: ../worklet/package.json pins it). Checked here instead,
// for Android, with the NDK's llvm-nm: every js_/uv_/bare_ symbol each
// addon needs must be one the runtime exports.
const ndk = path.join(process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? '', 'ndk')
const nm = fs.existsSync(ndk) ? fs.readdirSync(ndk).sort().reverse().map((v) => path.join(ndk, v, 'toolchains', 'llvm', 'prebuilt', `${process.platform}-x86_64`, 'bin', 'llvm-nm')).find((f) => fs.existsSync(f)) : undefined
if (only === undefined || only === 'android') {
  if (nm === undefined) {
    console.warn('No NDK llvm-nm (ANDROID_HOME/ndk): skipped checking addons against the Bare runtime')
  } else {
    const symbols = (args, file) => execFileSync(nm, [...args, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean)
    for (const abi of ['arm64-v8a', 'x86_64']) {
      const runtime = path.join(bareKitDir, 'android', 'libs', 'bare-kit', 'jni', abi, 'libbare-kit.so')
      const has = new Set(symbols(['-D', '--defined-only'], runtime))
      const dir = path.join(bareKitDir, 'android', 'src', 'main', 'addons', abi)
      for (const lib of fs.readdirSync(dir)) {
        // A package with no prebuild for the platform links an empty file.
        if (fs.statSync(path.join(dir, lib)).size === 0) throw new Error(`${abi}/${lib} is empty: its package has no prebuild for ${abi}`)
        const missing = symbols(['-D', '--undefined-only'], path.join(dir, lib)).filter((s) => /^(js_|uv_|bare_)/.test(s) && !has.has(s))
        if (missing.length > 0) throw new Error(`${abi}/${lib} needs ${missing.join(', ')}, which react-native-bare-kit's Bare doesn't have: pin an older version of its package in ../worklet/package.json's overrides`)
      }
    }
    console.log('checked the Android addons against react-native-bare-kit\'s Bare')
  }
}
