// JSON-RPC 2.0 envelopes, carried verbatim over the a2a/v1 Protomux channel.

export type JsonRpcId = string | number

// The binding has no headers, so A2A service parameters (A2A-Version,
// A2A-Extensions) travel on each request under this member.
export const SERVICE_PARAMETERS = 'a2a-service-parameters'

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: P
  [SERVICE_PARAMETERS]?: Record<string, string>
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: R
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  error: JsonRpcError
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcFailure
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse

export const ErrorCodes = {
  // JSON-RPC 2.0
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // A2A
  TaskNotFound: -32001,
  TaskNotCancelable: -32002,
  PushNotificationNotSupported: -32003,
  UnsupportedOperation: -32004,
  ContentTypeNotSupported: -32005,
  InvalidAgentResponse: -32006,
  ExtendedAgentCardNotConfigured: -32007,
  ExtensionSupportRequired: -32008,
  VersionNotSupported: -32009
} as const

export function request<P> (id: JsonRpcId, method: string, params?: P, serviceParameters?: Record<string, string>): JsonRpcRequest<P> {
  const req: JsonRpcRequest<P> = { jsonrpc: '2.0', id, method }
  if (params !== undefined) req.params = params
  if (serviceParameters) req[SERVICE_PARAMETERS] = serviceParameters
  return req
}

// A service parameter of a request. Keys are case-insensitive.
export function serviceParameter (req: JsonRpcRequest, name: string): string | undefined {
  const params = req[SERVICE_PARAMETERS]
  if (typeof params !== 'object' || params === null) return undefined
  const key = Object.keys(params).find((k) => k.toLowerCase() === name.toLowerCase())
  const value = key === undefined ? undefined : params[key]
  return typeof value === 'string' ? value : undefined
}

// Sent after the last response of a stream: the binding's equivalent of
// closing an SSE response. Not a JSON-RPC envelope.
export interface StreamEnd {
  type: 'pai/end'
  id: JsonRpcId
}

export function streamEnd (id: JsonRpcId): StreamEnd {
  return { type: 'pai/end', id }
}

export function isStreamEnd (msg: unknown): msg is StreamEnd {
  return typeof msg === 'object' && msg !== null && (msg as StreamEnd).type === 'pai/end' && isId((msg as StreamEnd).id)
}

export function success<R> (id: JsonRpcId, result: R): JsonRpcSuccess<R> {
  return { jsonrpc: '2.0', id, result }
}

export function failure (id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcFailure {
  const error: JsonRpcError = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id, error }
}

export function isRequest (msg: unknown): msg is JsonRpcRequest {
  return isEnvelope(msg) && typeof msg.method === 'string' && isId(msg.id)
}

export function isResponse (msg: unknown): msg is JsonRpcResponse {
  return isEnvelope(msg) && ('result' in msg || 'error' in msg) && (isId(msg.id) || msg.id === null)
}

export function isFailure (msg: JsonRpcResponse): msg is JsonRpcFailure {
  return 'error' in msg
}

// Validates an incoming decoded payload. Returns the message, or a failure
// response to send back when the payload is not a valid envelope.
export function parse (raw: unknown): JsonRpcMessage | JsonRpcFailure {
  if (isRequest(raw) || isResponse(raw)) return raw
  return failure(null, ErrorCodes.InvalidRequest, 'Invalid JSON-RPC 2.0 envelope')
}

function isEnvelope (msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).jsonrpc === '2.0'
}

function isId (id: unknown): id is JsonRpcId {
  return typeof id === 'string' || typeof id === 'number'
}
