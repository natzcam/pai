// The ambient types for the untyped Holepunch modules (src/types) aren't
// emitted by tsc, but the published declarations import those modules.
// Copy them into dist and reference them from the entry declaration.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'

await mkdir('dist/types', { recursive: true })
await copyFile('src/types/holepunch.d.ts', 'dist/types/holepunch.d.ts')
const ref = '/// <reference path="./types/holepunch.d.ts" />\n'
const index = await readFile('dist/index.d.ts', 'utf8')
if (!index.startsWith(ref)) await writeFile('dist/index.d.ts', ref + index)
