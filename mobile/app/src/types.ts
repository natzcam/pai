// The shapes pai's worklet sends (see pai's src/group/jobs.ts, flows.ts
// and mobile/worklet/src/node.ts), as far as the app reads them.

export interface Status {
  joined: boolean
  running: boolean
  name: string | null
  identity: string | null
  device: string | null
  // The identity's groups; and across them its roles, their members, and
  // whether it can write to all of them yet.
  groups: Array<{ id: string, name: string, title: string | null, members: number, roles: string[], writable: boolean }>
  roles: string[]
  members: number
  writable: boolean
  peers: number
  problem: string | null
}

export interface PhoneSecrets { pai: 'phone/1', name: string, secretKey: string, identity: string, secret: string, groups: Array<{ name: string, slot: string, key: string, seed: string }> }

export interface Choices {
  answers: Array<{ text: string, leadsTo: string[] }>
  otherwise: string[]
  onFail: string[]
}

export type JobState = 'open' | 'claimed' | 'done' | 'failed' | 'canceled'

export interface Job {
  // The group it's on (its name).
  group: string
  id: string
  by: string
  spec: { text: string, data?: unknown, attach?: string[], context?: string }
  to: string | null
  state: JobState
  claim: { by: string, writer: string, at: number, hand?: true } | null
  result: string | null
  at: number
  updated: number
  flow?: { id: string, step: string, item?: number, round?: number }
  question?: { n: number, text: string, answer: string | null } | null
  attempt?: number
  lastError?: string | null
}

export interface Proposal { group: string, pid: string, op: { type: string, [k: string]: unknown }, by: string, at: number, approvals: string[] }

export interface Inbox {
  questions: Job[]
  open: Job[]
  held: Job[]
  proposals: Proposal[]
  inputs: Record<string, string>
  choices: Record<string, Choices>
}

export interface Member { id: string, name: string | null, roles: string[] }

export type FlowState = 'running' | 'done' | 'failed' | 'canceled'

export interface FlowSummary { group: string, id: string, by: string, name: string | null, state: FlowState, steps: number, done: number, skipped: number, failed: number, parent: string | null, schedule: string | null, at: number, updated: number }

export interface FlowView {
  id: string
  by: string
  input: string
  name: string | null
  state: FlowState
  // A sub-workflow step has `flow` and no `to`.
  steps: Array<{ name: string, to?: string | null, flow?: unknown, if?: { step: string, equals?: string, contains?: string, failed?: true, not?: boolean }, repeat?: { from: string, max: number } }>
  done: string[]
  skipped: string[]
  failed: string[]
  jobs: Record<string, string>
  items?: Record<string, { n: number, done: number, failed?: number }>
  loops?: Record<string, { round: number, over: boolean }>
  output: string | null
}
