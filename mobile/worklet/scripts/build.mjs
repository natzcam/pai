// Bundles pai's core for Bare (see ../README.md): pai's own source with its
// few Node built-ins mapped to Bare's (crypto to src/shims/crypto.ts), and
// every package left external, so Bare resolves each one's own Bare build
// (they pick it by their "bare" import conditions). bare-pack then packs a
// bundle for the phone (../app/scripts/pack-worklet.mjs); Bare runs
// dist/*.cjs as it is in test/bare.test.ts.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join } from 'node:path'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const mapped = {
  'node:crypto': join(here, 'src/shims/crypto.ts'),
  'node:fs/promises': join(here, 'src/shims/fs-promises.ts'),
  'node:path': 'bare-path',
  'node:events': 'bare-events'
}

const bare = {
  name: 'bare',
  setup (b) {
    b.onResolve({ filter: /^node:/ }, (args) => {
      const to = mapped[args.path]
      if (to === undefined) return { errors: [{ text: `${args.path} has no Bare mapping (imported by ${args.importer})` }] }
      return isAbsolute(to) ? { path: to } : { path: to, external: true }
    })
  }
}

const entries = process.argv.slice(2)
await build({
  entryPoints: (entries.length ? entries : ['src/worklet.ts']).map((e) => join(here, e)),
  outdir: join(here, 'dist'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  mainFields: ['main', 'module'],
  packages: 'external',
  inject: [join(here, 'src/shims/globals.ts')],
  plugins: [bare],
  logLevel: 'warning'
})
