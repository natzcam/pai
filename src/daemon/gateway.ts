import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AgentCard, ListTasksRequest, Message } from '../a2a/types.js'
import { A2A_METHODS, A2A_PROTOCOL_VERSION, SERVICE_PARAMS } from '../a2a/types.js'
import { PaiCardError, PaiConnectionError, PaiRpcError } from '../errors.js'
import type { Pai } from '../pai.js'
import type { Peer } from '../peer.js'
import { ErrorCodes } from '../protocol/jsonrpc.js'
import { GroupIdentity } from '../identity/group.js'
import type { GroupMembership } from '../group/membership.js'
import { uiPage } from './ui.js'
import { RULES, isId, isRoles, isRuleName, isSelector } from '../group/state.js'
import { JOB_STATES, MIN_LEASE, isEnded, isJobId, isJobTarget, limitsOf, limitsProblem, partsText, questionKey, specProblem } from '../group/jobs.js'
import type { JobLimits, JobRecord, JobSpec } from '../group/jobs.js'
import type { FlowSpec, Schedule } from '../group/flows.js'
import type { PolicyRule, QuorumOp, Role } from '../group/state.js'
import type { JsonRpcId } from '../protocol/jsonrpc.js'

// The gateway: local apps speak A2A's JSON-RPC binding over HTTP, and the
// calls go out over pai as this agent. Loopback only, behind a bearer token.
//
//   GET  /                                       { id, card }
//   GET  /agents/<id>/.well-known/agent-card.json the remote card, gateway first
//   POST /agents/<id>[?group=]                   one JSON-RPC request (a new
//                                                message's task is shared in that
//                                                group, or the default one)
//   GET  /agents/<id>/pai/card[?watch]           the remote card as published,
//                                                or SSE of its changes
//   POST /pai/post                               { to, message }: a durable post
//   GET  /pai/outbox                             { posts }: this agent's posts
//   GET  /pai/groups                             { groups, default }: the groups this
//                                                identity is in
//   POST /pai/groups                             { action: 'create', name, title? }
//                                                or { action: 'join', code, as? }
//
// Group routes act on ?group=<name or id>, or the default group:
//   GET  /pai/group                              { id, admin, roster }: the group
//   POST /pai/group                              { action, ... }: an admin action
//                                                (see groupAction)
//   GET  /pai/device                             { identity, device, devices }
//   POST /pai/device                             { action: 'invite', hours? } or
//                                                { action: 'remove', device }
//   GET  /pai/jobs[?state=]                      { jobs }: the job board, newest first
//   GET  /pai/jobs/<id>[?wait=<ms>]              { job }, once it ends if waiting
//   POST /pai/jobs                               { action: 'post', spec: {text, data?, attach?, context?}, to?, lease?, timeout?, deadline?, retries?, backoff? }
//                                                { action: 'take' | 'release', id }: by hand
//                                                { action: 'finish', id, state, text }
//                                                { action: 'answer', id, text }: a question it asked
//                                                or { action: 'cancel', id }
//   GET  /pai/schedules                          { schedules }: the group's
//   POST /pai/schedules                          { action: 'set', schedule }
//                                                or { action: 'drop', name }
//   GET  /pai/inbox                              { questions, open, held, proposals, inputs }:
//                                                every group's (each item names its
//                                                `group`), or just ?group's
//   GET  /ui                                     the web page (no token: pai ui links it with one)
//   GET  /pai/flows                              { flows }: workflows, newest first
//   GET  /pai/flows/<id>[?wait=<ms>]             { flow }, once it ends if waiting
//   POST /pai/flows                              { action: 'start', spec, input }
//                                                or { action: 'cancel', id }

export interface GatewayOptions {
  // Required on every request as `Authorization: Bearer <token>`.
  token: string
  // Default 127.0.0.1. Only loopback addresses are accepted.
  host?: string
  // Default 7777; 0 picks a free port.
  port?: number
  // Request bodies above this many bytes are refused. Default 32 MiB.
  maxBody?: number
  // The group that group routes act on without ?group (its name), and
  // told the list when it changes here (a group made or joined).
  defaultGroup?: () => string | undefined | Promise<string | undefined>
}

export interface Gateway {
  // http://<host>:<port>
  readonly url: string
  close (): Promise<void>
}

// The scheme the gateway's cards declare, so SDKs know to send the token.
export const GATEWAY_SECURITY_SCHEME = 'paiDaemon'

const DEFAULT_PORT = 7777
const DEFAULT_MAX_BODY = 32 * 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const STREAMING: ReadonlySet<string> = new Set([A2A_METHODS.sendStreamingMessage, A2A_METHODS.subscribeToTask])
// The longest a job read waits for the job to end.
const MAX_WAIT = 5 * 60 * 1000
// How often a group join that's waiting for an admin says it's still there.
const JOIN_KEEPALIVE = 30_000
const AGENT_ROUTE = /^\/agents\/([0-9a-f]{64})(\/\.well-known\/agent-card\.json|\/pai\/card)?\/?$/

