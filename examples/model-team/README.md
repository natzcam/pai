# Model team: ChatGPT, Gemini and Claude working together over pai

Three agents, each a different company's model, and a coordinator that
passes work between them. For each topic:

1. the **writer** (ChatGPT, through `codex`) drafts a short explanation,
2. the **critic** (Gemini, through Antigravity's `agy`) reviews the draft,
3. the **editor** (Claude, through `claude`) writes the final text from both.

Every hop is a `pai send`, so the agents can be on one machine or on four,
anywhere, with no servers in between. A sample run took about 20 seconds:

```
## Draft (writer)
NAT hides devices behind private IP addresses, so peers usually can't connect
directly using those addresses. NAT hole punching coordinates outbound packets…

## Review (critic)
* Omits the rendezvous server: …
* Confuses private addressing with stateful filtering: …
* Lacks the technical failure mechanism: …

## Final (editor)
Most devices sit behind NAT with private addresses, and stateful NAT or
firewall rules drop unsolicited inbound packets, … Apps then fall back to a
relay such as TURN.
```

| File | What it is |
| --- | --- |
| `roles/` | Each role's instructions (`writer.md`, `critic.md`, `editor.md`), given to its agent's harness with `--instructions @roles/<role>.md`. |
| `coordinate.sh` | The coordinator: draft, review, final, by `pai send` to the agents named in `WRITER`, `CRITIC` and `EDITOR`. |

## Setup

- `pai` on your PATH (see the main README's [Install](../../README.md#install)).
- The CLIs for the models you use, each logged in once:
  [Claude Code](https://claude.com/claude-code) (`claude`),
  [Codex](https://github.com/openai/codex) (`codex`) and
  [Antigravity](https://antigravity.google/) (`agy`).

Each agent runs its CLI through `pai daemon --harness`, which runs it
headless per message with a clean environment, so it uses that CLI's own
login (your account with that provider) and doesn't attach to whatever
session started the daemon. `--model` picks a model; the commands below use
fast ones. Messages in one context (a `pai job post --thread`, a workflow,
or a `pai send --context`) continue one session: a writer asked to revise
remembers its draft.

## Run it

Each agent gets its own folder and daemon. On one machine, give each daemon
its own gateway port with `--listen`; on separate machines, drop it.

```sh
EX=/path/to/pai/examples/model-team

mkdir writer critic editor coordinator you

# The writer starts the group; its daemon answers the others' invites
(cd writer && pai init --name writer --description "ChatGPT: drafts explanations")
(cd writer && pai daemon --harness codex --instructions "@$EX/roles/writer.md" --listen 127.0.0.1:7851)  # its own terminal

# An invite each (made in writer/), redeemed in the agent's folder
for a in critic editor coordinator you; do
  (cd writer && pai group invite) > "$a/code"
  (cd "$a" && pai init --name "$a" --join "$(cat code)")
done

# Each in its own terminal; note the id each prints (the writer's too)
(cd critic && pai daemon --harness agy   --instructions "@$EX/roles/critic.md" --model gemini-3.8-flash-low --listen 127.0.0.1:7852)
(cd editor && pai daemon --harness claude --instructions "@$EX/roles/editor.md" --model haiku --listen 127.0.0.1:7853)
(cd coordinator && WRITER=<writer id> CRITIC=<critic id> EDITOR=<editor id> \
  pai daemon --exec "$EX/coordinate.sh" --listen 127.0.0.1:7854)
(cd you && pai daemon --listen 127.0.0.1:7855)

# Ask the team
cd you && pai send <coordinator id> "why peer-to-peer apps need NAT hole punching"
```

## Changing the team

- **Swap models:** any role can use any harness, e.g. a Claude critic is
  `pai daemon --harness claude --instructions @$EX/roles/critic.md`. For a
  CLI pai has no harness for, `pai daemon --exec <command>` runs any
  command that reads a prompt on stdin and prints an answer.
- **New roles:** add a file to `roles/`, and a step to `coordinate.sh` (or a
  workflow).
- **Offline agents:** with a mailbox (see the main README), the coordinator
  can use `pai send --durable` and pick up answers from `pai outbox` later.
- **Without the coordinator:** `pai send <writer id> "…"` asks one model
  directly; the coordinator is just another agent that calls the others.

## On a group's job board

The same team without a coordinator agent or any agent ids: the agents join
a group with a role each, run `pai daemon --worker`, and `board.sh` posts
each step as a job for a role. Whichever agent has the role claims the job,
runs it, and the result goes back on the board, where `pai job post --wait`
picks it up.

```sh
EX=/path/to/pai/examples/model-team
mkdir boss writer critic editor

# The group, with you as its admin
(cd boss && pai init --name boss)
(cd boss && pai daemon --listen 127.0.0.1:7850)        # in its own terminal

# An invite per agent, with its role (run these in boss/)
for r in writer critic editor; do
  (cd boss && pai group invite --role "$r") > "$r/code"
done
for r in writer critic editor; do
  (cd "$r" && pai init --name "$r" --join "$(cat code)")
done

# Each in its own terminal
(cd writer && pai daemon --worker --harness codex  --instructions "@$EX/roles/writer.md" --listen 127.0.0.1:7851)
(cd critic && pai daemon --worker --harness agy    --instructions "@$EX/roles/critic.md" --model gemini-3.8-flash-low --listen 127.0.0.1:7852)
(cd editor && pai daemon --worker --harness claude --instructions "@$EX/roles/editor.md" --model haiku --listen 127.0.0.1:7853)

# Ask the team, from any member (here the admin)
cd boss && "$EX/board.sh" "why peer-to-peer apps need NAT hole punching"
```

Or as a workflow, which the group steps through on its own (no script
waiting in between): `team.json` holds the three steps.

```sh
cd boss && pai flow start "$EX/team.json" --wait "why peer-to-peer apps need NAT hole punching"
```

With a person in the loop: `approval.json` drafts, then waits for someone
with the `approver` role (invite one with `pai group invite --role
approver`, or add the role to a member with `pai group role`; their
daemon runs no worker) to take the approval step by hand (`pai inbox`,
`pai job take`, `pai job done <id> approved` or what to change, or `pai job
fail` to reject), and branches on their answer: publish, revise, or give
up.

Fanning out: `fanout.json` has the writer outline a topic as a JSON array
of three parts, writes each part as its own job (a map step: writers
share them, in parallel), and has the editor join them.

```sh
cd boss && pai flow start "$EX/fanout.json" --wait "how DHTs find peers"
```

Looping: `loop.json` has the critic review the draft and the writer redo
it with the notes, until the critic says "approved" (at most 3 rounds),
then has the editor polish the last draft.

Planning: `plan.json` has the writer plan the work as a workflow of its
own, runs that plan as a sub-workflow, and has three critics vote on the
result (two must agree).

```sh
cd boss && pai flow start "$EX/loop.json" --wait "how DHTs find peers"
cd boss && pai flow start "$EX/plan.json" --wait "how DHTs find peers"
```

Every morning: `pai flow schedule digest "$EX/team.json" --every 86400
--start 2026-12-01T09:00 "what changed in P2P networking"` has the group
start it each day by itself (an admin's device has to be running).

`pai job list` shows the board: who posted what, who claimed it, and how it
ended. Two agents with the same role share that role's jobs, and a job
waits on the board while no agent with its role is running.
