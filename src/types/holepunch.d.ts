// Minimal ambient types for Holepunch modules, which ship untyped.
// Only the surface pai uses is declared.

declare module 'protomux' {
  interface Message { send (m: unknown): boolean }
  interface Channel {
    open (handshake?: unknown): void
    close (): void
    addMessage (opts: { encoding: unknown, onmessage: (m: any) => void }): Message
  }
  export default class Protomux {
    static from (stream: unknown): Protomux
    createChannel (opts: {
      protocol: string
      id?: Uint8Array
      unique?: boolean
      handshake?: unknown
      onopen?: (handshake: any) => void | Promise<void>
      onclose?: () => void
    }): Channel | null
  }
}

declare module 'compact-encoding' {
  interface Codec<T> {
    preencode (state: unknown, v: T): void
    encode (state: unknown, v: T): void
    decode (state: unknown): T
  }
  const c: {
    buffer: Codec<Uint8Array | null>
    fixed32: Codec<Uint8Array>
    fixed64: Codec<Uint8Array>
    uint: Codec<number>
    json: Codec<unknown>
    encode<T> (codec: Codec<T>, v: T): Uint8Array
    decode<T> (codec: Codec<T>, buf: Uint8Array): T
  }
  export default c
}

declare module 'hyperswarm' {
  export default class Hyperswarm {
    constructor (opts?: { keyPair?: { publicKey: Uint8Array, secretKey: Uint8Array }, bootstrap?: unknown })
    readonly keyPair: { publicKey: Uint8Array, secretKey: Uint8Array }
    join (topic: Uint8Array, opts?: { server?: boolean, client?: boolean }): unknown
    joinPeer (publicKey: Uint8Array): void
    leavePeer (publicKey: Uint8Array): void
    leave (topic: Uint8Array): Promise<void>
    flush (): Promise<void>
    suspend (): Promise<void>
    resume (): Promise<void>
    on (event: 'connection', listener: (conn: any, info: any) => void): this
    destroy (): Promise<void>
  }
}

declare module 'hyperdht/testnet' {
  interface Testnet {
    bootstrap: Array<{ host: string, port: number }>
    destroy (): Promise<void>
  }
  export default function createTestnet (size?: number, opts?: { teardown?: unknown }): Promise<Testnet>
}

declare module 'hyperdht' {
  import { EventEmitter } from 'node:events'
  export type BootstrapNode = string | { host: string, port: number }
  interface KeyPair { publicKey: Uint8Array, secretKey: Uint8Array }
  interface Server extends EventEmitter {
    readonly publicKey: Uint8Array
    listen (keyPair: KeyPair): Promise<void>
    close (): Promise<void>
  }
  export default class HyperDHT extends EventEmitter {
    static BOOTSTRAP: string[]
    static keyPair (seed?: Uint8Array): KeyPair
    static bootstrapper (port: number, host: string, opts?: { bootstrap?: BootstrapNode[] }): HyperDHT
    constructor (opts?: { bootstrap?: BootstrapNode[], port?: number, host?: string, ephemeral?: boolean, firewalled?: boolean })
    ready (): Promise<void>
    fullyBootstrapped (): Promise<void>
    address (): { host: string, port: number }
    createServer (onconnection?: (socket: any) => void): Server
    connect (publicKey: Uint8Array, opts?: { keyPair?: KeyPair }): any
    destroy (): Promise<void>
  }
}

declare module 'sodium-universal' {
  const sodium: {
    crypto_sign_ed25519_pk_to_curve25519 (out: Uint8Array, pk: Uint8Array): void
    crypto_sign_ed25519_sk_to_curve25519 (out: Uint8Array, sk: Uint8Array): void
    crypto_scalarmult (out: Uint8Array, sk: Uint8Array, pk: Uint8Array): void
    crypto_scalarmult_BYTES: number
    crypto_box_PUBLICKEYBYTES: number
    crypto_box_SECRETKEYBYTES: number
    crypto_box_SEALBYTES: number
    crypto_box_seal (c: Uint8Array, m: Uint8Array, pk: Uint8Array): void
    crypto_box_seal_open (m: Uint8Array, c: Uint8Array, pk: Uint8Array, sk: Uint8Array): boolean
    crypto_hash_sha256 (out: Uint8Array, data: Uint8Array): void
    randombytes_buf (out: Uint8Array): void
    sodium_memcmp (a: Uint8Array, b: Uint8Array): boolean
    crypto_sign_seed_keypair (pk: Uint8Array, sk: Uint8Array, seed: Uint8Array): void
    crypto_sign_detached (sig: Uint8Array, m: Uint8Array, sk: Uint8Array): void
    crypto_sign_verify_detached (sig: Uint8Array, m: Uint8Array, pk: Uint8Array): boolean
  }
  export default sodium
}

