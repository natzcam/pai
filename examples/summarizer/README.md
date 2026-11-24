# Summarizer: call an agent on another machine

A **summarizer** agent runs on one machine (say, a home server with a GPU).
A **research** agent on another machine (your laptop) sends it articles and
streams back the summaries. No ports to open, no VPN, no API server: the two
find each other over Holepunch by agent id, even behind home routers.

`summarize.sh` is a stand-in that returns the first three sentences, so the
example runs anywhere. Swap its body for a real model, for example
`ollama run llama3 "Summarize in 3 bullets: $(cat)"`.

**Setup:** `pai` on both machines (see the main README's [Install](../../README.md#install)).

## 1. Run the summarizer (machine A)

```sh
cd examples/summarizer   # in the pai checkout
pai init --name summarizer --description "Summarizes text in 3 bullets"
pai daemon --exec ./summarize.sh
# summarizer is listening
# id: f1a421dd…            <- the agent's address: copy it to machine B
# gateway: http://127.0.0.1:7777/agents/<id> (bearer token in .pai/daemon-token)

# in another terminal, in examples/summarizer
pai group invite           # a one-use code: copy it to machine B too
```

`pai init` wrote `pai.json`, made the agent's identity and a group of its
own (`summarizer`, with it as the admin), and keeps their keys in
`.pai/groups.json`: only members of the group can connect. The invite lets
one more agent in; the daemon has to be running when it's used.

## 2. Call it (machine B)

Every call goes through a daemon of your own, so B runs one too:

```sh
cd examples/summarizer && mkdir research && cd research
pai init --name research --join "<the code from machine A>"
pai daemon                 # calls only; leave it running in its own terminal

# in another terminal, in research/
pai send <id> --stream < path/to/article.txt
# • Holepunch is a peer-to-peer platform.
# • It connects devices directly, even behind home routers.
# • No servers sit in the middle!

pai card <id>              # what the agent says it can do
```

Ctrl-C during `--stream` cancels the job on the summarizer. To try it all on
one machine, use two folders instead of two machines, and give the second
daemon its own gateway port: `pai daemon --listen 127.0.0.1:7778` (and
`--gateway http://127.0.0.1:7778` for `sdk-client.mjs`).

## 3. Call it from code, or from any A2A SDK (machine B)

- **With the library:** [`research.mjs`](./research.mjs)
  connects as its own agent, with no daemon. It joins the summarizer's group
  the first time, with an invite of its own (another `pai group invite` on
  machine A), and keeps its keys in `.pai-research/keys.json` after that. In
  `examples/summarizer`: `PAI_INVITE="<code>" node research.mjs <id>
  article.txt`, then just `node research.mjs <id> article.txt`. See
  [Use as a library](../../README.md#use-as-a-library).
- **With an A2A SDK:** [`sdk-client.mjs`](./sdk-client.mjs)
  uses the official A2A JS SDK through B's daemon from step 2:
  `node ../sdk-client.mjs <id> ../article.txt`, run in `research/`. Python,
  Go or Java SDKs work the same. See
  [Use pai from any A2A client](../../README.md#use-pai-from-any-a2a-client).

## Files

| File | What it is |
| --- | --- |
| `summarize.sh` | The agent's work, run per message by `pai daemon --exec ./summarize.sh`: the text comes in on stdin, the summary goes out on stdout. A stand-in that returns the first three sentences; swap in a real model, e.g. `ollama run llama3 "Summarize in 3 bullets: $(cat)"`. |
| `article.txt` | A sample article to send. |
| `research.mjs` | Calls the summarizer from code with the pai library, as its own agent: `PAI_INVITE="<code>" node research.mjs <id> article.txt` the first time |
| `sdk-client.mjs` | Calls it with the official A2A JS SDK, through a running `pai daemon`: `node ../sdk-client.mjs <id> ../article.txt` from that daemon's folder. |

Any language works for the agent: `--exec` runs any command, with the
request's text on stdin (or the whole A2A message as JSON with
`--exec-json`) and `PAI_TASK_ID`, `PAI_CONTEXT_ID` and `PAI_MESSAGE_ID` set.
Exit 0 completes the task; any other exit fails it with the end of stderr.
