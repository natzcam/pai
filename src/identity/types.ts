import type { BootstrapNode } from 'hyperdht'
import type { AgentCard, Message, Task } from '../a2a/types.js'

// Who may read and act on tasks shared in groups.
export interface TaskAccess {
  // Whether `caller` may read `task` (a member of the group it's shared
  // in), or, without a task, any of this agent's shared tasks (a member of
  // any group it's in).
  canRead (caller: string, task?: Task | null): boolean
  // Whether `caller` may continue or cancel `task`, which `owner` created
  // (the creator, or an admin of the task's group).
  canControl (owner: string | null, caller: string, task: Task | null): boolean
  // The group a new task from `caller` (absent: a local call) is shared
  // in, recorded in its `pai/group` metadata; null: not shared.
  placement? (caller: string | undefined, message: Message): string | null
}

// Tasks shared in groups (see Identity.tasks): this agent's are published
// as they change, and every member's can be read from the local replicas.
export interface SharedTasks extends TaskAccess {
  // The task with `id` this agent serves (any of its devices), if shared.
  get (id: string): Promise<{ task: Task, owner: string | null } | null>
  // Every task this agent serves, as its groups have them.
  list (): AsyncIterable<{ task: Task, owner: string | null }>
  // Another agent's task, from the replica (null if not shared or not its).
  getOf (agent: string, id: string): Promise<{ task: Task, owner: string | null } | null>
  // Another agent's tasks, from the replica.
  listOf (agent: string): AsyncIterable<{ task: Task, owner: string | null }>
  // Publishes this agent's task in its group (soon: writes are batched).
  put (task: Task, owner: string | null): void
}

// Another device of the same identity, connected (see Identity.connected).
export interface OwnPeer {
  id: Uint8Array
  readonly closed: boolean
  request (method: string, params?: unknown): Promise<unknown>
}

// Pluggable identity. An Identity decides how agents find each other and
// how a connected peer proves who it is.

export interface AgentRecord {
  // Agent id: the agent's Noise (Hyperswarm) public key.
  id: Uint8Array
  name?: string
  // Set on the agent's own record (passed to discover and refresh).
  card?: AgentCard
}

export interface HandshakeContext {
  // NoiseSecretStream handshake hash; unique per connection, so proofs
  // can't be replayed onto another connection.
  handshakeHash: Uint8Array
  localPublicKey: Uint8Array
  remotePublicKey: Uint8Array
}

// Minimal surface of Hyperswarm the identity layer needs.
export interface SwarmLike {
  join (topic: Uint8Array, opts?: { server?: boolean, client?: boolean }): unknown
  leave (topic: Uint8Array): Promise<void>
  flush (): Promise<void>
  // Present on Hyperswarm: accept direct connections to the agent's key,
  // and the key pair (the agent id), which can sign.
  listen? (): Promise<void>
  keyPair?: { publicKey: Uint8Array, secretKey: Uint8Array }
}

export interface Identity {
  // Join whatever swarm topics make this agent discoverable.
  discover (swarm: SwarmLike, self: AgentRecord): Promise<void>
  // Produce this side's proof, sent in the a2a/v1 channel handshake.
  proof (ctx: HandshakeContext): Uint8Array
  // Verify the remote side's proof. Return false to drop the connection.
  authenticate (ctx: HandshakeContext, remoteProof: Uint8Array): Promise<boolean>
  // Look up an agent by id. May return null when unknown.
  resolve (id: Uint8Array): Promise<AgentRecord | null>
  // Optional: told about each peer once it has authenticated, so resolve()
  // can answer for peers met directly.
  remember? (record: AgentRecord): void
  // Optional: extra DHT bootstrap nodes. Pai adds them to Holepunch's
  // default nodes, unless PaiOptions.bootstrap replaces the whole list.
  bootstrap? (): BootstrapNode[] | Promise<BootstrapNode[]>
  // Optional: told when the agent's card changes, after discover().
  refresh? (self: AgentRecord): Promise<void>
  // Optional: called once a peer's proof checks out, with its connection,
  // before admits() is asked (groups replicate their state over it).
  attach? (conn: unknown, remoteId: Uint8Array): void
  // Optional: whether a peer whose proof checked out may make calls. Absent
  // means yes. 'pending' holds the peer (its calls wait, and it's told
  // pai/waiting); false refuses it. A peer that was admitted and no longer
  // is gets dropped.
  admits? (id: Uint8Array): boolean | 'pending'
  // Optional: calls `listener` whenever admits() may have changed for any
  // peer. Returns a function that stops it.
  onAdmissionChange? (listener: () => void): () => void
  // Optional: the principal (an identity, hex) an admitted device acts for,
  // when that isn't the device itself. Tasks belong to it, and calls can
  // address it (see Pai.route).
  principalOf? (device: Uint8Array): string | null
  // Optional: whether `id` names a principal (not a device), so calls to
  // it go to one of its devices rather than to `id` itself.
  isPrincipal? (id: Uint8Array): boolean
  // Optional: whether `caller` (a principal, or a device that has none,
  // hex) may call this agent; absent means yes. Asked on every incoming
  // request and every message delivered by mail.
  mayCall? (caller: string): boolean
  // Optional: tasks shared in groups. Pai stores its tasks through it, and
  // members' reads and controls follow its rules. Available after
  // discover().
  tasks? (): SharedTasks | null
  // Optional: JSON-RPC methods the identity answers itself (between an
  // identity's devices), instead of the agent. `device`: the caller, hex.
  serves? (method: string): boolean
  serve? (method: string, params: unknown, device: string): Promise<unknown>
  // Optional: told about each connection once both sides have accepted it.
  connected? (peer: OwnPeer): void
  // Optional: release connections; called by Pai.close().
  close? (): Promise<void>
}
