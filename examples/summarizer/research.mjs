// Sends an article to the summarizer agent and streams the summary back.
//
//   PAI_INVITE=<code> node research.mjs <summarizer id> [file]   (the first time)
//   node research.mjs <summarizer id> [file]                     (after that)
//
// The first run makes this script's identity and joins the summarizer's
// group with an invite (`pai group invite` where the summarizer runs); it
// keeps the keys in .pai-research/keys.json. Reads the article from the
// file, or from stdin.
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { GroupIdentity, Pai, createIdentity, joinGroup, loadKeyPair } from 'pai'

const [id, file] = process.argv.slice(2)
const storage = new URL('./.pai-research', import.meta.url).pathname
const keysFile = join(storage, 'keys.json')
let saved = await readFile(keysFile, 'utf-8').then(JSON.parse, () => null)
if (!id || (saved?.groups?.length ? false : !process.env.PAI_INVITE)) {
  console.error('Usage: PAI_INVITE=<code> node research.mjs <summarizer id> [file]  (PAI_INVITE: the first time)')
  process.exit(2)
}
const article = file ? await readFile(file, 'utf-8') : await text(process.stdin)

const hex = (b) => Buffer.from(b).toString('hex')
const bytes = (h) => Buffer.from(h, 'hex')
const keep = async () => {
  await mkdir(storage, { recursive: true })
  await writeFile(keysFile, JSON.stringify(saved), { mode: 0o600 })
  await chmod(keysFile, 0o600)
}

// The first time: an identity (kept at once, so a failed join can be tried
// again), then the group.
if (!saved) {
  const keyPair = await loadKeyPair(storage)
  const keys = await createIdentity({ storage, keyPair, name: 'research' })
  saved = { identity: hex(keys.identity), secret: hex(keys.secret), groups: [] }
  await keep()
}
const keys = { identity: bytes(saved.identity), secret: bytes(saved.secret) }
if (!saved.groups.length) {
  console.error('Joining the summarizer\'s group (its daemon has to be running)…')
  const g = await joinGroup({ storage, keys, keyPair: await loadKeyPair(storage), code: process.env.PAI_INVITE, name: 'research' })
  saved.groups = [{ name: g.name, slot: g.slot, key: hex(g.key), seed: hex(g.seed) }]
  await keep()
}

const pai = new Pai({
  identity: new GroupIdentity({
    storage,
    keys,
    groups: saved.groups.map((g) => ({ name: g.name, slot: g.slot, key: bytes(g.key), seed: bytes(g.seed) }))
  }),
  storage,
  card: {
    name: 'research',
    description: 'Research script that asks other agents',
    version: '1.0.0',
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'ask', name: 'Ask', description: 'Asks other agents', tags: ['research'] }]
  }
})
await pai.ready()

try {
  // The summarizer's identity: whichever of its devices answers.
  const summarizer = pai.agent(Buffer.from(id, 'hex'))
  console.error(`Connected to ${(await summarizer.card())?.name}`)
  const message = { role: 'ROLE_USER', messageId: randomUUID(), parts: [{ text: article }] }
  let state = ''
  for await (const item of summarizer.stream(message)) {
    if (item.artifactUpdate) {
      for (const part of item.artifactUpdate.artifact.parts) if (part.text) process.stdout.write(part.text)
    } else if (item.statusUpdate) {
      state = item.statusUpdate.status.state
    }
  }
  console.error(`(${state.replace('TASK_STATE_', '').toLowerCase()})`)
} finally {
  await pai.close()
}
