// Calls the summarizer with the official A2A JS SDK, through the local
// `pai daemon` gateway. Nothing here knows about pai: it's plain A2A.
//
//   (in the folder of an agent in the summarizer's group, running `pai daemon`)
//   node sdk-client.mjs <summarizer id> [file] [--token-file .pai/daemon-token] [--gateway http://127.0.0.1:7777]
//
// Needs `npm install @a2a-js/sdk` (already a dev dependency of pai).
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { text } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import { Role, TaskState } from '@a2a-js/sdk'
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory, createAuthenticatingFetchWithRetry } from '@a2a-js/sdk/client'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'token-file': { type: 'string', default: '.pai/daemon-token' }, gateway: { type: 'string', default: 'http://127.0.0.1:7777' } }
})
const [id, file] = positionals
if (!id) {
  console.error('Usage: node sdk-client.mjs <summarizer id> [file] [--token-file <path>] [--gateway <url>]')
  process.exit(2)
}
const article = file ? await readFile(file, 'utf-8') : await text(process.stdin)
const token = (await readFile(values['token-file'], 'utf-8')).trim()

// The gateway wants its token as a bearer token on every request.
const fetchImpl = createAuthenticatingFetchWithRetry(fetch, {
  headers: async () => ({ Authorization: `Bearer ${token}` }),
  shouldRetryWithHeaders: async () => undefined
})
const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
  transports: [new JsonRpcTransportFactory({ fetchImpl })],
  cardResolver: new DefaultAgentCardResolver({ fetchImpl })
}))
// The trailing slash matters: the SDK resolves the card path relative to it.
const client = await factory.createFromUrl(`${values.gateway}/agents/${id}/`)
console.error(`Connected to ${(await client.getAgentCard()).name}`)

const message = {
  messageId: randomUUID(),
  contextId: '',
  taskId: '',
  role: Role.ROLE_USER,
  parts: [{ content: { $case: 'text', value: article }, metadata: undefined, filename: '', mediaType: '' }],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: []
}
let state = TaskState.TASK_STATE_UNSPECIFIED
for await (const { payload } of client.sendMessageStream({ tenant: '', message, configuration: undefined, metadata: undefined })) {
  if (payload?.$case === 'artifactUpdate') {
    for (const part of payload.value.artifact?.parts ?? []) if (part.content?.$case === 'text') process.stdout.write(part.content.value)
  } else if (payload?.$case === 'statusUpdate') {
    state = payload.value.status?.state ?? state
  }
}
console.error(`(${TaskState[state].replace('TASK_STATE_', '').toLowerCase()})`)
