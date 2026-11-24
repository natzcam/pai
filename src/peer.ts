import { validateCard } from './a2a/card.js'
import type {
  AgentCard,
  CancelTaskRequest,
  GetTaskRequest,
  ListTasksRequest,
  ListTasksResponse,
  Message,
  SendMessageConfiguration,
  SendMessageRequest,
  SendMessageResponse,
  StreamResponse,
  SubscribeToTaskRequest,
  Task
} from './a2a/types.js'
import { A2A_METHODS } from './a2a/types.js'
import { PaiCardError } from './errors.js'
import type { AgentRecord } from './identity/types.js'
import type { RpcConnection } from './protocol/rpc.js'

// Where a peer's card comes from: the latest one it pushed over the channel.
export interface CardSource {
  read (): Promise<AgentCard | null>
  watch (signal?: AbortSignal): AsyncGenerator<AgentCard | null>
}

export interface CardOptions {
  // Default true: a card that fails A2A validation throws PaiCardError.
  // With false, whatever is stored is returned as is.
  strict?: boolean
}

export interface WatchCardOptions extends CardOptions {
  signal?: AbortSignal
  // Strict mode skips invalid versions instead of ending the watch; this is
  // called with each one.
  onInvalid?: (err: PaiCardError) => void
}

// A connected, authenticated remote agent.
export class Peer {
  constructor (readonly record: AgentRecord, readonly rpc: RpcConnection, private readonly cards: CardSource) {}

  get id (): Uint8Array {
    return this.record.id
  }

  get closed (): boolean {
    return this.rpc.closed
  }

  // The card the agent sent when the connection opened, or its latest
  // update. Waits for it if it hasn't arrived yet.
  async card (opts: CardOptions = {}): Promise<AgentCard | null> {
    const card = await this.cards.read()
    if (card === null || opts.strict === false) return card
    const errors = validateCard(card)
    if (errors.length) throw new PaiCardError(errors, card)
    return card
  }

  // Yields the remote card, then each new version as the agent edits it.
  // Runs until `signal` aborts or the iteration is stopped.
  async * watchCard (opts: WatchCardOptions = {}): AsyncGenerator<AgentCard> {
    for await (const card of this.cards.watch(opts.signal)) {
      if (card === null) continue
      const errors = opts.strict === false ? [] : validateCard(card)
      if (errors.length) opts.onInvalid?.(new PaiCardError(errors, card))
      else yield card
    }
  }

  // SendMessage: resolves with { task } once the task ends or needs input,
  // or with { message } for a stateless reply. With returnImmediately it
  // resolves as soon as the task exists; follow it with subscribe() or
  // getTask().
  async send (message: Message, configuration?: SendMessageConfiguration): Promise<SendMessageResponse> {
    return await this.rpc.request(A2A_METHODS.sendMessage, sendParams(message, configuration))
  }

  // SendStreamingMessage: yields { task } (or a single { message }), then
  // { statusUpdate } and { artifactUpdate } items, ending when the task ends
  // or needs input.
  stream (message: Message, configuration?: SendMessageConfiguration): AsyncGenerator<StreamResponse> {
    return this.rpc.stream(A2A_METHODS.sendStreamingMessage, sendParams(message, configuration))
  }

  // GetTask
  async getTask (id: string, historyLength?: number): Promise<Task> {
    const params: GetTaskRequest = { id }
    if (historyLength !== undefined) params.historyLength = historyLength
    return await this.rpc.request(A2A_METHODS.getTask, params)
  }

  // ListTasks: this agent's tasks on the remote, most recently updated first.
  async listTasks (params: ListTasksRequest = {}): Promise<ListTasksResponse> {
    return await this.rpc.request(A2A_METHODS.listTasks, params)
  }

  // CancelTask
  async cancelTask (id: string): Promise<Task> {
    const params: CancelTaskRequest = { id }
    return await this.rpc.request(A2A_METHODS.cancelTask, params)
  }

  // SubscribeToTask: yields the current { task }, then live updates until
  // the task ends or needs input. Fails for a task that has already ended.
  subscribe (id: string): AsyncGenerator<StreamResponse> {
    const params: SubscribeToTaskRequest = { id }
    return this.rpc.stream(A2A_METHODS.subscribeToTask, params)
  }
}

function sendParams (message: Message, configuration?: SendMessageConfiguration): SendMessageRequest {
  const params: SendMessageRequest = { message }
  if (configuration) params.configuration = configuration
  return params
}
