import type { Artifact, Message, Task, TaskState, TaskStatus } from '../a2a/types.js'

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_FAILED',
  'TASK_STATE_REJECTED'
])

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  TASK_STATE_SUBMITTED: ['TASK_STATE_WORKING', 'TASK_STATE_REJECTED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED', 'TASK_STATE_AUTH_REQUIRED'],
  TASK_STATE_WORKING: ['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED', 'TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED'],
  TASK_STATE_INPUT_REQUIRED: ['TASK_STATE_WORKING', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED'],
  TASK_STATE_AUTH_REQUIRED: ['TASK_STATE_WORKING', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED'],
  TASK_STATE_COMPLETED: [],
  TASK_STATE_CANCELED: [],
  TASK_STATE_FAILED: [],
  TASK_STATE_REJECTED: []
}

export function isTaskState (v: unknown): v is TaskState {
  return typeof v === 'string' && v in TRANSITIONS
}

export function isTerminal (state: TaskState): boolean {
  return TERMINAL_STATES.has(state)
}

export function canTransition (from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to)
}

export class InvalidTransitionError extends Error {
  constructor (readonly from: TaskState, readonly to: TaskState) {
    super(`Invalid task transition: ${from} -> ${to}`)
    this.name = 'InvalidTransitionError'
  }
}

// Applies a status change to a task snapshot, enforcing the A2A lifecycle.
// Returns a new task; the input is not mutated.
export function transition (task: Task, state: TaskState, message?: Message, now = new Date()): Task {
  const from = task.status.state
  if (!canTransition(from, state)) throw new InvalidTransitionError(from, state)
  const status: TaskStatus = { state, timestamp: now.toISOString() }
  if (message) status.message = message
  return { ...task, status }
}

// Adds an artifact. With `append`, parts are added to the existing artifact
// with the same id; otherwise an artifact with the same id is replaced.
export function appendArtifact (task: Task, artifact: Artifact, append = false): Task {
  const artifacts = [...(task.artifacts ?? [])]
  const index = artifacts.findIndex((a) => a.artifactId === artifact.artifactId)
  const existing = artifacts[index]
  if (!existing) artifacts.push(artifact)
  else artifacts[index] = append ? { ...existing, parts: [...existing.parts, ...artifact.parts] } : artifact
  return { ...task, artifacts }
}

// States after which the agent is waiting on the client.
export function isInterrupted (state: TaskState): boolean {
  return state === 'TASK_STATE_INPUT_REQUIRED' || state === 'TASK_STATE_AUTH_REQUIRED'
}

// Whether a stream for a task in this state ends: the task has ended, or
// waits for the client.
export function endsStream (state: TaskState): boolean {
  return isTerminal(state) || isInterrupted(state)
}

export function appendHistory (task: Task, message: Message): Task {
  return { ...task, history: [...(task.history ?? []), message] }
}

export function createTask (id: string, contextId: string, initial?: Message, now = new Date()): Task {
  return {
    id,
    contextId,
    status: { state: 'TASK_STATE_SUBMITTED', timestamp: now.toISOString() },
    history: initial ? [initial] : []
  }
}
