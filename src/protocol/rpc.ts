import { randomUUID } from 'node:crypto'
import { PaiConnectionError, PaiRpcError } from '../errors.js'
import { EventQueue } from '../util/queue.js'
import type { JsonRpcFailure, JsonRpcId, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, StreamEnd } from './jsonrpc.js'
import { ErrorCodes, failure, isFailure, isRequest, isResponse, isStreamEnd, request, streamEnd, success } from './jsonrpc.js'

// Where envelopes for one remote agent go, such as the a2a/v1 channel.
export interface Outbox {
  send (envelope: JsonRpcMessage | StreamEnd): void
}

// Return a value for a single response, or an async iterable to stream:
// every item is sent as a response carrying the request's id, then a
// StreamEnd frame once the iterable is done.
export type RequestHandler = (req: JsonRpcRequest) => Promise<unknown> | AsyncIterable<unknown>

export interface RpcOptions {
  // Sent with every outgoing request (A2A-Version, A2A-Extensions).
  serviceParameters?: Record<string, string>
}

export interface CallOptions {
  // Added to the connection's service parameters for this request.
  serviceParameters?: Record<string, string>
}

interface Pending {
  stream: boolean
  resolve (result: unknown): void
  end? (): void
  reject (err: Error): void
}

// Symmetric JSON-RPC endpoint over one a2a/v1 channel: either side can send
// requests, and responses are matched back by id.
export class RpcConnection {
  #pending = new Map<JsonRpcId, Pending>()
  #closed = false

  constructor (readonly outbox: Outbox, readonly onRequest: RequestHandler, readonly options: RpcOptions = {}) {}

  get closed (): boolean {
    return this.#closed
  }

  request<R> (method: string, params?: unknown, opts: CallOptions = {}): Promise<R> {
    if (this.#closed) return Promise.reject(new PaiConnectionError('Connection closed'))
    const id = randomUUID()
    return new Promise<R>((resolve, reject) => {
      const pending: Pending = { stream: false, resolve: resolve as (r: unknown) => void, reject }
      this.#pending.set(id, pending)
      this.outbox.send(this.#request(id, method, params, opts))
    })
  }

  // Sends one request and yields every response for its id, until the
  // remote sends the stream's end frame or responds with an error.
  async * stream<T> (method: string, params: unknown, opts: CallOptions = {}): AsyncGenerator<T> {
    if (this.#closed) throw new PaiConnectionError('Connection closed')
    const id = randomUUID()
    const queue = new EventQueue<T>()
    const pending: Pending = {
      stream: true,
      resolve: (item) => { queue.push(item as T) },
      end: () => { queue.end() },
      reject: (err) => queue.fail(err)
    }
    this.#pending.set(id, pending)
    this.outbox.send(this.#request(id, method, params, opts))
    try {
      yield * queue
    } finally {
      // Late responses after an early break are ignored.
      this.#pending.delete(id)
    }
  }

  receive (raw: unknown): void {
    if (isRequest(raw)) {
      void this.#handle(raw)
    } else if (isResponse(raw)) {
      this.#settle(raw)
    } else if (isStreamEnd(raw)) {
      const pending = this.#pending.get(raw.id)
      if (pending?.stream) {
        this.#pending.delete(raw.id)
        pending.end?.()
      }
    } else {
      this.outbox.send(failure(null, ErrorCodes.InvalidRequest, 'Invalid JSON-RPC 2.0 envelope'))
    }
  }

  close (): void {
    if (this.#closed) return
    this.#closed = true
    const err = new PaiConnectionError('Connection closed')
    for (const pending of this.#pending.values()) pending.reject(err)
    this.#pending.clear()
  }

  async #handle (req: JsonRpcRequest): Promise<void> {
    try {
      const out = this.onRequest(req)
      if (isAsyncIterable(out)) {
        for await (const item of out) {
          if (this.#closed) return
          this.#respond(success(req.id, item))
        }
        if (!this.#closed) this.outbox.send(streamEnd(req.id))
      } else {
        this.#respond(success(req.id, await out))
      }
    } catch (err) {
      this.#respond(toFailure(req.id, err))
    }
  }

  #request (id: JsonRpcId, method: string, params: unknown, opts: CallOptions): JsonRpcRequest {
    const serviceParameters = { ...this.options.serviceParameters, ...opts.serviceParameters }
    return request(id, method, params, Object.keys(serviceParameters).length ? serviceParameters : undefined)
  }

  #respond (res: JsonRpcResponse): void {
    if (!this.#closed) this.outbox.send(res)
  }

  #settle (res: JsonRpcResponse): void {
    if (res.id === null) return
    const pending = this.#pending.get(res.id)
    if (!pending) return
    if (isFailure(res)) {
      this.#pending.delete(res.id)
      pending.reject(new PaiRpcError(res.error.code, res.error.message, res.error.data))
      return
    }
    if (!pending.stream) this.#pending.delete(res.id)
    pending.resolve(res.result)
  }
}

function toFailure (id: JsonRpcId, err: unknown): JsonRpcFailure {
  return err instanceof PaiRpcError
    ? failure(id, err.code, err.message, err.data)
    : failure(id, ErrorCodes.InternalError, err instanceof Error ? err.message : String(err))
}

function isAsyncIterable (v: unknown): v is AsyncIterable<unknown> {
  return typeof v === 'object' && v !== null && Symbol.asyncIterator in v
}
