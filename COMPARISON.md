# How pai compares

pai's groups share work through a job board: jobs are ops in the group's
Autobase, every member keeps a copy, and workers claim jobs by role
([DESIGN.md](./DESIGN.md): Job board, Workflows). This page compares that
design with other ways of sharing work: brokers, coordination stores,
workflow engines, schedulers, agent frameworks and hosted coding agents.
It covers what pai borrows from them, what it still lacks, and what it
does that they don't.

## Who decides who gets a job

The main difference between these systems is where the decision is made.

| Where | How | Examples |
|---|---|---|
| One server | A broker hands each job out | RabbitMQ, Sidekiq, SQS, a tuple-space server |
| An elected leader | A cluster agrees, then hands it out | etcd, ZooKeeper, Temporal, Kafka's group coordinator |
| A replicated log | Every copy applies the same rule to the same order | **pai**: the first claim in the log's order wins, and a worker starts once the admins have signed past its claim |
| An open market | Bids, payment and reputation | Golem, Bacalhau, Akash |

## The landscape

| Kind | Examples | Who coordinates | How a job is claimed | Failure detection | Workflows |
|---|---|---|---|---|---|
| Broker queues | Celery/RabbitMQ, Sidekiq, SQS | A central broker | The broker gives each message to one consumer | Acks, or SQS's visibility timeout; a dead-letter queue after N tries | None, or add-ons |
| Partitioned logs | Kafka consumer groups | A group coordinator | Whole partitions go to consumers, not single items | Missed heartbeats trigger a rebalance | None |
| Coordination stores | etcd, ZooKeeper, Consul | A Raft or ZAB leader | Locks and keys with a TTL | Leases on the leader's clock | None |
| Durable workflow engines | Temporal, Restate, Step Functions, Durable Functions | A central service | Workers poll a task queue, often one per kind of worker | Activity heartbeats, timeouts, retry policies | Rich: code or JSON state machines, with retries, timers, signals and branches |
| DAG schedulers | Airflow, Prefect, Dagster, Argo | A scheduler plus executors | The scheduler pushes tasks out | Task timeouts and retries | Rich DAGs, schedules, backfills |
| Cluster schedulers | Kubernetes Jobs, Nomad, Ray | A control plane | Placed by resources (push) | Node and pod health | Little on their own |
| LLM agent frameworks | LangGraph, CrewAI, Microsoft Agent Framework, Google ADK, OpenAI Agents SDK, Mastra | One program holds the graph or a manager agent | Routed by code or by an LLM | The program's own error handling | Graphs, loops and handoffs over typed state, inside one runtime |
| Tuple spaces | Linda, JavaSpaces, blackboard systems | A shared space, usually one server | `take()` removes a tuple atomically | JavaSpaces had leases | None |
| **pai's job board** | | Nobody: every member's copy of the log | First claim in the log's order, run once signed by the admins | Leases the worker renews, time limits, deadlines and retries, on the admins' clock | JSON steps with branches, loops, map and copies (races, votes), sub-workflows (planned ones too) and schedules, posted by the group's own rules |

## What pai borrows

Its closest relative is a tuple space with leases, like JavaSpaces, except
that the space is replicated to every member instead of held on one server.

- **Raft commit (etcd, ZooKeeper).** A worker waits until a majority of
  admins have signed past its claim before it runs the job, so no later
  reordering can hand the job to someone else.
- **Visibility timeouts and heartbeats (SQS, Temporal).** A leased claim
  lapses unless its worker renews it, which it does three times per lease.
  A worker that has gone quiet loses the job, and another can take it.
- **Task queues (Temporal).** `role:writer` works like a task queue:
  workers pull work by what they are, and the poster doesn't need to know
  which machine runs it.
- **JSON state machines (Step Functions, Argo).** A workflow is a file of
  steps with `after` dependencies, and steps can branch on an earlier
  step's result or failure. The group's rules post each step once the
  steps it waits for are done, so every copy computes the same next step
  and nobody has to stay online to drive it.
- **Map states and loops (Step Functions, ADK).** A step can run once per
  item of a list, or as several copies settled by the first result or by
  k that agree; a range of steps can repeat until a test holds.
- **Schedules (Airflow, Temporal).** The group starts a workflow every
  period, by its own clock, skipping a run while the last is going.
