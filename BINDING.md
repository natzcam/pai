# The pai binding for A2A v1.0

**Binding URI:** `https://github.com/natzcam/pai/blob/main/BINDING.md`
**A2A version:** 1.0
**Status:** v1

This document specifies pai, a custom protocol binding for the
[A2A protocol](https://a2a-protocol.org/) v1.0 (see the A2A specification,
Section 12, Custom Binding Guidelines). It carries the payloads of A2A's
JSON-RPC binding (Section 9) over Holepunch peer-to-peer connections instead
of HTTP: agents dial each other by public key through HyperDHT, with no
public servers and no open ports.

Everything not stated here is as in A2A's JSON-RPC binding: method names,
`params` and `result` shapes, error codes and error details. This document
only specifies what differs: transport, connection setup, authentication,
service parameters, streaming and card discovery.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Identification

### 1.1 Agent Card declaration

An agent that speaks this binding lists it in its card's
`supportedInterfaces`:

```json
{
  "url": "pai://3f9c0e…(64 hex digits)",
  "protocolBinding": "https://github.com/natzcam/pai/blob/main/BINDING.md",
  "protocolVersion": "1.0"
}
```

- **`url`** is `pai://` followed by the agent id: its 32-byte Noise public
  key as 64 lowercase hex digits. The id is the agent's address; there is no
  host, port or path.
- **`protocolBinding`** is the binding URI above. A breaking change to this
  binding gets a new URI (A2A Section 5.8).
- **`protocolVersion`** is `1.0`.

The id is an address and a cryptographic identity at once: a connection to
it is only established with the holder of the matching secret key.

## 2. Transport

### 2.1 Connections