export async function startGateway (pai: Pai, opts: GatewayOptions): Promise<Gateway> {
  const host = opts.host ?? '127.0.0.1'
  if (!LOOPBACK.has(host)) throw new Error(`The gateway only listens on loopback addresses, not ${host}`)
  const token = Buffer.from(opts.token)
  const maxBody = opts.maxBody ?? DEFAULT_MAX_BODY
  let base = ''
  let port = 0
  // What each held job runs as, by claim ("<id> <claim time>"): it doesn't
  // change while the claim lasts, and the inbox is read every few seconds.
  let inputs = new Map<string, Promise<string>>()

  const server: HttpServer = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: (err as Error)?.message ?? String(err) })
      else res.destroy()
    })
  })

  async function handle (req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a page can point its own name at 127.0.0.1, but it
    // can't make the browser send a loopback Host header.
    if (!allowedHost(req.headers.host, port)) return send(res, 403, { error: 'Host must be a loopback address with the gateway port' })
    // Browsers send Origin on cross-site requests: only this gateway's own
    // page (pai ui) may call it from a browser.
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host ?? ''}`) return send(res, 403, { error: 'Browser requests from other sites are not accepted' })
    // The page itself carries no data, so it needs no token: it gets one
    // from the link pai ui prints.
    const path = new URL(req.url ?? '/', 'http://gateway').pathname
    if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/ui' || path === '/ui/')) return servePage(res, req.method === 'HEAD')
    if (!authorized(req.headers.authorization, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="pai daemon"')
      return send(res, 401, { error: 'Missing or wrong bearer token (see .pai/daemon-token)' })
    }

    const url = new URL(req.url ?? '/', base)
    // The group a group route acts on, or null once an error is sent.
    const groupOf = async (): Promise<GroupMembership | null> => {
      const identity = pai.options.identity
      if (!(identity instanceof GroupIdentity)) {
        send(res, 409, { error: 'This agent has no group identity' })
        return null
      }
      const ref = url.searchParams.get('group') ?? await opts.defaultGroup?.() ?? undefined
      try {
        return identity.group(ref)
      } catch (err) {
        send(res, 404, { error: (err as Error).message })
        return null
      }
    }
    if (url.pathname === '/pai/groups') return await groups(req, res)
    if (url.pathname === '/' && req.method === 'GET') {
      // In a group the agent's id is its identity; `device` is this one.
      const identity = pai.options.identity
      return send(res, 200, { id: identity instanceof GroupIdentity ? identity.self : hex(pai.id), device: hex(pai.id), card: await pai.card() })
    }
    if (url.pathname === '/pai/outbox') {
      if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' })
      return send(res, 200, { posts: await pai.posts() })
    }
    if (url.pathname === '/pai/post') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' })
      return await post(req, res)
    }
    if (url.pathname === '/pai/device') {
      const identity = pai.options.identity
      if (!(identity instanceof GroupIdentity)) return send(res, 409, { error: 'This agent has no group identity' })
      const state = () => ({ identity: identity.self, device: identity.device, devices: identity.own.state.devices })
      if (req.method === 'GET') return send(res, 200, state())
      if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' })
      let body: { action?: unknown, hours?: unknown, device?: unknown }
      try {
        body = JSON.parse(await readBody(req, maxBody))
      } catch (err) {
        if (err instanceof TooLarge) return send(res, 413, { error: err.message })
        return send(res, 400, { error: 'Invalid JSON payload' })
      }
      try {
        if (body?.action === 'invite') {
          const hours = body.hours ?? 24
          if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return send(res, 400, { error: 'hours must be a positive number' })
          return send(res, 200, { ...await identity.inviteDevice({ expiresIn: hours * 60 * 60 * 1000 }), ...state() })
        }
        if (body?.action === 'remove') {
          if (!isId(body.device)) return send(res, 400, { error: 'Expected a device id (64 hex characters)' })
          await identity.removeDevice(body.device)
          return send(res, 200, state())
        }
        return send(res, 400, { error: 'Unknown device action' })
      } catch (err) {
        return send(res, 409, { error: (err as Error).message })
      }
    }
    if (url.pathname === '/pai/group') {
      const identity = await groupOf()
      if (!identity) return
      if (req.method === 'GET') return send(res, 200, groupState(identity))
      if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' })
      let body: GroupAction
      try {
        body = JSON.parse(await readBody(req, maxBody))
      } catch (err) {
        if (err instanceof TooLarge) return send(res, 413, { error: err.message })
        return send(res, 400, { error: 'Invalid JSON payload' })
      }
      try {
        return send(res, 200, await groupAction(identity, body))
      } catch (err) {
        return send(res, err instanceof BadAction ? 400 : 409, { error: (err as Error).message })
      }
    }
    if (url.pathname === '/pai/jobs' || url.pathname.startsWith('/pai/jobs/')) {
      const identity = await groupOf()
      if (!identity) return
      const jobId = url.pathname.slice('/pai/jobs/'.length)
      if (url.pathname.startsWith('/pai/jobs/')) {
        if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' })
        if (!isJobId(jobId)) return send(res, 400, { error: 'Expected a job id (32 hex characters)' })
        const wait = Number(url.searchParams.get('wait') ?? 0)
        if (!Number.isFinite(wait) || wait < 0) return send(res, 400, { error: 'wait is a number of milliseconds' })
        const gone = new AbortController()
        res.on('close', () => { gone.abort() })
        // `asked`: the question the caller has seen ("<claim time>:<n>"): a
        // wait also returns when a new one comes.
        const asked = url.searchParams.get('asked') ?? ''
        const done = (j: JobRecord | null): boolean => isEnded(j) || questionKey(j) !== asked
        const job = wait > 0 ? await identity.waitJobWhere(jobId, done, { timeout: Math.min(wait, MAX_WAIT), signal: gone.signal }) : await identity.getJob(jobId)
        return job ? send(res, 200, { job }) : send(res, 404, { error: 'No such job' })
      }
      if (req.method === 'GET') {
        const state = url.searchParams.get('state')
        if (state !== null && !(JOB_STATES as readonly string[]).includes(state)) return send(res, 400, { error: `state is one of ${JOB_STATES.join(', ')}` })
        const jobs = (await identity.listJobs()).filter((j) => state === null || j.state === state)
        return send(res, 200, { jobs })
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' })
      let body: { action?: unknown, spec?: unknown, to?: unknown, lease?: unknown, id?: unknown, state?: unknown, text?: unknown, timeout?: unknown, deadline?: unknown, retries?: unknown, backoff?: unknown }
      try {
        body = JSON.parse(await readBody(req, maxBody))
      } catch (err) {
        if (err instanceof TooLarge) return send(res, 413, { error: err.message })
        return send(res, 400, { error: 'Invalid JSON payload' })
      }
      try {
        if (body?.action === 'post') {
          const spec = body.spec as JobSpec
          if (typeof spec?.text !== 'string') return send(res, 400, { error: 'spec.text is required' })
          const specIssue = specProblem(spec)
          if (specIssue) return send(res, 400, { error: specIssue })
          if (body.to !== undefined && !isJobTarget(body.to)) return send(res, 400, { error: 'to is role:<role> or an agent id' })
          if (body.lease !== undefined && !(Number.isInteger(body.lease) && (body.lease as number) >= MIN_LEASE)) return send(res, 400, { error: `lease is a whole number of milliseconds, at least ${MIN_LEASE}` })
          const limits = limitsOf(body as JobLimits)
          const problem = limitsProblem(limits)
          if (problem) return send(res, 400, { error: problem })
          return send(res, 200, { job: await identity.postJob(spec, { ...(body.to ? { to: body.to as string } : {}), ...(body.lease ? { lease: body.lease as number } : {}), ...limits }) })
        }
        if (body?.action !== 'cancel' && body?.action !== 'take' && body?.action !== 'release' && body?.action !== 'finish' && body?.action !== 'answer') return send(res, 400, { error: 'Unknown job action' })
        if (!isJobId(body.id)) return send(res, 400, { error: 'Expected a job id (32 hex characters)' })
        if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') return send(res, 400, { error: 'text is a string' })
        const id = body.id
        const text = (): string | null => typeof body.text === 'string' ? body.text : null
        switch (body.action) {
          case 'cancel':
            return send(res, 200, { job: await identity.cancelJob(id) })
          case 'take': {
            const gone = new AbortController()
            res.on('close', () => { gone.abort() })
            const taken = await identity.takeJob(id, { signal: gone.signal })
            // What it runs as (attached results and all), for whoever does it by hand.
            const input = taken.mine ? partsText((await identity.jobInput(taken.job)).parts, '\n\n') : undefined
            return send(res, 200, { ...taken, ...(input !== undefined ? { input } : {}) })
          }
          case 'release':
          case 'finish': {
            // Only a job taken by hand on this device: not one its worker
            // (or another device) is running.
            if (body.action === 'finish' && body.state !== 'done' && body.state !== 'failed') return send(res, 400, { error: 'state is done or failed' })
            const job = await identity.getJob(id)
            if (!identity.holdsByHand(job)) {
              return send(res, 409, { error: 'This agent doesn\'t hold that job by hand: pai job take it first' })
            }
            if (body.action === 'release') await identity.releaseJob(id)
            else await identity.finishJob(id, { state: body.state as 'done' | 'failed', result: text(), ref: null })
            return send(res, 200, { job: await identity.getJob(id) })
          }
          case 'answer': {
            const answer = text()
            if (answer === null) return send(res, 400, { error: 'text is required' })
            return send(res, 200, { job: await identity.answerJob(id, answer) })
          }
        }
      } catch (err) {
        return send(res, 409, { error: (err as Error).message })
      }
    }
    if (url.pathname === '/pai/inbox') {
      const identity = pai.options.identity
      if (!(identity instanceof GroupIdentity)) return send(res, 409, { error: 'This agent has no group identity' })
      if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' })
      let groups: GroupMembership[]
      try {
        groups = url.searchParams.has('group') ? [identity.group(url.searchParams.get('group')!)] : identity.groups()
      } catch (err) {
        return send(res, 404, { error: (err as Error).message })
      }
      // Every group's, each item marked with its group's name.
      const box = { questions: [] as unknown[], open: [] as unknown[], held: [] as unknown[], proposals: [] as unknown[] }
      // What each held job runs as, where that's more than its text
      // (attached results, or a note on a retry).
      const next = new Map<string, Promise<string>>()
      const shown: Record<string, string> = {}
      for (const g of groups) {
        const mine = await g.inbox()
        const mark = <T extends object>(x: T): T & { group: string } => ({ ...x, group: g.name })
        box.questions.push(...mine.questions.map(mark))
        box.open.push(...mine.open.map(mark))
        box.held.push(...mine.held.map(mark))
        box.proposals.push(...mine.proposals.map(mark))
        await Promise.all(mine.held.filter((j) => j.spec.attach?.length || ((j.attempt ?? 1) > 1 && j.lastError != null)).map(async (j) => {
          const key = `${j.id} ${j.claim?.at ?? 0}`
          const input = inputs.get(key) ?? g.jobInput(j).then((m) => partsText(m.parts, '\n\n'))
          next.set(key, input)
          try {
            shown[j.id] = await input
          } catch {
            next.delete(key)
          }
        }))
      }
      inputs = next
      return send(res, 200, { ...box, inputs: shown })
    }
    if (url.pathname === '/pai/schedules') {
      const identity = await groupOf()
      if (!identity) return
      if (req.method === 'GET') return send(res, 200, { schedules: await identity.listSchedules() })
      if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' })
      let body: { action?: unknown, schedule?: unknown, name?: unknown }
      try {
        body = JSON.parse(await readBody(req, maxBody))
      } catch (err) {
        if (err instanceof TooLarge) return send(res, 413, { error: err.message })
        return send(res, 400, { error: 'Invalid JSON payload' })
      }
      try {
        if (body?.action === 'set') return send(res, 200, { schedule: await identity.setSchedule(body.schedule as Schedule) })
        if (body?.action === 'drop') {
          if (typeof body.name !== 'string') return send(res, 400, { error: 'name is text' })
          await identity.dropSchedule(body.name)
          return send(res, 200, { dropped: body.name })
        }
        return send(res, 400, { error: 'Unknown schedule action' })
      } catch (err) {
        return send(res, 409, { error: (err as Error).message })
      }
    }
    if (url.pathname === '/pai/flows' || url.pathname.startsWith('/pai/flows/')) {
      const identity = await groupOf()
      if (!identity) return
      if (url.pathname.startsWith('/pai/flows/')) {
        if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' })
        const flowId = url.pathname.slice('/pai/flows/'.length)
        if (!isJobId(flowId)) return send(res, 400, { error: 'Expected a workflow id (32 hex characters)' })
        const wait = Number(url.searchParams.get('wait') ?? 0)
        if (!Number.isFinite(wait) || wait < 0) return send(res, 400, { error: 'wait is a number of milliseconds' })
        const gone = new AbortController()
        res.on('close', () => { gone.abort() })
        const flow = wait > 0 ? await identity.waitFlow(flowId, { timeout: Math.min(wait, MAX_WAIT), signal: gone.signal }) : await identity.getFlow(flowId)
        return flow ? send(res, 200, { flow }) : send(res, 404, { error: 'No such workflow' })
      }
      if (req.method === 'GET') return send(res, 200, { flows: await identity.listFlows() })
      if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' })
      let body: { action?: unknown, spec?: unknown, input?: unknown, id?: unknown }
      try {
        body = JSON.parse(await readBody(req, maxBody))
      } catch (err) {
        if (err instanceof TooLarge) return send(res, 413, { error: err.message })
        return send(res, 400, { error: 'Invalid JSON payload' })
      }
      try {
        if (body?.action === 'start') {
          if (typeof body.input !== 'string') return send(res, 400, { error: 'input is text' })
          return send(res, 200, { flow: await identity.startFlow(body.spec as FlowSpec, body.input) })
        }
        if (body?.action === 'cancel') {
          if (!isJobId(body.id)) return send(res, 400, { error: 'Expected a workflow id (32 hex characters)' })
          return send(res, 200, { flow: await identity.cancelFlow(body.id) })
        }
        return send(res, 400, { error: 'Unknown workflow action' })
      } catch (err) {
        return send(res, 409, { error: (err as Error).message })
      }
    }
    const route = AGENT_ROUTE.exec(url.pathname)
    if (!route) return send(res, 404, { error: 'Not found' })
    const id = route[1]!
    if (route[2]) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' })
      if (route[2] === '/pai/card') return await (url.searchParams.has('watch') ? watchCard(res, id) : publishedCard(res, id))
      return await card(res, id)
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' })
    return await rpc(req, res, url, id)
  }

  // The groups this identity is in; making and joining more.
  async function groups (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const identity = pai.options.identity
    if (!(identity instanceof GroupIdentity)) return send(res, 409, { error: 'This agent has no group identity' })
    const list = async (): Promise<unknown> => {
      const wanted = await opts.defaultGroup?.()
      const all = identity.groups()
      const fallback = all.find((g) => g.name === wanted) ?? all[0]
      return {
        default: fallback?.name ?? null,
        groups: all.map((g) => {
          const roster = g.base.roster
          return { id: g.id, name: g.name, title: roster.title, admin: roster.admins.includes(g.self), members: roster.members.length, writable: g.base.writable, problem: g.problem }
        })
      }
    }
    if (req.method === 'GET') return send(res, 200, await list())
    if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' })
    let body: { action?: unknown, name?: unknown, title?: unknown, code?: unknown, as?: unknown }
    try {
      body = JSON.parse(await readBody(req, maxBody))
    } catch (err) {
      if (err instanceof TooLarge) return send(res, 413, { error: err.message })
      return send(res, 400, { error: 'Invalid JSON payload' })
    }
    const text = (v: unknown, what: string): string | undefined => {
      if (v === undefined) return undefined
      if (typeof v !== 'string' || v.trim() === '' || v.length > 200) throw new BadAction(`${what} is text, up to 200 characters`)
      return v
    }
    try {
      const member = pai.options.card.name
      if (body?.action === 'create') {
        const name = text(body.name, 'name')
        if (name === undefined) throw new BadAction('name is required')
        const title = text(body.title, 'title')
        const g = await identity.createGroup(name, { member, ...(title ? { title } : {}) })
        return send(res, 200, { created: g.name, ...await list() as object })
      }
      if (body?.action === 'join') {
        if (typeof body.code !== 'string') throw new BadAction('code is required')
        const as = text(body.as, 'as')
        const code = body.code
        const gone = new AbortController()
        res.on('close', () => { gone.abort() })
        // A join waits for an admin, maybe for hours: the answer starts at
        // once and a space goes out every 30 s (an HTTP client gives up on
        // a quiet response), then the JSON, with `error` if it failed.
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        const keepAlive = setInterval(() => { res.write(' ') }, JOIN_KEEPALIVE)
        try {
          const g = await identity.joinGroup(code, { member, signal: gone.signal, ...(as ? { name: as } : {}) })
          res.end(JSON.stringify({ joined: g.name, ...await list() as object }))
        } catch (err) {
          res.end(JSON.stringify({ error: (err as Error).message }))
        } finally {
          clearInterval(keepAlive)
        }
        return
      }
      throw new BadAction('Unknown groups action')
    } catch (err) {
      return send(res, err instanceof BadAction ? 400 : 409, { error: (err as Error).message })
    }
  }

  async function post (req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { to?: unknown, message?: unknown }
    try {
      body = JSON.parse(await readBody(req, maxBody))
    } catch (err) {
      if (err instanceof TooLarge) return send(res, 413, { error: err.message })
      return send(res, 400, { error: 'Invalid JSON payload' })
    }
    if (typeof body?.to !== 'string' || !/^[0-9a-f]{64}$/.test(body.to)) return send(res, 400, { error: 'to must be an agent id' })
    const message = body.message as Message | undefined
    if (typeof message !== 'object' || message === null || typeof message.messageId !== 'string' || !Array.isArray(message.parts)) {
      return send(res, 400, { error: 'message must be an A2A Message' })
    }
    send(res, 200, await pai.post(Buffer.from(body.to, 'hex'), message))
  }

  async function card (res: ServerResponse, id: string): Promise<void> {
    let remote: AgentCard | null
    try {
      remote = await (await connect(id)).card({ strict: false })
    } catch (err) {
      return send(res, 502, { error: errorMessage(err) })
    }
    if (!remote) return send(res, 404, { error: 'The agent has no card' })
    send(res, 200, gatewayCard(remote, `${base}/agents/${id}`))
  }

  // The card exactly as the agent publishes it, checked against the schema.
  async function publishedCard (res: ServerResponse, id: string): Promise<void> {
    let remote: AgentCard | null
    try {
      remote = await (await connect(id)).card()
    } catch (err) {
      return send(res, 502, { error: errorMessage(err), ...(err instanceof PaiCardError ? { errors: err.errors } : {}) })
    }
    if (!remote) return send(res, 404, { error: 'The agent has no card yet' })
    send(res, 200, remote)
  }

  // SSE: each valid card as it changes; an `invalid` event for one that
  // fails validation. Runs until the client goes away.
  async function watchCard (res: ServerResponse, id: string): Promise<void> {
    let peer: Peer
    try {
      peer = await connect(id)
    } catch (err) {
      return send(res, 502, { error: errorMessage(err) })
    }
    const stop = new AbortController()
    res.on('close', () => { stop.abort() })
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const onInvalid = (err: PaiCardError): void => { res.write(`event: invalid\ndata: ${JSON.stringify({ errors: err.errors })}\n\n`) }
    try {
      for await (const c of peer.watchCard({ signal: stop.signal, onInvalid })) res.write(`data: ${JSON.stringify(c)}\n\n`)
    } catch (err) {
      if (!stop.signal.aborted) res.write(`event: error\ndata: ${JSON.stringify({ error: errorMessage(err) })}\n\n`)
    }
    res.end()
  }

  async function rpc (req: IncomingMessage, res: ServerResponse, url: URL, id: string): Promise<void> {
    let body: unknown
    try {
      body = JSON.parse(await readBody(req, maxBody))
    } catch (err) {
      if (err instanceof TooLarge) return send(res, 413, { error: err.message })
      return rpcError(res, null, ErrorCodes.ParseError, 'Invalid JSON payload')
    }
    if (!isRequest(body)) return rpcError(res, idOf(body), ErrorCodes.InvalidRequest, 'Request payload validation error')

    // A missing version means 0.3, which pai doesn't speak.
    const version = header(req, SERVICE_PARAMS.version) ?? url.searchParams.get(SERVICE_PARAMS.version) ?? ''
    if (version.split('.').slice(0, 2).join('.') !== A2A_PROTOCOL_VERSION) {
      return failure(res, body.id, PaiRpcError.versionNotSupported(version || '0.3', A2A_PROTOCOL_VERSION))
    }
    const extensions = header(req, SERVICE_PARAMS.extensions)
    const callOpts = extensions ? { serviceParameters: { [SERVICE_PARAMS.extensions]: extensions } } : {}

    // Its own device, or its own identity with no other device connected.
    const own = pai.options.identity instanceof GroupIdentity ? pai.options.identity.self : null
    if (id === hex(pai.id) || (id === own && pai.devicesOf(Buffer.from(id, 'hex')).length === 0)) {
      return failure(res, body.id, PaiRpcError.a2a(ErrorCodes.InternalError, 'SELF_CALL', 'This is the daemon\'s own agent'))
    }
    // ListTasks on an identity asks each of its devices and merges.
    if (body.method === A2A_METHODS.listTasks) {
      try {
        send(res, 200, { jsonrpc: '2.0', id: body.id, result: await pai.listTasksOf(Buffer.from(id, 'hex'), (body.params ?? {}) as ListTasksRequest) })
      } catch (err) {
        failure(res, body.id, err instanceof PaiConnectionError ? unreachable(err) : err)
      }
      return
    }
    // GetTask on an identity can be answered from the group's copy.
    if (body.method === A2A_METHODS.getTask) {
      const params = (body.params ?? {}) as { id?: unknown, historyLength?: number }
      if (typeof params.id === 'string' && pai.options.identity.isPrincipal?.(Buffer.from(id, 'hex'))) {
        try {
          send(res, 200, { jsonrpc: '2.0', id: body.id, result: await pai.getTaskOf(Buffer.from(id, 'hex'), params.id, params.historyLength, callOpts) })
        } catch (err) {
          failure(res, body.id, err instanceof PaiConnectionError ? unreachable(err) : err)
        }
        return
      }
    }
    // A new message names the group its task is shared in (if both are in
    // it): ?group, or the default group, unless the message names one.
    if (body.method === A2A_METHODS.sendMessage || body.method === A2A_METHODS.sendStreamingMessage) {
      const identity = pai.options.identity
      const message = (body.params as { message?: Message } | undefined)?.message
      if (identity instanceof GroupIdentity && message && typeof message === 'object' && message.metadata?.['pai/group'] === undefined) {
        const ref = url.searchParams.get('group') ?? await opts.defaultGroup?.() ?? undefined
        const g = identity.groups().find((x) => x.name === ref || x.id === ref) ?? (url.searchParams.has('group') ? null : identity.groups()[0])
        if (g === null) return failure(res, body.id, PaiRpcError.invalidParams(`This agent isn't in a group named ${ref}`, 'group'))
        if (g) body.params = { ...(body.params as object), message: { ...message, metadata: { ...(message.metadata ?? {}), 'pai/group': g.id } } }
      }
    }
    let peer: Peer
    try {
      peer = await pai.route(Buffer.from(id, 'hex'), body.method, body.params)
    } catch (err) {
      return failure(res, body.id, unreachable(err))
    }

    if (!STREAMING.has(body.method)) {
      try {
        send(res, 200, { jsonrpc: '2.0', id: body.id, result: await peer.rpc.request(body.method, body.params, callOpts) })
      } catch (err) {
        failure(res, body.id, err)
      }
      return
    }

    // SSE: one event per stream item; the response closes when the pai
    // stream ends. Errors before the first item are a plain JSON response.
    const items = peer.rpc.stream(body.method, body.params, callOpts)
    let closed = false
    res.on('close', () => { closed = true })
    try {
      for await (const result of items) {
        if (closed) break
        if (!res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        }
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`)
      }
    } catch (err) {
      if (!res.headersSent) return failure(res, body.id, err)
      if (!closed) res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, error: toError(err) })}\n\n`)
    } finally {
      // Stops listening for the rest when the client went away.
      await items.return(undefined).catch(() => {})
    }
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end()
  }

  // Any device of `id`, when it's an identity.
  async function connect (id: string): Promise<Peer> {
    return await pai.route(Buffer.from(id, 'hex'))
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? DEFAULT_PORT, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port
  base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`

  return {
    url: base,
    async close () {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

// The remote card as local apps see it: the gateway's JSON-RPC interface
// first (SDKs take the first one they support), and the bearer scheme the
// gateway needs. The remote's own interfaces follow, for reference.
export function gatewayCard (remote: AgentCard, url: string): AgentCard {
  return {
    ...remote,
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }, ...(remote.supportedInterfaces ?? [])],
    securitySchemes: {
      ...remote.securitySchemes,
      [GATEWAY_SECURITY_SCHEME]: { httpAuthSecurityScheme: { scheme: 'Bearer', description: 'The pai daemon token (.pai/daemon-token)' } }
    },
    securityRequirements: [{ schemes: { [GATEWAY_SECURITY_SCHEME]: { list: [] } } }]
  }
}

function servePage (res: ServerResponse, head = false): void {
  const nonce = randomBytes(16).toString('base64')
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  })
  res.end(head ? undefined : uiPage(nonce))
}

function allowedHost (value: string | undefined, port: number): boolean {
  if (!value) return false
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value)
  if (!match) return false
  const name = match[1]!.replace(/^\[|\]$/g, '')
  return LOOPBACK.has(name.toLowerCase()) && Number(match[2]) === port
}

function authorized (value: string | undefined, token: Buffer): boolean {
  const presented = /^Bearer (.+)$/i.exec(value ?? '')?.[1]
  if (!presented) return false
  const given = Buffer.from(presented.trim())
  return given.length === token.length && timingSafeEqual(given, token)
}

function header (req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()]
  return Array.isArray(value) ? value.join(',') : value
}

class TooLarge extends Error {}

async function readBody (req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > max) throw new TooLarge(`Request body over ${max} bytes`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

interface Request { jsonrpc: '2.0', id: JsonRpcId, method: string, params?: unknown }

function isRequest (v: unknown): v is Request {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const r = v as Partial<Request>
  return r.jsonrpc === '2.0' && typeof r.method === 'string' && (typeof r.id === 'string' || typeof r.id === 'number')
}

function idOf (v: unknown): JsonRpcId | null {
  const id = (v as { id?: unknown } | null)?.id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

function unreachable (err: unknown): PaiRpcError {
  return new PaiRpcError(ErrorCodes.InternalError, `Agent unreachable: ${errorMessage(err)}`, [{
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason: 'AGENT_UNREACHABLE',
    domain: 'pai'
  }])
}

function toError (err: unknown): { code: number, message: string, data?: unknown } {
  if (err instanceof PaiConnectionError) err = unreachable(err)
  if (err instanceof PaiRpcError) return { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) }
  return { code: ErrorCodes.InternalError, message: errorMessage(err) }
}

function failure (res: ServerResponse, id: JsonRpcId | null, err: unknown): void {
  send(res, 200, { jsonrpc: '2.0', id, error: toError(err) })
}

function rpcError (res: ServerResponse, id: JsonRpcId | null, code: number, message: string): void {
  send(res, 200, { jsonrpc: '2.0', id, error: { code, message } })
}

function send (res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
  res.end(json)
}

function errorMessage (err: unknown): string {
  return (err as Error)?.message ?? String(err)
}

function hex (key: Uint8Array): string {
  return Buffer.from(key).toString('hex')
}

// What `pai group` asks the daemon to do, as its agent.
export type GroupAction =
  | { action: 'invite', days?: number | null, hours?: number, roles?: Role[] }
  | { action: 'remove', id: string }
  | { action: 'roles', id: string, roles: Role[] }
  | { action: 'policy.set', rule: PolicyRule }
  | { action: 'policy.remove', name: string }
  | { action: 'rotate' }
  | { action: 'renew', id: string, days?: number | null }
  | { action: 'propose', op: Exclude<QuorumOp, { type: 'seed.rotate' }> }
  | { action: 'approve' | 'withdraw', pid: string }

class BadAction extends Error {}

function groupState (identity: GroupMembership): unknown {
  const roster = identity.roster()
  const id = identity.self
  return { group: { id: identity.id, name: identity.name }, id, admin: roster.admins.includes(id), writable: identity.base.writable, roster, rules: identity.rules, problem: identity.problem }
}

async function groupAction (identity: GroupMembership, body: GroupAction): Promise<unknown> {
  const id = (v: unknown): string => {
    if (!isId(v)) throw new BadAction('Expected an agent id (64 hex characters)')
    return v
  }
  const days = (v: unknown): number | null => {
    if (v === undefined || v === null) return null
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new BadAction('days must be a positive number')
    return v
  }
  switch (body?.action) {
    case 'invite': {
      const hours = body.hours ?? 24
      if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) throw new BadAction('hours must be a positive number')
      if (body.roles !== undefined && !isRoles(body.roles)) throw new BadAction('roles must be 1 to 8 lowercase names')
      const invite = await identity.invite({ days: days(body.days), expiresIn: hours * 60 * 60 * 1000, ...(body.roles ? { roles: body.roles } : {}) })
      return { ...invite, ...groupState(identity) as object }
    }
    case 'remove':
      await identity.act({ type: 'member.remove', id: id(body.id) })
      break
    case 'renew': {
      const d = days(body.days)
      await identity.act({ type: 'member.renew', id: id(body.id), until: d === null ? null : Date.now() + d * 24 * 60 * 60 * 1000 })
      break
    }
    case 'roles':
      if (!isRoles(body.roles)) throw new BadAction('roles must be 1 to 8 lowercase names (not admin)')
      await identity.act({ type: 'member.roles', id: id(body.id), roles: body.roles })
      break
    case 'policy.set': {
      const r = body.rule
      if (!isRuleName(r?.name)) throw new BadAction('A rule name is lowercase letters, digits, ., _ and -, up to 64')
      if (!isSelector(r.from) || !isSelector(r.to)) throw new BadAction('from and to are *, role:<role> or an agent id')
      if (typeof r.allow !== 'boolean') throw new BadAction('allow is true or false')
      await identity.act({ type: 'policy.set', rule: { name: r.name, from: r.from, to: r.to, allow: r.allow } })
      break
    }
    case 'policy.remove':
      if (!isRuleName(body.name)) throw new BadAction('A rule name is lowercase letters, digits, ., _ and -, up to 64')
      await identity.act({ type: 'policy.remove', name: body.name })
      break
    case 'rotate':
      return { pid: await identity.rotateSeed(), ...groupState(identity) as object }
    case 'propose': {
      if ((body.op as QuorumOp)?.type === 'seed.rotate') throw new BadAction('A new seed is proposed with { action: \'rotate\' }')
      if (body.op?.type === 'rules.set') {
        const v = body.op.version
        if (!Number.isInteger(v) || v <= identity.rules.group) throw new BadAction(`The group is already on rules v${identity.rules.group}`)
        // Every member's pai must apply it first, or theirs stops there.
        if (v > RULES) throw new BadAction(`This pai applies rules up to v${RULES}: upgrade it first`)
      }
      const pid = randomBytes(32).toString('hex')
      await identity.act({ type: 'propose', pid, op: body.op })
      return { pid, ...groupState(identity) as object }
    }
    case 'approve':
    case 'withdraw':
      await identity.act({ type: body.action, pid: id(body.pid) })
      break
    default:
      throw new BadAction('Unknown group action')
  }
  return groupState(identity)
}

