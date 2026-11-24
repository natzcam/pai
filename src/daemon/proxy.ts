import type { AgentCard } from '../a2a/types.js'
import { A2A_METHODS, A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, SERVICE_PARAMS } from '../a2a/types.js'
import { PaiRpcError } from '../errors.js'
import type { CardInput, RawRequestHandler } from '../pai.js'
import { ErrorCodes, serviceParameter } from '../protocol/jsonrpc.js'
import type { JsonRpcRequest } from '../protocol/jsonrpc.js'
import { streamed, unary } from './http.js'

// --proxy: fronts an existing A2A agent that speaks the JSON-RPC binding
// over HTTP. Requests from pai peers are forwarded unchanged, and the
// upstream owns tasks, history and streaming. The caller's agent id goes
// along as X-Pai-Caller.

export const CALLER_HEADER = 'X-Pai-Caller'

const STREAMING: ReadonlySet<string> = new Set([A2A_METHODS.sendStreamingMessage, A2A_METHODS.subscribeToTask])

export interface ProxyOptions {
  // Extra headers for every upstream request (an API key, say).
  headers?: Record<string, string>
  fetch?: typeof fetch
}

export function proxyHandler (upstream: string, opts: ProxyOptions = {}): RawRequestHandler {
  const fetchImpl = opts.fetch ?? fetch
  return (req, ctx) => {
    const call = (): Promise<Response> => forward(fetchImpl, upstream, req, ctx.peer, opts.headers)
    return STREAMING.has(req.method) ? forwardStream(call) : call().then((res) => unary(res, upstreamFailure))
  }
}

// The upstream's card, ready to publish over pai: its own interfaces are
// local URLs that mean nothing to remote agents, so pai's replaces them.
export async function upstreamCard (upstream: string, opts: ProxyOptions = {}): Promise<CardInput> {
  const url = new URL(AGENT_CARD_PATH, upstream)
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(url, { headers: { Accept: 'application/json', ...opts.headers } })
  } catch (err) {
    throw new Error(`Couldn't reach the upstream agent at ${url}: ${(err as Error).message}`)
  }
  if (!res.ok) throw new Error(`The upstream agent's card at ${url} returned ${res.status}`)
  const { supportedInterfaces: _interfaces, ...card } = await res.json() as AgentCard
  return card
}

async function forward (fetchImpl: typeof fetch, upstream: string, req: JsonRpcRequest, caller: string, extra: Record<string, string> = {}): Promise<Response> {
  const { 'a2a-service-parameters': _params, ...envelope } = req
  const headers: Record<string, string> = {
    ...extra,
    'Content-Type': 'application/json',
    Accept: STREAMING.has(req.method) ? 'text/event-stream, application/json' : 'application/json',
    [SERVICE_PARAMS.version]: serviceParameter(req, SERVICE_PARAMS.version) ?? A2A_PROTOCOL_VERSION,
    [CALLER_HEADER]: caller
  }
  const extensions = serviceParameter(req, SERVICE_PARAMS.extensions)
  if (extensions) headers[SERVICE_PARAMS.extensions] = extensions
  try {
    return await fetchImpl(upstream, { method: 'POST', headers, body: JSON.stringify(envelope) })
  } catch (err) {
    throw upstreamError(`Upstream agent unreachable: ${(err as Error).message}`)
  }
}

async function * forwardStream (call: () => Promise<Response>): AsyncGenerator<unknown> {
  yield * streamed(await call(), upstreamFailure)
}

function upstreamFailure (message: string): PaiRpcError {
  return upstreamError(`Upstream agent: ${message}`)
}

function upstreamError (message: string): PaiRpcError {
  return new PaiRpcError(ErrorCodes.InternalError, message, [{
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason: 'UPSTREAM_UNAVAILABLE',
    domain: 'pai'
  }])
}
