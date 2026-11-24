import { randomUUID } from 'node:crypto'
import type { Message, Part, StreamResponse, TaskState } from '../a2a/types.js'
import type { MessageHandler } from '../server.js'
import { killGroup, spawnGroup } from '../util/spawn.js'

const OUTPUT_ARTIFACT = 'output'
const OK_STATES = new Set<TaskState>(['TASK_STATE_COMPLETED', 'TASK_STATE_INPUT_REQUIRED'])
const QUIET_STATES = new Set<TaskState>(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'])


// Replies with the request's own parts.
export const echoHandler: MessageHandler = async (message, task) => {
  await task.update('TASK_STATE_WORKING')
  await task.artifact({ artifactId: OUTPUT_ARTIFACT, parts: message.parts })
  await task.update('TASK_STATE_COMPLETED')
}

export interface ExecOptions {
  // Send the whole A2A message as JSON on stdin instead of its text.
  json?: boolean
  env?: NodeJS.ProcessEnv
  cwd?: string
}

// Runs `command` in a shell for each message. The request's text (or, with
// json, the A2A message as JSON) goes to stdin; stdout streams back as one
// text artifact. Exit 0 completes the task; anything else fails it with the
// end of stderr. Canceling the task kills the command.
// stop() kills the commands still running, for shutdown.
export function execHandler (command: string, opts: ExecOptions = {}): MessageHandler & { stop (): void } {
  const running = new Set<number>()
  let stopped = false

  const handler: MessageHandler = async (message, task) => {
    if (stopped) {
      await task.update('TASK_STATE_FAILED', agentText('The agent is shutting down'))
      return
    }
    await task.update('TASK_STATE_WORKING')
    const { child, done } = spawnGroup(command, [], {
      shell: true,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: {
        ...(opts.env ?? process.env),
        PAI_TASK_ID: task.task.id,
        PAI_CONTEXT_ID: task.task.contextId,
        PAI_MESSAGE_ID: message.messageId
      }
    }, task.signal, running)
    child.stdin.end(opts.json ? JSON.stringify(message) : textOf(message.parts))

    // Chunks are sent in order: each waits for the previous one.
    let sent = Promise.resolve()
    let first = true
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      const append = !first
      first = false
      sent = sent.then(() => task.artifact({ artifactId: OUTPUT_ARTIFACT, parts: [{ text: chunk }] }, { append }))
    })

    const { code, stderr, error } = await done
    await sent
    if (task.signal.aborted) return

    if (!first) await task.artifact({ artifactId: OUTPUT_ARTIFACT, parts: [{ text: '' }] }, { append: true, lastChunk: true })
    if (code === 0) {
      await task.update('TASK_STATE_COMPLETED')
    } else {
      const reason = (stderr + (error ? error.message : '')).trim() || `exited with code ${code}`
      await task.update('TASK_STATE_FAILED', agentText(reason))
    }
  }
  return Object.assign(handler, {
    stop () {
      stopped = true
      for (const pid of running) killGroup(pid)
    }
  })
}

// An artifact's parts are joined with '' instead: streamed chunks, appended
// as parts, already carry their own newlines.
export function textOf (parts: Part[] | undefined, separator = '\n'): string {
  return (parts ?? []).map(partText).join(separator)
}

function partText (p: Part): string {
  if ('text' in p) return p.text
  if ('data' in p) return JSON.stringify(p.data)
  if ('url' in p) return `[${p.filename ?? 'file'} ${p.url}]`
  return `[${p.filename ?? 'file'}, ${Buffer.byteLength(p.raw, 'base64')} bytes]`
}

export function agentText (text: string): Message {
  return { role: 'ROLE_AGENT', messageId: randomUUID(), parts: [{ text }] }
}

export function userText (text: string, extra: Partial<Message> = {}): Message {
  return { role: 'ROLE_USER', messageId: randomUUID(), parts: [{ text }], ...extra }
}

// TASK_STATE_INPUT_REQUIRED → input-required, for people.
export function stateName (state: TaskState): string {
  return state.replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, '-')
}

// What a person wants to read from a result or stream item: new text, and
// status changes worth mentioning.
export function describe (item: StreamResponse): { text?: string, status?: string } {
  if ('message' in item) return { text: textOf(item.message.parts) }
  if ('task' in item) {
    // A status message is the reply when there's no artifact and the task
    // went well; otherwise it explains the status.
    const { status, artifacts } = item.task
    const statusText = textOf(status.message?.parts)
    const artifactText = (artifacts ?? []).map((a) => textOf(a.parts, '')).join('')
    const text = artifactText || (OK_STATES.has(status.state) ? statusText : '')
    if (QUIET_STATES.has(status.state)) return text ? { text } : {}
    return {
      ...(text ? { text } : {}),
      status: statusLine(status.state, text === statusText ? '' : statusText)
    }
  }
  if ('artifactUpdate' in item) return { text: textOf(item.artifactUpdate.artifact.parts, '') }
  const { status } = item.statusUpdate
  if (QUIET_STATES.has(status.state)) return {}
  return { status: statusLine(status.state, textOf(status.message?.parts)) }
}

function statusLine (state: TaskState, text: string): string {
  return text ? `${stateName(state)}: ${text}` : stateName(state)
}