- **Retry policies and dead-letter queues (Temporal, SQS).** A job or step
  can have a per-attempt time limit, a deadline, and retries with a
  doubling backoff; a failure, a timeout or an abandoned lease uses one
  up, and the job fails once they're gone.
- **The leader's clock (etcd).** Ops carry their author's time, which a
  member could fake, so leases, limits and memberships run on the group's
  clock instead: the latest time any admin's op carries, moved on by an
  admin's device whenever something falls due.

## Agent frameworks are a different layer

LangGraph, CrewAI, Microsoft Agent Framework, Google ADK, the OpenAI Agents
SDK, LlamaIndex Workflows, Pydantic AI and Mastra run every agent inside
one program, owned by one party. pai is for agents that run as separate
processes on different machines, possibly owned by different people, where
nobody holds the whole graph.

| Framework | How it orchestrates | Nearest thing in pai |
|---|---|---|
| LangGraph | A graph of functions over typed shared state; a checkpointer after each step (resume, replay, time travel); `interrupt()` for a person | Steps and `after`; the group's log; a step for a person |
| CrewAI | Crews of role-based agents, sequential or under a manager; Flows of event-driven steps with a router | `role:` targets; a planned sub-workflow; `if` |
| Microsoft Agent Framework | Graph workflows with checkpoints; group chat and handoffs | The group's log; posting a job |
| Google ADK | Sequential, parallel and loop agents around LLM agents; speaks A2A | Steps, `copies` and `map`, `repeat` |
| OpenAI Agents SDK | Handoffs between agents; guardrails on input and output; tracing | Posting a job; none for guardrails |
| Mastra | `.then`, `.branch`, `.parallel` in code; suspend and resume for a person | Steps, `if`, `copies`, a step for a person |