Agents connect over [Hyperswarm](https://github.com/holepunchto/hyperswarm):
HyperDHT discovery and hole punching, with each connection a
[Noise](https://noiseprotocol.org/) `XX` encrypted stream, as implemented by
`@hyperswarm/secret-stream`.

- **Dialing an agent:** connect to its public key directly through HyperDHT
  (`swarm.joinPeer(id)`). The id from the card's `url` is enough.
- **Finding agents:** how agents learn each other's ids is up to the
  identity scheme (Section 4). In pai's, agents join a discovery topic for
  each group they're in, and an identity's devices also join one of the
  identity's own.

Either agent can dial. If both dial at once, Hyperswarm keeps one connection
and closes the other; an implementation MUST NOT treat the close of such a
duplicate, before authentication, as a refusal.

### 2.2 The `a2a/v1` channel

Each connection carries one [Protomux](https://github.com/holepunchto/protomux)
channel with protocol name `a2a/v1`, opened as unique (one channel per
connection). The connection MAY carry other Protomux channels alongside it:
the group scheme (Section 4.2) replicates its Hypercores over the same
connection.

- **Handshake:** each side sends, in
  [compact-encoding](https://github.com/holepunchto/compact-encoding):

  | Field | Encoding | Content |
  | --- | --- | --- |
  | `version` | `uint` | the sender's pai protocol version: `1` |
  | `proof` | `buffer` (varint length, then bytes) | identity proof (Section 4) |

  The protocol version covers everything in this document. A side whose
  version differs from the other's MUST refuse it (Section 4.3), before
  checking its proof, with `"version"` in its `pai/refused` frame, so both
  sides can say which versions they run. (A group's rules carry their own
  version, in the group's log: Section 4.2.)

- **Message type 0** is the only message type. Its encoding is
  compact-encoding `json` (a length-prefixed UTF-8 JSON text), and each
  message is one of:
  - a JSON-RPC 2.0 request or response (Section 3)
  - a binding frame: `{ "type": "pai/ready" }`, `{ "type": "pai/refused" }`,
    `{ "type": "pai/waiting" }` (Section 4.3), `{ "type": "pai/end", "id": <request id> }` (Section 5),
    `{ "type": "pai/card", "card": <AgentCard> }` (Section 6) or
    `{ "type": "pai/mail" }` (Section 7)

Frames are not JSON-RPC envelopes: they have no `jsonrpc` member. A received
message that is neither a valid envelope nor a frame MUST be answered with a
JSON-RPC error `-32600` (Invalid Request) with `id: null`.

## 3. Requests and responses

The channel is symmetric: either side MAY send requests, and both MUST
answer them. Responses are matched to requests by JSON-RPC `id`, so many
calls MAY be in flight on one channel. Senders MUST NOT reuse an `id` while
a call with that `id` is outstanding; the reference implementation uses a
random UUID per request.

Envelopes are A2A JSON-RPC envelopes, unchanged: the same method names
(`SendMessage`, `GetTask`, …), the same `params` and `result` objects, the
same JSON field names (camelCase) and enum values (`TASK_STATE_WORKING`),
timestamps as ISO 8601 UTC strings, and binary content base64-encoded, as
A2A Section 5 defines for JSON serializations.

```json
{
  "jsonrpc": "2.0",
  "id": "8b1c4a6e-…",
  "method": "SendMessage",
  "params": {
    "message": { "role": "ROLE_USER", "messageId": "m1", "parts": [{ "text": "hello" }] }
  },
  "a2a-service-parameters": { "A2A-Version": "1.0" }
}
```

```json
{ "jsonrpc": "2.0", "id": "8b1c4a6e-…", "result": { "task": { "id": "t1", "contextId": "c1", "status": { "state": "TASK_STATE_COMPLETED" } } } }
```

### 3.1 Service parameters

The binding has no headers, so A2A service parameters (A2A Section 3.2.6)
travel in each request:

- **Transmission:** a top-level request member `a2a-service-parameters`,
  holding a JSON object of string keys to string values. It is a member of
  the envelope, next to `method` and `params`, not inside `params`.
- **Keys** are case-insensitive, as HTTP header names are. A key appears at
  most once, ignoring case.
- **Values** are UTF-8 strings. Several values for one parameter (for
  example `A2A-Extensions`) are comma-separated in one string, as in the
  JSON-RPC binding's headers.
- **Reserved names:** none beyond A2A's own. The binding defines no
  parameters of its own.
- **`A2A-Version`:** every request MUST carry `"A2A-Version": "1.0"`. A
  server MUST answer a request without it (which A2A reads as 0.3) or with
  any version other than 1.0 with `VersionNotSupportedError`. Patch versions
  are ignored: `1.0.2` is 1.0.

### 3.2 Methods

All A2A core operations (A2A Section 3.1) are available under their JSON-RPC
method names (A2A Section 5.3). Methods starting with `pai/` are this
binding's own (Section 7), not A2A's. An agent that doesn't support push
notifications answers the four `*TaskPushNotificationConfig*` methods with
`PushNotificationNotSupportedError`, and one without an extended card
answers `GetExtendedAgentCard` with `ExtendedAgentCardNotConfiguredError`,
as for any binding.

### 3.3 Errors

Errors use the JSON-RPC binding's representation (A2A Sections 5.4 and 9.5):
a JSON-RPC `error` object with the A2A code, and `error.data` an array of
`google.rpc` detail objects.

| A2A error | `error.code` | `ErrorInfo.reason` |
| --- | --- | --- |
| `TaskNotFoundError` | `-32001` | `TASK_NOT_FOUND` |
| `TaskNotCancelableError` | `-32002` | `TASK_NOT_CANCELABLE` |
| `PushNotificationNotSupportedError` | `-32003` | `PUSH_NOTIFICATION_NOT_SUPPORTED` |
| `UnsupportedOperationError` | `-32004` | `UNSUPPORTED_OPERATION` |
| `ContentTypeNotSupportedError` | `-32005` | `CONTENT_TYPE_NOT_SUPPORTED` |
| `InvalidAgentResponseError` | `-32006` | `INVALID_AGENT_RESPONSE` |
| `ExtendedAgentCardNotConfiguredError` | `-32007` | `EXTENDED_AGENT_CARD_NOT_CONFIGURED` |
| `ExtensionSupportRequiredError` | `-32008` | `EXTENSION_SUPPORT_REQUIRED` |
| `VersionNotSupportedError` | `-32009` | `VERSION_NOT_SUPPORTED` |

```json
{
  "jsonrpc": "2.0",
  "id": "8b1c4a6e-…",
  "error": {
    "code": -32001,
    "message": "Task not found",
    "data": [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      "reason": "TASK_NOT_FOUND",
      "domain": "a2a-protocol.org",
      "metadata": { "taskId": "t1" }
    }]
  }
}
```

Invalid parameters are `-32602` (Invalid Params) with a
`type.googleapis.com/google.rpc.BadRequest` detail naming the field. The
other JSON-RPC 2.0 codes (`-32700`, `-32600`, `-32601`, `-32603`) keep
their JSON-RPC meanings.

Transport failures are not JSON-RPC errors: when the connection closes, every
call outstanding on it fails at the caller, with no response.

### 3.4 Retries

A sender MAY send a message again, with the same `messageId`, when it can't
tell whether the first one arrived: after a connection dropped, say. So a
server MUST treat a `SendMessage` or `SendStreamingMessage` whose `messageId`
this caller has already sent, and which started or continued a task, as the
same request:

- `SendMessage` returns that task as it is now, without running anything.
- `SendStreamingMessage` follows the task as `SubscribeToTask` does while it
  is still running, and otherwise returns it as a single `{ task }` item.

`messageId`s are unique per sender, so the same id from another agent is a
different message. A message answered with a stateless `{ message }` keeps
no task, and a retry of it runs again.

## 4. Authentication

Noise already proves that the remote side holds the secret key for its
public key, so the remote's agent id is authenticated by the connection
itself. What remains is authorization: whether that id may connect. The
binding leaves that decision to an **identity scheme**, which supplies the
handshake `proof` and checks the remote's.

### 4.1 Identities

pai's scheme (the group scheme, Section 4.2) names whom a device acts for:
an **identity**, which may run on several devices and be in several
groups.

- **The identity** is an [Autobase](https://github.com/holepunchto/autobase)
  listing the devices (Noise keys) that act as it, and holding its card;
  its key (32 bytes) is the identity's id. Any one device adds or removes
  devices and sets the card. The identity's devices are its indexers: the
  creating device from the start, a device added later once it has
  written (`device.hello`), since Autobase stalls on indexers that never
  write. Device checks use its latest view. Rules: `src/devices/state.ts`.
- **The secret:** 32 random bytes every device of the identity holds.
  HKDF-SHA256 over it, salt `pai/identity/v1`, derives `auth` (for the
  identity's MAC in the proof, Section 4.2) and `topic`, which the
  identity's devices join as both client and server, so they find each
  other in no group at all.
- **Adding a device:** a device makes a one-use invite for the identity's
  Autobase, and the new device redeems it with blind pairing. Its user
  data is JSON: `device` (its Noise key), `identityWriter` (its writer in
  the identity's Autobase), an optional `name`, and `sig`, the device's
  Ed25519 signature over the ASCII bytes `pai/identity/v1/device\n`, the
  invite id and the writer. The inviting device checks the signature,
  adds the device, and returns the identity's key (blind pairing's `key`)
  and the secret (`encryptionKey`). A device listed before, or removed
  before, is denied.
- **Groups across devices:** an identity's devices tell each other their
  groups over the channel, with JSON-RPC methods only another device of
  the same identity may call (anyone else gets `InvalidRequest` with
  reason `NOT_OWN_DEVICE`):
  - `pai/Groups` → `{ groups: [{ name, key, seed }] }` (key and seed
    base64url): the groups the answering device is in, by its name for
    each.
  - `pai/GroupsChanged` → `{}`: the caller's groups changed; the receiver
    calls `pai/Groups` on it.
  - `pai/AddWriters { writers: { <group id>: <writer, hex> } }` →
    `{ added: [<group id>] }`: the receiver appends `writer.add` for the
    caller's writer in each group it's in, and seals the group's current
    seed to the caller (Section 4.2).

  A device calls `pai/Groups` on each of its own devices once both have
  accepted the connection, and when told they changed; it joins each
  group it lacks, and asks for its writers to be let into those it can't
  write to yet, until it can.

### 4.2 The group scheme

The group's membership lives in an
[Autobase](https://github.com/holepunchto/autobase) that every member
replicates. Admins add and remove members by appending to it, and every
agent decides whom to accept from its own replica.

- **Members are identities** (Section 4.1); the roster lists them by their
  Autobase key. A connecting side is a device acting for an identity, which
  may be in up to 32 groups.
- **Group:** the Autobase's key (32 bytes) and a 32-byte random **seed**,
  both given to an agent when it joins. HKDF-SHA256 over the seed, salt
  `pai/group/v1`, derives four independent 32-byte keys, with info strings
  `topic` (the discovery topic), `auth` (the proof key), `base` (the
  Autobase's encryption key) and `id` (its first 8 bytes, hex, are the
  group's id, which a task's `pai/group` metadata and a message's carry).
  The topic comes from the seed, not the Autobase key, so the key alone
  neither finds members nor reads the roster.
- **Seed epochs:** the seed in the group file is epoch 0's. Admins can
  replace it (`seed.rotate`, k of n): the new seed goes into the Autobase
  sealed to each member device (libsodium `crypto_box_seal` to the
  device's Noise key, converted to X25519), with a commitment to it
  (`HMAC-SHA256(seed, "pai/group/seed-check")`); members (for their own
  devices) and admins seal it to devices added later (`seed.share`, only
  with the epoch's commitment, only to devices the roster records for a
  current member). A device moves to the latest epoch once its box opens
  to a seed matching the commitment. `topic` and `auth` come from the device's
  current epoch's seed; `base` always from epoch 0's (Autobase can't change
  its encryption key).
- **Discovery:** agents join their epoch's topic as both client and server.
  After a rotation, admins also announce on epoch 0's topic and everyone
  looks it up, so a device that missed a rotation, or a new one (blind
  pairing hands it epoch 0's seed only), finds the group and catches up.
- **Proof:** `identity`, the 32-byte key of the identity the device acts
  for; `HMAC-SHA256(auth_identity, handshakeHash ‖ senderPublicKey ‖
  identity)` with the identity's `auth` (Section 4.1); then one 68-byte
  entry per group the sender is in, in any order: its epoch `e` in that
  group (uint32, big-endian), `HMAC-SHA256(auth_e, handshakeHash ‖
  senderPublicKey ‖ identity)`, and the same with epoch 0's `auth`. It
  names whom the device acts for and shows the seeds it holds. A length
  that isn't 64 plus a whole number of entries, or more than 32 entries,
  is refused.
- **Matching:** the receiver tries each entry against each of its groups:
  an entry is a group's when its epoch-0 MAC verifies with that group's
  key. A sender claiming the receiver's own identity must have a valid
  identity MAC (only the identity's devices hold its secret); it is then
  checked against the receiver's identity base (step 3 alone). Any other
  sender needs at least one entry for a group both are in, and is
  checked per group below; it's accepted if any group accepts it,
  pending if none does but one is pending, and refused otherwise.
- **Check, in three steps (per group):**
  1. The proof stands. Epoch 0's MAC must verify, and so must the epoch
     `e` MAC if the receiver has that epoch's seed. Then: if `e` is the
     latest epoch the receiver's roster knows (and it has its seed), that
     is enough; otherwise (a peer that missed a rotation, or one whose
     epoch the receiver hasn't caught up with) the receiver's roster must
     vouch for it: the identity is admitted (latest view) and the roster
     records the device for it, and its identity base doesn't say it was
     removed. A removed member keeps epoch 0's seed, so it fails here once
     the seed has been rotated. A receiver whose roster is still empty (a
     device that just joined) can't vouch for anyone: it lets the peer
     sync while its roster loads, then checks it like this. The sides then replicate the Hypercores of the
     groups both are in, and the identities' bases, over the connection. Autobase verifies what
     it receives back to each base's key, so a peer can withhold updates but
     can't forge them.
  2. The claimed identity is **admitted** by the receiver's replica of the
     roster: an admin, or a member whose membership hasn't lapsed, in both
     the latest view and the part signed by a majority of admins (the
     indexers). An identity the replica doesn't know, or whose addition
     isn't signed yet, is **pending**; one removed, or lapsed, is refused.
  3. The identity's base, as the receiver has it, **lists the device**
     (latest view: any one device of an identity can change its list).
     Unknown → pending; removed → refused.
- **Identity bases** (Section 4.1) belong to no group: a receiver keeps one
  replica of each member's, for all the groups it shares with it.
- **Policy:** admins keep rules of the form `{ name, from, to, allow }`,
  where `from` and `to` are `*`, `role:<role>` or an identity (members hold
  roles; admins also match `role:admin`). A receiver checks every request,
  and every message delivered by mail, against its replica: of the rules
  matching both caller and receiver, the one naming the caller most
  specifically (identity, role, `*`), then the receiver, wins; a deny wins
  a tie; no rule allows. A device's own identity is always allowed. A
  refused request gets `InvalidRequest` with reason `NOT_ALLOWED_BY_POLICY`;
  refused mail is dropped. A device stands for the identity it claimed on
  connecting, or (mail from a device not connected) the identity a roster
  records it for. A request carries no group, so it's allowed if the
  policy of any group caller and receiver are both in allows it; a job is
  judged by its own group's.
- **Job board:** members post jobs to the group's Autobase and claim,
  release, finish and cancel them by the rules in `src/group/jobs.ts`.
  Leases run out, and memberships lapse, by the group's clock: the latest
  time any admin's op carries, never the time a member's op claims. An op
  counts as made at its time or the clock, whichever is later; a claim's
  lease runs from then, but from no later than a lease past the clock. An
  admin's device appends `{ "type": "clock.tick" }` when a lease or a
  membership runs out by its own clock and no admin op has moved the
  group's clock past it.
  A job's run that stops in `input-required` is asked on the board
  (`job.ask`, by the claiming device) and answered there (`job.answer`, by
  the poster or an admin); the worker sends the answer to the same task as
  the poster's next message, with message id
  `job-<id>-<claim time>-answer-<n>`. A claim with `"hand": true` is a
  person's (`pai job take`): workers leave it alone. A job may carry
  `timeout`, `deadline`, `retries` and `backoff`; past a limit by the
  group's clock, the attempt or job ends (or opens again while retries
  last), and claims wait out `notBefore`.
- **Rules version:** the group's rules version is in its log (`init`
  records the version a group starts on, `1`; a `rules.set` quorum op
  moves it on). A replica whose build doesn't apply the
  version it meets stops applying at that op until upgraded, rather than
  read what follows differently.
  Posting a job is calling its taker, so the policy applies when the op is
  applied, on every replica: a `job.post` (or a `flow.start` with any
  such step) whose poster the rules don't allow to call its `to` is
  skipped. For an identity, the rules on calling it; for `role:<r>`, the
  rules whose `to` is that role or `*`; for anyone, those whose `to` is
  `*`; for the poster's own identity, always allowed. A workflow's steps
  are checked again as the rules post each one: one the policy then
  refuses fails the workflow. A
  worker runs a job as an ordinary message from the poster (message id
  `job-<id>-<claim time>`), only if the policy lets the poster call it, so it's an A2A task like any other; the board only records
  who does what, and how it ended.
- **Workflows:** a member starts a workflow (`flow.start`), and the
  group's rules post its steps as jobs as they become ready, by
  `src/group/flows.ts`. A step's `if` tests a step it waits for (its
  result equals or contains some text, trimmed and in any case, or it
  failed); a step whose test doesn't hold, or that waits only for steps
  that didn't run, is skipped.
- **Shared tasks:** each task is shared in one group, recorded in its
  metadata as `pai/group` (the group's id) when it's made: a job's in the
  job's group; a message's in the group its own `pai/group` metadata
  names, if both sides are in it, else the first group both are in (by
  id). A member serving a task writes its latest state to that group's
  Autobase (`task.put`, only for tasks it serves). Members of that group
  may read it (`GetTask`; `ListTasks` lists the tasks the caller may
  read); anyone else gets `TaskNotFound`. Only the task's creator or an
  admin of its group may continue or cancel it, and anyone else gets an
  error with reason `NOT_TASK_OWNER`. Any device of the serving identity
  may continue a task.
- **Roster rules:** only admins add, renew and remove members. A member
  adds its own devices' writers to the group (`writer.add`, naming the
  device) and retires the writer of a device that left its identity
  (`writer.remove`); a retired writer speaks for nobody. An admin's writer
  becomes a group indexer only once it has written something (`hello`
  serves), since Autobase stalls on indexers that never write. Changes to
  the set of admins, and to how many admins such a change needs, take
  `k` of the `n` current admins (by default a majority). The ops and the
  rules that apply them are in the reference implementation,
  `src/group/state.ts`.
- **Joining:** an admin makes a one-use invite, and the new agent redeems it
  with [blind pairing](https://github.com/holepunchto/blind-pairing). The
  code people pass around is the invite, base64url, then optionally `.`
  and the group's own name (`title`, from its `init`), base64url, as the
  joiner's default name for the group. Its
  user data is JSON: `identity` (the joining device's identity),
  `device` (its Noise key), `writer` (its writer in the group's
  Autobase), an optional `name`, and `sig`, the device's Ed25519 signature
  over the ASCII bytes `pai/group/v1/join\n`, the invite id, the writer and
  the identity. An online admin checks the invite against the roster and
  the signature against `device`, adds the identity (which uses up the
  invite), and returns the Autobase key and the seed (in blind pairing's
  `encryptionKey` field). A redemption for an identity already in the
  roster uses up the invite and admits nobody: more devices join through
  the identity's own devices.

A receiver re-checks its connections whenever its replica changes, and
closes (after `pai/refused`) any to an agent no longer admitted. A removed
member keeps the seed it had, so until the seed is rotated it can still
replicate the roster and find members on the DHT, but not make calls. After
a rotation it can find admins on epoch 0's topic, but no member syncs with
it.

Other schemes MAY define their own proof and discovery; both agents on a
connection must use the same scheme.

### 4.3 Accepting a connection

1. Both sides open the `a2a/v1` channel with their handshake.
2. Each side checks the other's `proof`.
3. A side that accepts the other sends `{ "type": "pai/ready" }`, then its
   card (Section 6).
   A side that refuses sends `{ "type": "pai/refused" }` and then closes the
   connection. When it refused another protocol version, it adds
   `"version"`: its own (Section 2.2).
   A side whose scheme hasn't decided yet (a group member that is pending,
   Section 4.2) MAY send `{ "type": "pai/waiting" }` and keep the connection
   open; it sends `pai/ready` or `pai/refused` once it decides. Until then
   it drops the remote's JSON-RPC messages and keeps at most its latest
   card. A side that
   accepted the other MAY later send `pai/refused` and close, when its
   scheme no longer accepts it.
4. A connection is usable once a side has both accepted the other and
   received the other's `pai/ready`. Schemes can disagree (one side may have
   revoked the other), so acceptance must be mutual.

A side MUST NOT process JSON-RPC messages or `pai/card` frames before its
own check of the remote has passed, and MUST drop them if it fails. A side SHOULD NOT send requests
before the connection is usable. A side receiving `pai/refused` SHOULD
report that it was refused, rather than wait for another connection.

### 4.4 In the Agent Card

Authentication happens at the connection, before any request, so the pai
interface needs no `securitySchemes` or `securityRequirements` and no
credentials in requests. There are no per-request authentication
challenges: an agent that isn't accepted gets `pai/refused` and a closed
connection. Task-level `TASK_STATE_AUTH_REQUIRED` works as in any binding.

The caller's agent id is the authenticated principal for A2A's
authorization rules (A2A Section 13.1). For example, the reference
implementation scopes `ListTasks` to tasks the caller created, and answers
`CancelTask` or a follow-up message from any other agent with
`TaskNotFoundError`.

## 5. Streaming

`SendStreamingMessage` and `SubscribeToTask` stream. On HTTP, the JSON-RPC
binding sends each stream item as an SSE event and ends the stream by
closing the response. A channel carries many calls and can't be closed per
call, so on this binding:

- **Items:** each stream item is a JSON-RPC success response with the
  request's `id`, whose `result` is a `StreamResponse` (exactly one of
  `task`, `message`, `statusUpdate` or `artifactUpdate`).
- **End:** after the last item the server sends
  `{ "type": "pai/end", "id": <request id> }`. The client MUST treat the
  stream as ended on this frame, and not infer the end from the content of
  the items.
- **Errors:** a JSON-RPC error response with the request's `id` ends the
  stream, with no `pai/end` after it. It MAY come after items.
- **Ordering:** items arrive in the order the server sent them, since the
  channel is one ordered stream.
- **Interruption:** if the connection closes, every open stream on it fails
  at the client. The task itself is unaffected; after reconnecting, the
  client can follow it again with `SubscribeToTask` or read it with
  `GetTask`.
- **Abandoning a stream:** there is no frame to stop a stream. A client that
  stops reading ignores further items for that `id`; to stop the work
  itself, it calls `CancelTask`.

```text
→ { "jsonrpc": "2.0", "id": 7, "method": "SendStreamingMessage", "params": { … }, "a2a-service-parameters": { "A2A-Version": "1.0" } }
← { "jsonrpc": "2.0", "id": 7, "result": { "task": { …, "status": { "state": "TASK_STATE_WORKING" } } } }
← { "jsonrpc": "2.0", "id": 7, "result": { "artifactUpdate": { …, "append": true } } }
← { "jsonrpc": "2.0", "id": 7, "result": { "statusUpdate": { …, "status": { "state": "TASK_STATE_COMPLETED" } } } }
← { "type": "pai/end", "id": 7 }
```

Streams follow A2A's stream semantics otherwise: a stream ends after a
`message`, or once its task reaches a terminal state or one that waits for
the client (`TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`).

## 6. Agent Card discovery

On HTTP, a client fetches `/.well-known/agent-card.json`. On this binding,
each agent pushes its card over the channel:

- **When:** right after sending `pai/ready` (Section 4.3), a side sends
  `{ "type": "pai/card", "card": <AgentCard> }`. It sends the frame again,
  with the whole new card, whenever its card changes while the connection is
  open.
- **Reading:** a peer's card is the last one it pushed. A reader that needs
  it before the first frame arrives waits for it. Readers MAY keep the last
  card per agent id across reconnects, so a watch can continue.
- **Ordering:** frames arrive in order on the channel, so the latest frame is
  the current card.
- **Validation:** readers SHOULD validate a received card against the A2A
  AgentCard requirements before trusting it, and ignore a frame whose `card`
  isn't a JSON object.

The card's own pai interface (Section 1.1) MUST carry the agent's own id.
Nothing else is shared: an agent's tasks and other state stay in its own
storage and reach peers only through the A2A methods.

## 7. Mailboxes

Both agents of a call must be online at once. A mailbox lets a message wait:
an agent that is always online holds sealed envelopes for an offline
recipient until it collects them. The mailbox is an ordinary authenticated
agent (Section 4), but it can't read what it holds.

### 7.1 Envelopes

An envelope carries one letter, a JSON object that is one of:

- `{ "kind": "message", "message": <Message> }`: for the recipient to run,
  as if the sender had called `SendMessage` with `returnImmediately`.
- `{ "kind": "task", "task": <Task> }`: the recipient's task, sent back to the
  message's sender once it reaches a terminal state or one that waits for
  the client.

Envelopes are encoded in compact-encoding:

| Field | Encoding | Content |
| --- | --- | --- |
| `version` | `uint` | `1` |
| `from` | `fixed32` | the sender's agent id |
| `to` | `fixed32` | the recipient's agent id |
| `nonce` | `buffer` | 12 random bytes |
| `sealed` | `buffer` | AES-256-GCM ciphertext of the letter's UTF-8 JSON, then the 16-byte tag |

- **Key:** both agents convert their Ed25519 Noise keys to X25519 and run
  X25519. HKDF-SHA256 over the shared secret, salt `pai/mailbox/v1`, info the
  two agent ids sorted bytewise and concatenated, gives the 32-byte key. Both
  directions use the same key. An all-zero shared secret MUST be refused.
- **Associated data:** the ASCII bytes `pai/mailbox/v1/envelope\n`, then
  `from`, then `to`. So a changed sender or recipient fails to open.
- **Opening:** a recipient opens an envelope only if `to` is its own id, and
  drops it if decryption fails.

### 7.2 Methods

A mailbox answers three JSON-RPC requests. They need no `A2A-Version`
service parameter. An agent that isn't a mailbox answers them with
`-32601` (Method not found).

- **`pai/Deposit`** `{ "to": <hex agent id>, "envelope": <base64url> }` →
  `{ "id": <string> }`. The mailbox MUST refuse, with `-32602`, an envelope
  that doesn't decode, whose `from` isn't the caller's own id, or whose `to`
  isn't `to`, so an agent can only deposit as itself. It MAY refuse large
  envelopes or full mailboxes (the reference implementation takes up to
  256 KiB per envelope and 1000 waiting per recipient, and answers with
  `-32004`).
- **`pai/Collect`** `{ "limit"?: 1–50 }` → `{ "envelopes": [{ "id", "from",
  "at", "envelope" }] }`: what is waiting for the caller, oldest first. `from`
  is the depositor's id and `at` the time it was deposited (ms since the Unix
  epoch). A mailbox MUST only hand envelopes to their recipient.
- **`pai/Ack`** `{ "ids": [<string>] }` → `{}`: the caller has handled those
  envelopes, which the mailbox deletes.

A recipient MUST drop an envelope whose `from` differs from the `from` the
mailbox reports, and SHOULD acknowledge envelopes only after handling them.
Handling one twice is harmless, since the message's `messageId` makes a
second run a retry (Section 3.4).

### 7.3 Notification

When a mailbox takes an envelope for an agent that is connected to it, it
sends that agent `{ "type": "pai/mail" }`, and the agent collects. Without
it, agents collect when they connect to the mailbox and then from time to
time.

### 7.4 What a mailbox learns

A mailbox can't read letters, change them or forge them. It does see who
sends to whom, when and how much, and it can withhold or drop envelopes.
Senders SHOULD keep a message until it's delivered or deposited, and retry.

## 8. Differences from the JSON-RPC binding

| | JSON-RPC binding (A2A Section 9) | pai |
| --- | --- | --- |
| Transport | HTTP(S) POST | `a2a/v1` Protomux channel on a Hyperswarm connection |
| Direction | client to server | either side, on the same channel |
| Envelopes | JSON-RPC 2.0 | the same, byte for byte |
| Service parameters | HTTP headers | `a2a-service-parameters` request member |
| Streaming | SSE; ends when the response closes | responses sharing the request `id`; ends with `pai/end` |
| Authentication | `securitySchemes`, credentials per request | Noise key plus identity proof, once per connection |
| Agent Card | `GET /.well-known/agent-card.json` | pushed as a `pai/card` frame once connected, and on each change |
| Push notifications | optional | not supported by the reference implementation |
| Offline recipients | not covered | sealed envelopes held by a mailbox (Section 7) |

## 9. Reference implementation

[pai](https://github.com/natzcam/pai) implements this binding in TypeScript.
Its tests exercise the binding end to end on a local HyperDHT testnet,
including streaming, cancel, restarts, refusals, simultaneous dials, and
mail delivered through a mailbox while the sender is offline. Its
`pai daemon` exposes remote pai agents to ordinary A2A clients as JSON-RPC
over HTTP on localhost, so clients can use the binding without implementing
it.
