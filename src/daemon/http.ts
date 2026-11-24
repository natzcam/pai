import { PaiRpcError } from '../errors.js'
import { ErrorCodes } from '../protocol/jsonrpc.js'

// Reading A2A's JSON-RPC binding over HTTP, shared by --proxy (calling the
// upstream) and the daemon client (calling the gateway). `fail` makes the
// error for a response that isn't JSON-RPC at all.

export type Fail = (message: string) => Error

export async function unary (res: Response, fail: Fail): Promise<unknown> {
  return resultOf(await readJson(res, fail), fail)
}

// The results of an SSE response, or the single result of a JSON one (an
// error, or a server that answered in one piece).
export async function * streamed (res: Response, fail: Fail): AsyncGenerator<unknown> {
  if (!isEventStream(res)) {
    yield resultOf(await readJson(res, fail), fail)
    return
  }
  if (!res.body) return
  for await (const event of sseEvents(res.body)) yield resultOf(parse(event.data, fail), fail)
}

export function isEventStream (res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('text/event-stream')
}

export async function readJson (res: Response, fail: Fail): Promise<unknown> {
  const text = await res.text()
  if (!res.ok && !text) throw fail(`HTTP ${res.status}`)
  return parse(text, fail)
}

function parse (text: string, fail: Fail): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw fail('The response is not JSON')
  }
}

// A JSON-RPC response's result, or its error rethrown.
function resultOf (body: unknown, fail: Fail): unknown {
  const res = body as { result?: unknown, error?: { code?: unknown, message?: unknown, data?: unknown } } | null
  if (res?.error) {
    const { code, message, data } = res.error
    throw new PaiRpcError(typeof code === 'number' ? code : ErrorCodes.InternalError, typeof message === 'string' ? message : 'Remote error', data)
  }
  if (res === null || typeof res !== 'object' || !('result' in res)) throw fail('Not a JSON-RPC response')
  return res.result
}

export interface SseEvent { event: string, data: string }

// Each server-sent event, with its type ('message' unless named).
export async function * sseEvents (body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data: string[] = []
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') {
        if (data.length) yield { event: event || 'message', data: data.join('\n') }
        event = ''
        data = []
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''))
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      }
    }
  }
  if (data.length) yield { event: event || 'message', data: data.join('\n') }
}