The two layers combine. A framework's app can be one pai worker (`pai
daemon --proxy` in front of its A2A endpoint, or `--exec`), and a
framework's step can post a pai job to hand work to a person or to another
owner's agent: a framework inside an agent, pai between agents.

## Coding agents as workers

Hosted coding agents run each task somewhere disposable, so the task's
author can't reach anything the agent shouldn't touch. pai's harness mode
(`pai daemon --harness`) runs the harness on the member's own machine
instead.

| System | Where a task runs | Network | Config and credentials |
|---|---|---|---|
| GitHub Copilot coding agent | A fresh Actions VM | A firewall with an allowlist | A token scoped to the repository; pushes only to its own branches |
| OpenAI Codex (cloud) | A container per task | Off while the agent runs; an allowlist optional | Secrets only during setup |
| Claude Code sandbox, Claude Code on the web | An OS sandbox or a cloud VM | Through a proxy with an allowlist | Writes only in the working folder |
| Claude Agent SDK | The program's own process | The program's choice | No settings files loaded unless asked for |
| **pai's harness mode** | The member's machine, in the daemon's folder | The harness's own default | The member's own harness config, with an environment cut down to login, locale and network |

Read only, the default, means different things per harness: Claude Code
gets only its Read, Grep and Glob tools; Codex runs in its read-only
sandbox (it may still run commands, and read anywhere); Antigravity runs
in plan mode, which the harness enforces, not the OS. `--write` lets each
edit files in the daemon's folder.

## What it lacks, most important first

pai gives up two things by design: throughput (every op, renewals
included, reaches every member, and a claim waits seconds to be signed:
fine for LLM jobs of tens of seconds, not for thousands a second) and
shared mutable state between steps (results pass as text, so every copy
of the group stays in step). The gaps below are the ones worth closing.

### What workflows can express

1. **Routing on data.** A step branches only on a result's text: it
   `equals` or `contains` something, or the step failed. An agent that
   replies "Approved!" instead of "approved" takes the wrong branch, and
   nothing can test a number or a field. Every framework above branches
   on typed state. Fix: a step declares what its result must look like
   (one of a list, a pattern, or JSON with given fields), and a result
   that doesn't match fails, so retries or a repeat deal with it; then
   conditions can test JSON fields (`{ step, field, gte }`).
2. **Timers and signals.** A workflow can't wait until a time, for a
   period, or for an event from outside (a webhook, another tool, a
   person's click elsewhere). Temporal's timers and signals, Inngest's
   `waitForEvent` and Mastra's suspend do this. Fix: a wait step on the
   group's clock, and `pai flow signal <id> <step> <text>` (with a gateway
   route and a phone button) that settles a waiting step.
3. **Approvals by people beyond one.** No "2 of 3 must approve", and no
   handing a step on when nobody acts in time. Fix: `copies` with
   `settle: { agree }` for people, and a deadline on a person's step that
   leads to a branch.
4. **Undoing earlier steps.** A workflow that fails late leaves what its
   earlier steps did. Temporal and Step Functions users write sagas. Fix:
   steps that run, in reverse, when the workflow fails.
5. **Ending a loop from inside.** Only the step `until` names can end a
   `repeat`; ADK's loop lets any agent in it escalate. Fix: any step in a
   repeat can end it.

### What agents can do

6. **Act and ask mid-run.** An agent run by `--harness` only answers its
   message: it can't post a job, call another agent, start a workflow, or
   stop to ask its person (pai's job questions exist, but the harness
   doesn't use them). LangGraph's `interrupt`, framework tools and MCP's
   elicitation cover this. Fix: `pai mcp`, a small set of pai tools
   (post and get jobs, inbox, ask, call an agent, check and start a
   workflow) that the harness gives each run, and that any MCP client can
   use.
7. **Isolation of harness agents.** Job text comes from other members,
   and the harness runs on the member's machine, so an agent can hold
   private data, untrusted input and a way out at once:
   - Codex's read-only sandbox reads the whole disk; whether Claude Code
     reads outside its folder unasked is untested.
   - The harness loads its owner's own config: `CLAUDE.md`, settings and
     their allow rules, hooks, MCP servers, Codex's `config.toml`.
   - Every job shares the daemon's folder, so two contexts writing at
     once overwrite each other.

   Fix: a config folder of each agent's own, a working folder (or git
   worktree) per job context, and each harness's sandbox switched on,
   with reads kept to the folder; a container (`--container <image>`) for
   those who want Copilot's isolation.
8. **Cost limits.** Every job anyone in the group posts for an agent runs
   on its owner's login, with no cap. The Agents SDK's `max_turns`,
   CrewAI's `max_rpm` and Devin's ACUs bound it. Fix: an agent caps its
   runs per hour or day, and records each run's cost (Claude Code reports
   it, Codex its tokens), summed per workflow.

### Operating it

9. **History and tracing.** There's the live board, `flow get` and the
   web page, but no record of each step's timing, attempts, worker and
   cost over time, as LangSmith, Temporal's UI or Airflow's history keep.
   Fix: record them per step, and show a timeline.
10. **Rerunning from a step.** A workflow reruns only from the start
    (`rerun` on the phone, `flow start` again). LangGraph's time travel
    and Temporal's reset go back to a step, keeping what came before.
    Fix: `pai flow rerun <id> --from <step> [--set <step>=<result>]`, a
    new run that reuses the earlier steps' results.
11. **Testing without agents.** A workflow can be checked
    (`pai flow check`) but not run without real workers. Fix: `pai flow
    test <file> --result <step>=<text> ...`, the group's own rules run in
    memory with scripted results, showing the path taken and the output.
12. **Side effects twice.** A job runs at most once per claim, but a new
    claim reruns it, so it's at least once overall, like SQS. Temporal's
    activities and Restate make side effects safe with idempotency. Fix: a
    stable key per step attempt (`flow/step/round/item`) that workers and
    their tools can deduplicate on.
13. **Admins online.** Signing claims and moving the group's clock (so
    leases, limits, deadlines and schedules take effect) need a majority
    of admins, or at least one admin's device, online. This one is part
    of the design; run several admins on machines that stay up.
14. **Priorities and backpressure.** No priorities or rate limits on the
    board.

## What pai has that the others don't

Across all of the above, none combines these:

- **No infrastructure, across owners.** No broker, cluster or hosted
  service; members on different networks, behind NATs, owned by
  different people.
- **Membership and policy in the shared state.** Who may post, claim and
  call is checked by every copy, not left to whoever deploys it.
- **Nobody has to stay online to drive a workflow,** and none holds it.
- **People as workers.** A person takes, approves or answers a step like
  any agent, from the phone or `pai inbox`.
- **Any agent as a worker.** Claude Code, Codex, a script, or another
  framework's app over A2A.
- **Results stay A2A tasks.** A job runs as an ordinary message from its
  poster, so the poster can read, follow or cancel the task like any of
  its own.

Compared as of November 2026, from each system's documented design as we
know it; check the details against their own documentation.
