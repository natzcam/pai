// A2A protocol v1.0 data model (the subset pai uses), as JSON.
// https://a2a-protocol.org/latest/specification/ and specification/a2a.proto

export const A2A_PROTOCOL_VERSION = '1.0'
export const AGENT_CARD_PATH = '/.well-known/agent-card.json'
// Identifies the pai transport in AgentCard.supportedInterfaces: the URI of
// its spec, BINDING.md. A breaking change to the binding needs a new URI.
export const PAI_BINDING = 'https://github.com/natzcam/pai/blob/main/BINDING.md'

export interface AgentInterface {
  // For pai agents this is `pai://<hex agent id>`.
  url: string
  protocolBinding: string
  protocolVersion: string
  tenant?: string
}

export interface AgentProvider {
  url: string
  organization: string
}

export interface AgentExtension {
  uri: string
  description?: string
  required?: boolean
  params?: Record<string, unknown>
}

export interface AgentCapabilities {
  streaming?: boolean
  pushNotifications?: boolean
  extensions?: AgentExtension[]
  extendedAgentCard?: boolean
}

export interface SecurityRequirement {
  schemes: Record<string, { list: string[] }>
}

export interface AgentSkill {
  id: string
  name: string
  description: string
  tags: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
  securityRequirements?: SecurityRequirement[]
}

export interface AgentCardSignature {
  protected: string
  signature: string
  header?: Record<string, unknown>
}

export interface AgentCard {
  name: string
  description: string
  // Ordered by preference; clients use the first one they support.
  supportedInterfaces: AgentInterface[]
  provider?: AgentProvider
  version: string
  documentationUrl?: string
  capabilities: AgentCapabilities
  // SecurityScheme objects, as the spec defines them. pai doesn't model them.
  securitySchemes?: Record<string, Record<string, unknown>>
  securityRequirements?: SecurityRequirement[]
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: AgentSkill[]
  signatures?: AgentCardSignature[]
  iconUrl?: string
}

interface PartCommon {
  metadata?: Record<string, unknown>
  filename?: string
  mediaType?: string
}

// Exactly one of text, raw (base64 bytes), url or data.
export type TextPart = PartCommon & { text: string }
export type RawPart = PartCommon & { raw: string }
export type UrlPart = PartCommon & { url: string }
export type DataPart = PartCommon & { data: unknown }
export type Part = TextPart | RawPart | UrlPart | DataPart

export type Role = 'ROLE_USER' | 'ROLE_AGENT'

export interface Message {
  messageId: string
  contextId?: string
  taskId?: string
  role: Role
  parts: Part[]
  metadata?: Record<string, unknown>
  extensions?: string[]
  referenceTaskIds?: string[]
}

export type TaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED'

export interface TaskStatus {
  state: TaskState
  message?: Message
  // ISO 8601, UTC, milliseconds.
  timestamp?: string
}

export interface Artifact {
  artifactId: string
  name?: string
  description?: string
  parts: Part[]
  metadata?: Record<string, unknown>
  extensions?: string[]
}

export interface Task {
  id: string
  contextId: string
  status: TaskStatus
  artifacts?: Artifact[]
  history?: Message[]
  metadata?: Record<string, unknown>
}

export interface TaskStatusUpdateEvent {
  taskId: string
  contextId: string
  status: TaskStatus
  metadata?: Record<string, unknown>
}

export interface TaskArtifactUpdateEvent {
  taskId: string
  contextId: string
  artifact: Artifact
  append?: boolean
  lastChunk?: boolean
  metadata?: Record<string, unknown>
}

// SendMessage's result: exactly one member.
export type SendMessageResponse = { task: Task } | { message: Message }

// One item of SendStreamingMessage or SubscribeToTask: exactly one member.
export type StreamResponse =
  | { task: Task }
  | { message: Message }
  | { statusUpdate: TaskStatusUpdateEvent }
  | { artifactUpdate: TaskArtifactUpdateEvent }

export interface SendMessageConfiguration {
  acceptedOutputModes?: string[]
  historyLength?: number
  // Return as soon as the task exists, instead of when it ends or needs input.
  returnImmediately?: boolean
}

export interface SendMessageRequest {
  tenant?: string
  message: Message
  configuration?: SendMessageConfiguration
  metadata?: Record<string, unknown>
}

export interface GetTaskRequest {
  tenant?: string
  id: string
  historyLength?: number
}

export interface CancelTaskRequest {
  tenant?: string
  id: string
  metadata?: Record<string, unknown>
}

export interface SubscribeToTaskRequest {
  tenant?: string
  id: string
}

export interface ListTasksRequest {
  tenant?: string
  contextId?: string
  status?: TaskState
  // 1 to 100, default 50.
  pageSize?: number
  pageToken?: string
  historyLength?: number
  statusTimestampAfter?: string
  includeArtifacts?: boolean
}

export interface ListTasksResponse {
  tasks: Task[]
  // Empty on the last page.
  nextPageToken: string
  pageSize: number
  totalSize: number
}

export const A2A_METHODS = {
  sendMessage: 'SendMessage',
  sendStreamingMessage: 'SendStreamingMessage',
  getTask: 'GetTask',
  listTasks: 'ListTasks',
  cancelTask: 'CancelTask',
  subscribeToTask: 'SubscribeToTask',
  createTaskPushNotificationConfig: 'CreateTaskPushNotificationConfig',
  getTaskPushNotificationConfig: 'GetTaskPushNotificationConfig',
  listTaskPushNotificationConfigs: 'ListTaskPushNotificationConfigs',
  deleteTaskPushNotificationConfig: 'DeleteTaskPushNotificationConfig',
  getExtendedAgentCard: 'GetExtendedAgentCard'
} as const

export type A2AMethod = typeof A2A_METHODS[keyof typeof A2A_METHODS]

// Standard service parameters (the binding carries them per request).
export const SERVICE_PARAMS = {
  version: 'A2A-Version',
  extensions: 'A2A-Extensions'
} as const