declare module 'corestore' {
  export default class Corestore {
    constructor (storage: string)
    ready (): Promise<void>
    get (opts: string | { name: string }): any
    namespace (name: string | Uint8Array): Corestore
    replicate (stream: unknown): unknown
    close (): Promise<void>
  }
}

declare module 'hyperbee' {
  export default class Hyperbee {
    constructor (core: unknown, opts?: { keyEncoding?: string, valueEncoding?: string, extension?: boolean })
    readonly core: { signedLength: number, length: number, fork: number }
    ready (): Promise<void>
    get (key: string): Promise<{ key: string, value: any } | null>
    put (key: string, value: unknown): Promise<void>
    del (key: string): Promise<void>
    createReadStream (range: { gt: string, lt: string }): AsyncIterable<{ key: string, value: any }>
    checkout (length: number): Hyperbee
    close (): Promise<void>
  }
}

declare module 'autobase' {
  import { EventEmitter } from 'node:events'
  interface AutobaseOptions<V> {
    open (store: any, host?: any): V
    apply (nodes: Array<{ value: unknown, from: { key: Uint8Array } }>, view: V, host: any): Promise<void>
    close? (view: V): Promise<void>
    valueEncoding?: unknown
    ackInterval?: number
    encryptionKey?: Uint8Array
    encrypt?: boolean
    wakeup?: unknown
  }
  export default class Autobase<V = any> extends EventEmitter {
    constructor (store: unknown, bootstrap: Uint8Array | null, opts: AutobaseOptions<V>)
    static getLocalCore (store: unknown, handlers?: unknown, encryptionKey?: Uint8Array): any
    static getLocalKey (store: unknown): Promise<Uint8Array>
    readonly key: Uint8Array
    readonly discoveryKey: Uint8Array
    readonly local: { key: Uint8Array }
    readonly view: V
    readonly writable: boolean
    readonly isIndexer: boolean
    readonly signedLength: number
    readonly length: number
    // The system core: a session over the shared core, whose state is
    // what the indexers signed.
    readonly core: { key: Uint8Array, core?: { state?: { length?: number } } }
    isFastForwarding (): boolean
    forceFastForward (): Promise<void>
    ready (): Promise<void>
    append (value: unknown): Promise<void>
    update (): Promise<void>
    ack (bg?: boolean): Promise<void>
    replicate (stream: unknown): unknown
    close (): Promise<void>
  }
}

declare module 'blind-pairing' {
  interface Invite {
    id: Uint8Array
    invite: Uint8Array
    publicKey: Uint8Array
    discoveryKey: Uint8Array
    expires: number
    additional: unknown
  }
  interface Candidate {
    readonly inviteId: Uint8Array
    readonly userData: Uint8Array
    open (publicKey: Uint8Array): void
    confirm (result: { key: Uint8Array, encryptionKey?: Uint8Array, additional?: unknown }): void
    deny (opts?: { status?: number }): void
  }
  interface Member { flushed (): Promise<void>, close (): Promise<void> }
  interface CandidateHandle { pairing: Promise<unknown>, paired: boolean, close (): Promise<void> }
  export default class BlindPairing {
    constructor (swarm: unknown, opts?: { poll?: number })
    static createInvite (key: Uint8Array, opts?: { expires?: number, data?: Uint8Array }): Invite
    static decodeInvite (invite: Uint8Array): { discoveryKey: Uint8Array, expires: number, seed: Uint8Array }
    static createRequest (invite: Uint8Array, userData: Uint8Array): { inviteId: Uint8Array }
    addMember (opts: { discoveryKey: Uint8Array, onadd: (candidate: Candidate) => Promise<void> | void }): Member
    addCandidate (opts: { invite: Uint8Array, userData: Uint8Array, onadd: (result: { key: Uint8Array, encryptionKey?: Uint8Array, data?: Uint8Array | null }) => Promise<void> | void }): CandidateHandle
    close (): Promise<void>
  }
}

declare module 'autobase/lib/fast-forward.js' {
  export default class FastForward {
    constructor (base: unknown, key: Uint8Array, opts?: { force?: boolean, length?: number, minimum?: number, timeout?: number })
  }
}

declare module 'suspendify' {
  export default class Suspendify {
    constructor (handlers: { suspend: () => Promise<void>, resume: () => Promise<void>, wakeup?: () => Promise<void> })
    suspend (linger?: number): unknown
    resume (): unknown
  }
}
