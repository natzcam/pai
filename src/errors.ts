import { ErrorCodes } from './protocol/jsonrpc.js'

const ERROR_INFO = 'type.googleapis.com/google.rpc.ErrorInfo'
const BAD_REQUEST = 'type.googleapis.com/google.rpc.BadRequest'
const A2A_DOMAIN = 'a2a-protocol.org'

// google.rpc.ErrorInfo, as A2A v1.0 puts it in JSON-RPC error.data.
export interface ErrorInfo {
  '@type': typeof ERROR_INFO
  reason: string
  domain: string
  metadata?: Record<string, string>
}

// A JSON-RPC error, thrown by handlers to send a specific code and raised
// on the client when the remote agent responds with an error. `data` is the
// array of error details (ProtoJSON Any objects) that A2A v1.0 specifies.
export class PaiRpcError extends Error {
  constructor (readonly code: number, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'PaiRpcError'
  }

  // The ErrorInfo reason (e.g. TASK_NOT_FOUND), when the error carries one.
  get reason (): string | undefined {
    if (!Array.isArray(this.data)) return undefined
    const info = this.data.find((d) => typeof d === 'object' && d !== null && d['@type'] === ERROR_INFO)
    return typeof info?.reason === 'string' ? info.reason : undefined
  }

  static a2a (code: number, reason: string, message: string, metadata?: Record<string, string>): PaiRpcError {
    const info: ErrorInfo = { '@type': ERROR_INFO, reason, domain: A2A_DOMAIN }
    if (metadata) info.metadata = metadata
    return new PaiRpcError(code, message, [info])
  }

  static taskNotFound (taskId: string): PaiRpcError {
    return PaiRpcError.a2a(ErrorCodes.TaskNotFound, 'TASK_NOT_FOUND', 'Task not found', { taskId })
  }

  static taskNotCancelable (taskId: string, state: string): PaiRpcError {
    return PaiRpcError.a2a(ErrorCodes.TaskNotCancelable, 'TASK_NOT_CANCELABLE', `Task is ${state} and cannot be canceled`, { taskId })
  }

  static unsupported (what: string): PaiRpcError {
    return PaiRpcError.a2a(ErrorCodes.UnsupportedOperation, 'UNSUPPORTED_OPERATION', `Unsupported operation: ${what}`)
  }

  static pushNotSupported (): PaiRpcError {
    return PaiRpcError.a2a(ErrorCodes.PushNotificationNotSupported, 'PUSH_NOTIFICATION_NOT_SUPPORTED', 'Push notifications are not supported')
  }

  static extendedCardNotConfigured (): PaiRpcError {
    return PaiRpcError.a2a(ErrorCodes.ExtendedAgentCardNotConfigured, 'EXTENDED_AGENT_CARD_NOT_CONFIGURED', 'This agent has no extended agent card')
  }

  static versionNotSupported (version: string, supported: string): PaiRpcError {
    return PaiRpcError.a2a(ErrorCodes.VersionNotSupported, 'VERSION_NOT_SUPPORTED', `A2A version ${version} is not supported; use ${supported}`, { version, supported })
  }

  // With `field`, a google.rpc.BadRequest names the field that's wrong.
  static invalidParams (message: string, field?: string): PaiRpcError {
    const data = field ? [{ '@type': BAD_REQUEST, fieldViolations: [{ field, description: message }] }] : undefined
    return new PaiRpcError(ErrorCodes.InvalidParams, message, data)
  }
}

// The remote peer failed identity authentication, or dropped the connection
// before authenticating.
export class PaiAuthError extends Error {
  constructor (message = 'Peer failed authentication') {
    super(message)
    this.name = 'PaiAuthError'
  }
}

export class PaiConnectionError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'PaiConnectionError'
  }
}

// A card that doesn't match the A2A AgentCard schema: thrown when writing
// one, and when reading a remote one in strict mode.
export class PaiCardError extends Error {
  constructor (readonly errors: string[], readonly card: unknown) {
    super(`Invalid agent card: ${errors.join('; ')}`)
    this.name = 'PaiCardError'
  }
}
