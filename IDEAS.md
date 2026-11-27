# Ideas

Ideas that aren't built and aren't promised. Each one says why it's worth doing,
how it would fit what pai already has, and what's still open. When an idea is
built, its design moves into [DESIGN.md](./DESIGN.md) and leaves this file.

## Group chat, with raw models as cheap members

**The idea.** The phone app's main screen becomes a group chat: the group's
people and agents in one thread. A person can talk to an agent, an agent can
answer a person, and anyone can @mention a role or a member. Next to the real
agents (harnesses with tools, see `src/harness.ts`), a group can add **raw
model members**: a model API call with no tools, no workspace and no files.

**Why.** Hosted apps already put several models in one chat (Poe, ChatHub,
TypingMind, LibreChat), so "GPT, Claude and Gemini in one thread" on its own
isn't worth building. What they can't do is put *your* agents in the thread:
the Claude Code agent on your laptop, a colleague's script on their server, you
and a friend on your phones. Those agents sit behind home routers and act on
real machines. pai already connects them. A chat gives pai an everyday use, and
not only a job board you check when an agent asks something.

Raw models are what make a group useful before anyone has set up a real agent:
summarizing, drafting, a second opinion. They also make a gentle first step
toward real agents: same thread, same mentions, and you swap `@claude` (raw)
for `@laptop-claude` (a harness with tools) when something has to get done
instead of said.

### A raw model member

- **A member like any other.** It has its own identity and card. The card lists
  one skill (`chat`) and the model behind it, e.g. `claude-haiku-5-5`. The
  roster, roles, policy and mentions treat it like any member.
- **Text in, text out.** It sees the thread and replies with text. It can't
  touch anyone's machine, which is what makes it safe to add to any group.
- **Cheap because it answers once.** A harness turn is a whole agent loop.
  A raw member's turn is one completion over the recent thread, so it's faster
  and costs a fraction as much.

### Where it runs, and who pays

1. **On the device of the person who added it (recommended).** That person's
   phone or daemon holds the API key and makes the call when the member is
   addressed. The key never leaves their device, it's clear who pays (whoever
   added it pays for its replies), and no server is needed. The cost is that
   it answers only while that device is online. For a phone that's fine in a
   chat, because the person is there.
2. **On an always-on agent.** A laptop or server daemon hosts raw members too,
   reading the same `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`
   the harness already passes through. They stay available while the phone
   sleeps.
3. **A hosted proxy (in pai-registry, say).** Easiest for users, since they need
   no key, but then pai pays for every call and runs a service. Later, if ever,
   and only as a paid tier.

### When it speaks

A chat with models in it works or fails on this.

- **Only when addressed:** an @mention of it, or of a role it holds
  (`@reviewer`). It never answers every message, since that's how multi-model
  chats turn into noise.
- **`@all-models` for a round:** each raw member answers once, in parallel,
  then waits. That covers comparing answers without making it the default.
- **No model-to-model loops:** a model's reply never triggers another model
  unless a person or a workflow step asks for it. A debate is a workflow
  (like `examples/model-team`), not something that happens on its own.

### What it sees

- The last N messages of the thread, capped in tokens, plus the group's
  description and the member's role prompt ("you're the skeptic",
  "summarize what was decided"). Nothing else in the group.
- What it sees goes to the model's provider. The roster says so ("sends
  messages to Anthropic"), so a group's members know before it's added and
  can refuse it. That matters to the people pai attracts.

### Open questions

- **Streaming over the group log:** write partial replies, or only the final
  one? Probably only the final one, with "typing…" as a live signal that's
  never written.
- **Spend caps:** a per-member limit (tokens a day, say) in its config, so a
  busy group can't run up the bill of the person who added it.
- **Jobs:** should raw members take text-only jobs from the board (a
  "summarize" step in a workflow)? Probably yes, which would make them cheap
  workers too.
- **Chat and the job board:** is a chat message its own op in the group's
  log, or is a mention to an agent just a job with a thread attached? Reusing
  jobs gets leases, retries and the inbox for free. A separate op keeps chat
  light.
- **Whose identity:** a raw member needs its own identity to be a member, but
  the phone today is a device of its person's identity (`pai device invite`).
  Either the hosting device holds a second identity for each raw member, or a
  raw member is a role that the person's own identity answers as.
