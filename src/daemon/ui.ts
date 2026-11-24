// The daemon's web page (pai ui): the inbox of every group, and one
// group's job board, workflows and roster (picked at the top, and kept in
// the URL), from the gateway's own endpoints. Plain HTML and script, no
// build step; served at /ui with a fresh nonce in place of __NONCE__ (see
// gateway.ts). Board text is other members': the script builds elements,
// never HTML from strings.

export function uiPage (nonce: string): string {
  return PAGE.replaceAll('__NONCE__', nonce)
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pai</title>
<style nonce="__NONCE__">
/* Layout: a top bar with the agent and tabs; one column of sections per tab, cards for things to act on, rows for lists. */
:root {
  --bg: #f4f6f9; --panel: #ffffff; --line: #dde2ea; --fg: #18202d; --muted: #5d6879;
  --accent: #2f56c9; --accent-fg: #ffffff; --soft: #e6ecfb;
  --open: #9a5b00; --open-soft: #fdf1dc; --claimed: #2f56c9; --claimed-soft: #e6ecfb;
  --done: #1d7a4a; --done-soft: #e1f3e8; --bad: #b3372b; --bad-soft: #fbe5e2; --skip: #6b7280; --skip-soft: #eef0f3;
  --body: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #11151c; --panel: #181e27; --line: #2a3340; --fg: #e4e9f1; --muted: #93a0b3;
    --accent: #7d9cf5; --accent-fg: #0d1220; --soft: #1f2a45;
    --open: #f0b04a; --open-soft: #3a2c14; --claimed: #7d9cf5; --claimed-soft: #1f2a45;
    --done: #5cc98e; --done-soft: #15301f; --bad: #f08074; --bad-soft: #3a1c19; --skip: #9aa3b2; --skip-soft: #232a35;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 var(--body); }
header { position: sticky; top: 0; z-index: 2; background: var(--panel); border-bottom: 1px solid var(--line); }
.bar { max-width: 1040px; margin: 0 auto; padding: 10px 16px 0; display: grid; gap: 8px; }
.who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.who b { font-size: 16px; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--muted); }
nav { display: flex; gap: 4px; overflow-x: auto; }
nav button { font: inherit; font-weight: 500; background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted); padding: 8px 10px; cursor: pointer; white-space: nowrap; }
nav button[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
nav .count { display: inline-block; min-width: 18px; padding: 0 5px; margin-left: 4px; border-radius: 9px; background: var(--accent); color: var(--accent-fg); font-size: 11px; text-align: center; }
main { max-width: 1040px; margin: 0 auto; padding: 16px; display: grid; gap: 20px; }
section { display: grid; gap: 10px; }
h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; display: grid; gap: 8px; min-width: 0; }
.rows { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.row { display: grid; grid-template-columns: 92px 84px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 12px; border-top: 1px solid var(--line); cursor: pointer; }
.row:first-child { border-top: 0; }
.row:hover { background: var(--soft); }
.row .text, .row .cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.row .cell { max-width: 160px; }
.detail { padding: 10px 14px 14px; border-top: 1px dashed var(--line); background: var(--bg); display: grid; gap: 8px; cursor: auto; }
@media (max-width: 640px) { .row { grid-template-columns: 84px minmax(0, 1fr); } .row .hide-sm { display: none; } }
.pill { display: inline-block; font-size: 11.5px; font-weight: 600; padding: 1px 8px; border-radius: 999px; text-align: center; }
.s-open { background: var(--open-soft); color: var(--open); }
.s-claimed, .s-running, .s-waiting { background: var(--claimed-soft); color: var(--claimed); }
.s-done { background: var(--done-soft); color: var(--done); }
.s-failed, .s-canceled { background: var(--bad-soft); color: var(--bad); }
.s-skipped, .s-pending { background: var(--skip-soft); color: var(--skip); }
.ask { background: var(--open-soft); color: var(--open); }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.5 var(--mono); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; max-height: 320px; overflow: auto; }
.detail pre { background: var(--panel); }
label { display: grid; gap: 4px; font-size: 12.5px; color: var(--muted); }
textarea, input { font: inherit; color: var(--fg); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; width: 100%; }
textarea { min-height: 64px; resize: vertical; }
textarea.code { font: 12.5px/1.5 var(--mono); min-height: 160px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
button.b { font: inherit; font-weight: 500; border-radius: 6px; padding: 6px 12px; cursor: pointer; border: 1px solid var(--line); background: var(--panel); color: var(--fg); }
button.b.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button.b.danger { color: var(--bad); }
button.b:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chips button { font: inherit; font-size: 12.5px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); border-radius: 999px; padding: 3px 10px; cursor: pointer; }
.chips button[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 640px) { .grid2 { grid-template-columns: 1fr; } }
.empty { color: var(--muted); padding: 14px; text-align: center; background: var(--panel); border: 1px dashed var(--line); border-radius: 8px; }
.steps { display: grid; gap: 6px; }
.step { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; align-items: start; padding: 8px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.step .meta { font-size: 12.5px; color: var(--muted); }
.err { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); background: var(--bad); color: #fff; padding: 8px 14px; border-radius: 8px; max-width: calc(100% - 32px); z-index: 5; }
.ok { background: var(--done); }
table { width: 100%; border-collapse: collapse; }
td, th { text-align: left; padding: 7px 10px; border-top: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; border-top: 0; }
.scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.gate { max-width: 520px; margin: 15vh auto; padding: 0 16px; display: grid; gap: 10px; }
</style>
</head>
<body>
<div id="app"></div>
<script nonce="__NONCE__">
'use strict'
const TOKEN_KEY = 'pai-token'
const S = { token: null, me: null, group: null, groups: [], tab: 'inbox', filter: 'all', open: {}, drafts: {}, data: {}, busy: {}, flow: null, seq: 0, loading: false, dirty: false, pressing: false }

// The token comes in the link's hash (never sent to a server), then lives
// in this tab's session.
;(function takeToken () {
  const m = /(?:^|[#&])token=([^&]+)/.exec(location.hash)
  if (m) {
    let token = null
    try { token = decodeURIComponent(m[1]) } catch (e) {} // a cut-off link
    if (token) {
      try { sessionStorage.setItem(TOKEN_KEY, token) } catch (e) {}
      S.token = token
    }
    history.replaceState(null, '', location.pathname + location.search)
  }
  if (!S.token) {
    try { S.token = sessionStorage.getItem(TOKEN_KEY) } catch (e) {}
  }
})()

// Elements, built without HTML strings: board text is other members'.
function h (tag, attrs, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return el
}

// The group shown (?group= in the page's URL; else the daemon's default).
try { S.group = new URLSearchParams(location.search).get('group') } catch (e) {}

// A group route for \`group\` (an inbox item's), or the group shown.
function inGroup (path, group) {
  const name = group || S.group
  return name ? path + (path.includes('?') ? '&' : '?') + 'group=' + encodeURIComponent(name) : path
}

function pickGroup (name) {
  S.group = name
  S.data = {}
  S.flow = null
  history.replaceState(null, '', location.pathname + '?group=' + encodeURIComponent(name))
  render()
  refresh()
}

async function api (path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + S.token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  })
  let json = {}
  try { json = await res.json() } catch (e) {}
  if (res.status === 401) { S.token = null; try { sessionStorage.removeItem(TOKEN_KEY) } catch (e) {} ; render(); throw new Error('The token was refused: run pai ui again') }
  if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status))
  return json
}

let toastTimer = null
function toast (text, ok) {
  document.querySelectorAll('.err').forEach((e) => e.remove())
  const el = h('div', { class: 'err' + (ok ? ' ok' : ''), role: 'status' }, text)
  document.body.append(el)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), 4000)
}

// Runs an action with its button busy, then refreshes.
async function act (key, fn, done) {
  if (S.busy[key]) return
  S.busy[key] = true
  render()
  try {
    await fn()
    if (done) toast(done, true)
  } catch (e) {
    toast(e.message)
  } finally {
    delete S.busy[key]
    await refresh()
  }
}

const short = (id) => id ? id.slice(0, 8) + '…' : ''
function nameOf (id) {
  if (!id) return 'anyone'
  if (id.startsWith('role:')) return id
  const m = S.me && S.me.roster.members.find((x) => x.id === id)
  return (m && m.name) ? m.name : short(id)
}
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return s + ' s ago'
  if (s < 3600) return Math.round(s / 60) + ' min ago'
  if (s < 86400) return Math.round(s / 3600) + ' h ago'
  return new Date(t).toLocaleDateString()
}
const isAdmin = () => S.me && S.me.admin
// An inbox item's group, when there's more than one to tell apart.
const groupTag = (x) => S.groups.length > 1 && x.group ? h('span', { class: 'pill' }, x.group) : null
const asking = (j) => j.state === 'claimed' && j.question && j.question.answer === null

// A section that stays open (or shut) across refreshes.
function more (key, summary, ...content) {
  const el = h('details', { open: !!S.open['d:' + key] }, h('summary', { class: 'muted' }, summary), ...content)
  el.addEventListener('toggle', () => { S.open['d:' + key] = el.open })
  return el
}

// A text box whose draft survives refreshes.
function box (id, attrs) {
  const el = h(attrs && attrs.input ? 'input' : 'textarea', Object.assign({ id, class: attrs && attrs.code ? 'code' : null, placeholder: attrs && attrs.placeholder, oninput: (e) => { S.drafts[id] = e.target.value } }, {}))
  el.value = S.drafts[id] || ''
  return el
}
const draft = (id) => (S.drafts[id] || '').trim()
const clear = (...ids) => ids.forEach((id) => delete S.drafts[id])
function btn (label, key, onclick, kind) {
  return h('button', { class: 'b' + (kind ? ' ' + kind : ''), disabled: !!S.busy[key], onclick }, S.busy[key] ? label + '…' : label)
}

// ---- data ----

// Reads what the current tab shows, all at once. Only the latest refresh
// counts (an older one finishing late is dropped); a poll skips its turn
// while one is under way. \`poll\`: from the timer, so it doesn't redraw
// under someone's hands (see render).
async function refresh (poll) {
  if (!S.token) return render()
  if (poll && S.loading) return
  const n = ++S.seq
  S.loading = true
  const tab = S.tab
  const flow = S.flow
  const [me, inbox, jobs, flows, one, groups] = await Promise.allSettled([
    api(inGroup('/pai/group')),
    api('/pai/inbox'),
    tab === 'board' ? api(inGroup('/pai/jobs')) : null,
    tab === 'flows' ? api(inGroup('/pai/flows')) : null,
    tab === 'flows' && flow ? api(inGroup('/pai/flows/' + flow)) : null,
    api('/pai/groups')
  ])
  if (n !== S.seq) return
  S.loading = false
  // The group read failing means the daemon is gone; others fail alone.
  S.error = me.status === 'rejected' ? me.reason.message : null
  if (me.status === 'fulfilled') S.me = me.value
  if (groups.status === 'fulfilled') S.groups = groups.value.groups
  if (inbox.status === 'fulfilled') S.data.inbox = inbox.value
  if (jobs.status === 'fulfilled' && jobs.value) S.data.jobs = jobs.value.jobs
  if (flows.status === 'fulfilled' && flows.value) S.data.flows = flows.value.flows
  if (flow && S.flow === flow) {
    if (one.status === 'fulfilled' && one.value) S.data.flow = one.value.flow
    else if (one.status === 'rejected' && me.status === 'fulfilled') { S.flow = null; S.data.flow = null; toast('That workflow is gone: ' + one.reason.message) }
  }
  render(!poll)
}

// ---- views ----

function jobText (j) {
  const meta = [
    j.spec.context ? 'thread ' + j.spec.context : '',
    j.spec.attach ? 'attaches the result' + (j.spec.attach.length > 1 ? 's' : '') + ' of ' + j.spec.attach.map(short).join(', ') : ''
  ].filter(Boolean).join(' · ')
  return [h('pre', {}, j.spec.text), meta ? h('div', { class: 'muted' }, meta) : null]
}

// The box and button that answer a job's question.
function answerForm (j) {
  const key = 'ans-' + j.id
  return [box(key, { placeholder: 'Your answer' }), h('div', { class: 'actions' }, btn('Answer', key, () => {
    const text = draft(key)
    if (!text) return toast('Write an answer first')
    act(key, async () => { await api(inGroup('/pai/jobs', j.group), { action: 'answer', id: j.id, text }); clear(key) }, 'Answered')
  }, 'primary'))]
}

function inboxView () {
  const box_ = S.data.inbox
  if (!box_) return h('div', { class: 'empty' }, 'Loading…')
  const parts = []
  if (box_.questions.length) {
    parts.push(h('section', {}, h('h2', {}, 'Questions for you'), box_.questions.map((j) => h('div', { class: 'card' },
      h('div', { class: 'muted' }, groupTag(j), 'Job ', h('span', { class: 'mono' }, short(j.id)), ', run by ', nameOf(j.claim && j.claim.by), ', asks:'),
      h('pre', {}, j.question.text),
      more('qjob-' + j.id, 'The job', jobText(j)),
      answerForm(j)
    ))))
  }
  if (box_.held.length) {
    parts.push(h('section', {}, h('h2', {}, 'Jobs you hold'), box_.held.map((j) => h('div', { class: 'card' },
      h('div', { class: 'muted' }, groupTag(j), 'From ', nameOf(j.by), ' · ', h('span', { class: 'mono' }, short(j.id)), j.lease ? ' · lease renewed by this daemon' : ''),
      S.data.inbox.inputs && S.data.inbox.inputs[j.id] ? [h('pre', {}, S.data.inbox.inputs[j.id]), jobText(j)[1]] : jobText(j),
      box('res-' + j.id, { placeholder: 'The result (for done) or why (for fail)' }),
      h('div', { class: 'actions' },
        btn('Done', 'done-' + j.id, () => act('done-' + j.id, async () => { await api(inGroup('/pai/jobs', j.group), { action: 'finish', id: j.id, state: 'done', text: draft('res-' + j.id) || null }); clear('res-' + j.id) }, 'Reported done'), 'primary'),
        btn('Fail', 'fail-' + j.id, () => act('fail-' + j.id, async () => { await api(inGroup('/pai/jobs', j.group), { action: 'finish', id: j.id, state: 'failed', text: draft('res-' + j.id) || null }); clear('res-' + j.id) }, 'Reported failed'), 'danger'),
        btn('Give back', 'rel-' + j.id, () => act('rel-' + j.id, () => api(inGroup('/pai/jobs', j.group), { action: 'release', id: j.id }), 'Given back'))
      )
    ))))
  }
  if (box_.open.length) {
    parts.push(h('section', {}, h('h2', {}, 'Jobs you may take'), h('div', { class: 'rows' }, box_.open.map((j) => h('div', { class: 'row', onclick: null },
      groupTag(j),
      h('span', { class: 'mono' }, short(j.id)),
      h('span', { class: 'muted hide-sm cell' }, nameOf(j.to)),
      h('span', { class: 'text', title: j.spec.text }, j.spec.text),
      btn('Take', 'take-' + j.id, (e) => { e.stopPropagation(); act('take-' + j.id, async () => {
        const r = await api(inGroup('/pai/jobs', j.group), { action: 'take', id: j.id })
        if (!r.mine) throw new Error('Another worker took it first')
      }, 'It’s yours: see Jobs you hold') })
    )))))
  }
  if (box_.proposals.length) {
    const k = S.me.roster.quorum.k
    parts.push(h('section', {}, h('h2', {}, 'Proposals to approve'), box_.proposals.map((p) => h('div', { class: 'card' },
      h('div', {}, groupTag(p), h('b', {}, describeOp(p.op)), h('span', { class: 'muted' }, ' · proposed by ', nameOf(p.by), ' ', ago(p.at), ' · ', p.group === S.me.group.name ? p.approvals.length + ' of ' + k + ' approvals' : p.approvals.length + ' approved')),
      h('div', { class: 'actions' }, btn('Approve', 'ap-' + p.pid, () => act('ap-' + p.pid, () => api(inGroup('/pai/group', p.group), { action: 'approve', pid: p.pid }), 'Approved'), 'primary'))
    ))))
  }
  if (!parts.length) parts.push(h('div', { class: 'empty' }, 'Nothing is waiting on you. Questions on your jobs, jobs for your roles and proposals to approve show up here.'))
  return parts
}

function describeOp (op) {
  if (op.type === 'admin.add') return 'Make ' + nameOf(op.id) + ' an admin'
  if (op.type === 'admin.remove') return 'Remove ' + nameOf(op.id) + ' as admin'
  if (op.type === 'quorum.set') return 'Set the quorum to ' + op.k
  if (op.type === 'seed.rotate') return 'Rotate the group seed'
  return op.type
}

function stateOf (j) { return asking(j) ? 'waiting' : j.state }

function jobDetail (j) {
  const mine = S.me && j.by === S.me.id
  const can = (mine || isAdmin())
  return h('div', { class: 'detail', onclick: (e) => e.stopPropagation() },
    h('div', { class: 'muted' }, 'Posted by ', nameOf(j.by), ' ', ago(j.at), ' for ', nameOf(j.to), j.lease ? ' · lease ' + Math.round(j.lease / 1000) + ' s' : '', j.flow ? ' · step ' + j.flow.step + (j.flow.item !== undefined ? ' (item ' + (j.flow.item + 1) + ')' : '') + ' of workflow ' + short(j.flow.id) : ''),
    jobText(j),
    j.claim ? h('div', { class: 'muted' }, (j.state === 'claimed' ? 'Claimed by ' : 'Run by ') + nameOf(j.claim.by), j.claim.hand ? ' (by hand)' : '', ' ', ago(j.claim.at)) : null,
    j.question ? h('div', {}, h('div', { class: 'muted' }, 'Question ' + j.question.n + (j.question.answer !== null ? ', answered by ' + nameOf(j.question.by) : ', waiting for an answer')), h('pre', {}, j.question.text), j.question.answer !== null ? h('pre', {}, j.question.answer) : null) : null,
    asking(j) && can ? answerForm(j) : null,
    j.retries != null || j.due != null || j.timeout != null ? h('div', { class: 'muted' }, [
      j.retries != null ? 'attempt ' + (j.attempt || 0) + ' of ' + (j.retries + 1) : '',
      j.state === 'open' && j.notBefore ? 'next try ' + new Date(j.notBefore).toLocaleTimeString() : '',
      j.due != null ? 'due ' + new Date(j.due).toLocaleString() : '',
      j.timeout != null ? Math.round(j.timeout / 1000) + ' s per attempt' : ''
    ].filter(Boolean).join(' · ')) : null,
    j.lastError && j.state !== 'done' ? h('div', {}, h('div', { class: 'muted' }, 'Last attempt'), h('pre', {}, j.lastError)) : null,
    j.result !== null ? h('div', {}, h('div', { class: 'muted' }, j.state === 'done' ? 'Result' : 'Why'), h('pre', {}, j.result)) : null,
    j.ref ? h('div', { class: 'muted' }, 'Task: ', h('span', { class: 'mono' }, 'pai task get ' + (j.claim ? j.claim.by : '') + ' ' + j.ref)) : null,
    h('div', { class: 'actions' },
      h('span', { class: 'mono muted' }, j.id),
      can && (j.state === 'open' || j.state === 'claimed') && !j.flow ? btn('Cancel job', 'cancel-' + j.id, () => act('cancel-' + j.id, () => api(inGroup('/pai/jobs', j.group), { action: 'cancel', id: j.id }), 'Canceled'), 'danger') : null
    )
  )
}

function boardView () {
  const jobs = S.data.jobs
  const filters = ['all', 'open', 'claimed', 'waiting', 'done', 'failed', 'canceled']
  const shown = (jobs || []).filter((j) => S.filter === 'all' || stateOf(j) === S.filter || (S.filter === 'claimed' && j.state === 'claimed'))
  return [
    h('section', {},
      h('h2', {}, 'Post a job'),
      h('div', { class: 'card' },
        box('post-text', { placeholder: 'What to do' }),
        h('div', { class: 'grid2' },
          h('label', {}, 'For (role:<role>, an agent id, or empty for anyone)', box('post-to', { input: true, placeholder: 'role:writer' })),
          h('label', {}, 'Lease in seconds (empty: none)', box('post-lease', { input: true, placeholder: '60' }))
        ),
        more('post-more', 'Limits, attachments, thread',
          h('div', { class: 'grid2' },
            h('label', {}, 'Max time per attempt, seconds', box('post-timeout', { input: true, placeholder: '300' })),
            h('label', {}, 'Deadline from now, seconds', box('post-deadline', { input: true, placeholder: '3600' })),
            h('label', {}, 'Retries', box('post-retries', { input: true, placeholder: '2' })),
            h('label', {}, 'Backoff before a retry, seconds', box('post-backoff', { input: true, placeholder: '30' })),
            h('label', {}, 'Attach the results of jobs (ids, comma separated)', box('post-attach', { input: true, placeholder: 'job id' })),
            h('label', {}, 'Thread (jobs you give one name share a conversation)', box('post-thread', { input: true, placeholder: 'essay-1' }))
          )
        ),
        h('div', { class: 'actions' }, btn('Post', 'post', () => {
          const text = draft('post-text')
          if (!text) return toast('Write what to do first')
          const to = draft('post-to')
          const lease = draft('post-lease')
          const body = { action: 'post', spec: { text } }
          if (to) body.to = to
          const secs = (id, name, min) => {
            const v = draft(id)
            if (!v) return undefined
            const n = Number(v)
            if (!Number.isFinite(n) || n < min) throw new Error(name + ' is a number of seconds' + (min ? ', at least ' + min : ''))
            return Math.round(n * 1000)
          }
          try {
            const limits = { timeout: secs('post-timeout', 'Max time', 5), deadline: secs('post-deadline', 'The deadline', 1), backoff: secs('post-backoff', 'The backoff', 0) }
            for (const k in limits) if (limits[k] !== undefined) body[k] = limits[k]
          } catch (err) { return toast(err.message) }
          const retries = draft('post-retries')
          if (retries) {
            if (!/^\\d+$/.test(retries)) return toast('Retries is a whole number')
            body.retries = Number(retries)
          }
          const attach = draft('post-attach').split(/[\\s,]+/).filter(Boolean)
          if (attach.length) body.spec.attach = attach
          const thread = draft('post-thread')
          if (thread) body.spec.context = thread
          if (lease) {
            const seconds = Number(lease)
            if (!Number.isFinite(seconds) || seconds < 5) return toast('The lease is a number of seconds, at least 5')
            body.lease = Math.round(seconds * 1000)
          }
          act('post', async () => { await api(inGroup('/pai/jobs'), body); for (const id of ['post-text', 'post-timeout', 'post-deadline', 'post-retries', 'post-backoff', 'post-attach', 'post-thread']) clear(id) }, 'Posted')
        }, 'primary'))
      )
    ),
    h('section', {},
      h('h2', {}, 'The board'),
      h('div', { class: 'chips' }, filters.map((f) => h('button', { 'aria-pressed': String(S.filter === f), onclick: () => { S.filter = f; render() } }, f))),
      !jobs ? h('div', { class: 'empty' }, 'Loading…')
        : shown.length === 0 ? h('div', { class: 'empty' }, S.filter === 'all' ? 'No jobs yet. Post one above, or start a workflow.' : 'No ' + S.filter + ' jobs.')
          : h('div', { class: 'rows' }, shown.map((j) => [
            h('div', { class: 'row', onclick: () => { S.open[j.id] = !S.open[j.id]; render() }, 'aria-expanded': String(!!S.open[j.id]) },
              h('span', { class: 'pill s-' + stateOf(j) }, stateOf(j)),
              h('span', { class: 'mono hide-sm' }, short(j.id)),
              h('span', { class: 'text', title: j.spec.text }, j.spec.text),
              h('span', { class: 'muted hide-sm cell' }, j.claim ? nameOf(j.claim.by) : nameOf(j.to))
            ),
            S.open[j.id] ? jobDetail(j) : null
          ]))
    )
  ]
}

const STEP_STATES = (f, s) => f.done.includes(s.name) ? 'done' : f.skipped.includes(s.name) ? 'skipped' : f.failed.includes(s.name) ? 'failed' : Object.prototype.hasOwnProperty.call(f.jobs, s.name) ? (f.state === 'running' ? 'running' : 'canceled') : 'pending'

function cond (c) {
  if (!c) return null
  const test = c.failed ? 'failed' : c.equals !== undefined ? '= "' + c.equals + '"' : 'contains "' + c.contains + '"'
  return 'if ' + c.step + (c.not ? ' not ' : ' ') + test
}

function flowDetail (f) {
  const can = S.me && (f.by === S.me.id || isAdmin())
  return h('div', { class: 'card' },
    h('div', { class: 'actions' }, h('b', {}, f.name || 'Workflow'), h('span', { class: 'pill s-' + f.state }, f.state), h('span', { class: 'muted' }, 'started by ', nameOf(f.by), ' ', ago(f.at)),
      can && f.state === 'running' ? btn('Cancel workflow', 'fc-' + f.id, () => act('fc-' + f.id, () => api(inGroup('/pai/flows'), { action: 'cancel', id: f.id }), 'Canceled'), 'danger') : null),
    more('fin-' + f.id, 'Input', h('pre', {}, f.input || '(none)')),
    h('div', { class: 'steps' }, f.steps.map((s) => {
      const st = STEP_STATES(f, s)
      const result = Object.prototype.hasOwnProperty.call(f.results, s.name) ? f.results[s.name] : null
      return h('div', { class: 'step' },
        h('span', { class: 'pill s-' + st }, st),
        h('div', {},
          h('div', {}, h('b', {}, s.name), h('span', { class: 'muted' }, ' · ', s.flow ? 'a workflow' + (Object.prototype.hasOwnProperty.call(f.jobs, s.name) ? ' (' + short(f.jobs[s.name]) + ')' : '') : s.to || 'anyone')),
          h('div', { class: 'meta' }, s.after && s.after.length ? 'after ' + s.after.join(', ') : 'at once', s.if ? ' · ' + cond(s.if) : '', s.map ? ' · for each item of ' + s.map : '', s.copies ? ' · ' + s.copies + ' copies' : '', s.settle && s.settle !== 'all' ? ' · ' + (s.settle === 'first' ? 'first done wins' : s.settle.agree + ' must agree') : '', f.items && f.items[s.name] ? ' (' + f.items[s.name].done + ' of ' + f.items[s.name].n + ' done)' : '', s.repeat ? ' · repeats from ' + s.repeat.from + ' ' + (cond(s.repeat.until) || '').replace(/^if/, 'until') + ' (round ' + (((f.loops && f.loops[s.name]) ? f.loops[s.name].round : 0) + 1) + ' of up to ' + s.repeat.max + ')' : '', f.cut.includes(s.name) ? ' · text cut to fit' : ''),
          result !== null ? more('fres-' + f.id + '-' + s.name, 'Result', h('pre', {}, result)) : null
        )
      )
    })),
    f.output !== null ? h('div', {}, h('div', { class: 'muted' }, f.state === 'done' ? 'Output' : 'Why it stopped'), h('pre', {}, f.output)) : null
  )
}

const SAMPLE = JSON.stringify({ name: 'draft-and-approve', steps: [
  { name: 'draft', to: 'role:writer', text: 'Write a short explanation of: {{input}}' },
  { name: 'approve', to: 'role:approver', after: ['draft'], text: 'Approve this? Reply "approved", or say what to change.\\n\\n{{steps.draft}}' },
  { name: 'publish', to: 'role:editor', after: ['draft', 'approve'], if: { step: 'approve', equals: 'approved' }, text: 'Polish for publishing:\\n\\n{{steps.draft}}' },
  { name: 'revise', to: 'role:writer', after: ['draft', 'approve'], if: { step: 'approve', equals: 'approved', not: true }, text: 'Revise:\\n{{steps.draft}}\\n\\nWhat to change:\\n{{steps.approve}}' }
] }, null, 2)

function flowsView () {
  const flows = S.data.flows
  return [
    S.flow && S.data.flow ? h('section', {}, h('div', { class: 'actions' }, h('h2', {}, 'Workflow ' + short(S.flow)), h('button', { class: 'b', onclick: () => { S.flow = null; S.data.flow = null; render() } }, 'Back to the list')), flowDetail(S.data.flow)) : null,
    h('section', {},
      h('h2', {}, 'Workflows'),
      !flows ? h('div', { class: 'empty' }, 'Loading…')
        : flows.length === 0 ? h('div', { class: 'empty' }, 'No workflows yet. Start one below.')
          : h('div', { class: 'rows' }, flows.map((f) => h('div', { class: 'row', onclick: () => { S.flow = f.id; refresh() } },
            h('span', { class: 'pill s-' + f.state }, f.state),
            h('span', { class: 'mono hide-sm' }, short(f.id)),
            h('span', { class: 'text' }, f.name || '(unnamed)'),
            h('span', { class: 'muted hide-sm' }, f.done + '/' + f.steps + ' steps' + (f.skipped ? ', ' + f.skipped + ' skipped' : '') + (f.failed ? ', ' + f.failed + ' failed on a branch' : '') + ' · ' + ago(f.updated))
          )))
    ),
    h('section', {},
      h('h2', {}, 'Start a workflow'),
      h('div', { class: 'card' },
        h('label', {}, 'Steps (JSON, as for pai flow start)', (() => { if (S.drafts['flow-spec'] === undefined) S.drafts['flow-spec'] = SAMPLE; return box('flow-spec', { code: true }) })()),
        h('label', {}, 'Input', box('flow-input', { placeholder: 'What {{input}} stands for' })),
        h('div', { class: 'actions' }, btn('Start', 'flow-start', () => {
          let spec
          try { spec = JSON.parse(S.drafts['flow-spec'] || '') } catch (e) { return toast('The steps aren’t valid JSON: ' + e.message) }
          act('flow-start', async () => {
            const r = await api(inGroup('/pai/flows'), { action: 'start', spec, input: S.drafts['flow-input'] || '' })
            S.flow = r.flow.id
            clear('flow-input')
          }, 'Started')
        }, 'primary'))
      )
    )
  ]
}

function groupView () {
  const r = S.me.roster
  // Lapsed by the group's clock too, as the group's rules judge it.
  const until = (m) => m.until === null ? 'no end' : (m.until > Math.max(Date.now(), r.clock || 0) ? 'until ' : 'lapsed ') + new Date(m.until).toLocaleDateString()
  return [
    h('section', {}, h('h2', {}, 'Members'), h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Id'), h('th', {}, 'Roles'), h('th', {}, 'Membership'), h('th', {}, 'Devices'))),
      h('tbody', {}, r.members.map((m) => h('tr', {},
        h('td', {}, m.name || '', m.id === S.me.id ? h('span', { class: 'muted' }, ' (you)') : null),
        h('td', { class: 'mono' }, short(m.id)),
        h('td', {}, (r.admins.includes(m.id) ? ['admin'] : []).concat(m.roles).join(', ')),
        h('td', { class: 'muted' }, r.admins.includes(m.id) ? 'admin' : until(m)),
        h('td', { class: 'muted' }, Object.keys(m.devices || {}).length)
      )))
    ))),
    h('section', {}, h('h2', {}, 'Who may call whom'),
      r.policy.length === 0 ? h('div', { class: 'empty' }, 'No rules: every member may call every other, and post jobs for anyone.')
        : h('div', { class: 'scroll' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Rule'), h('th', {}, 'From'), h('th', {}, 'To'), h('th', {}, ''))),
          h('tbody', {}, r.policy.map((p) => h('tr', {}, h('td', {}, p.name), h('td', {}, p.from === '*' ? '*' : nameOf(p.from)), h('td', {}, p.to === '*' ? '*' : nameOf(p.to)), h('td', {}, h('span', { class: 'pill ' + (p.allow ? 's-done' : 's-failed') }, p.allow ? 'allow' : 'deny')))))
        ))
    ),
    h('section', {}, h('h2', {}, 'Group'), h('div', { class: 'card' },
      h('div', {}, 'Admins: ', r.admins.map(nameOf).join(', '), ' · approvals needed: ', String(r.quorum.k)),
      h('div', { class: 'muted' }, 'Seed epoch ' + r.seed.epoch + (r.proposals.length ? ' · ' + r.proposals.length + ' open proposal(s)' : '')),
      h('div', { class: 'muted' }, 'This device: ', h('span', { class: 'mono' }, S.me.device))
    ))
  ]
}

function gate () {
  return h('div', { class: 'gate' },
    h('h1', {}, 'pai'),
    h('p', {}, 'Open this page with the link ', h('span', { class: 'mono' }, 'pai ui'), ' prints: it carries the daemon’s token.'),
    S.error ? h('p', { class: 'muted' }, S.error) : null
  )
}

// Whether a redraw now would get in someone's way: typing in a field, a
// button half-clicked, or text selected. A poll's redraw waits for them.
function busyHands () {
  const a = document.activeElement
  if (a && /^(TEXTAREA|INPUT)$/.test(a.tagName)) return true
  if (S.pressing) return true
  const picked = window.getSelection && window.getSelection()
  return !!(picked && !picked.isCollapsed)
}

function render (force) {
  const app = document.getElementById('app')
  if (force === false && busyHands()) { S.dirty = true; return }
  S.dirty = false
  const focus = document.activeElement && document.activeElement.id
  const sel = focus && document.activeElement.selectionStart
  if (!S.token || !S.me) return app.replaceChildren(gate())
  // Built aside first: an error in a view shows as a message, not a blank page.
  let view
  try { view = page() } catch (e) { view = h('main', {}, h('div', { class: 'empty' }, 'This view failed to draw: ' + e.message)) }
  app.replaceChildren(...[].concat(view))
  if (focus) {
    const el = document.getElementById(focus)
    if (el) { el.focus(); try { if (sel !== null && sel !== undefined) el.setSelectionRange(sel, sel) } catch (e) {} }
  }
}

// Which of the identity's groups the board, workflows and roster show.
function groupPicker () {
  if (S.groups.length < 2) return h('span', { class: 'muted' }, S.me.group.name)
  return h('select', { 'aria-label': 'Group', onchange: (e) => { pickGroup(e.target.value) } },
    S.groups.map((g) => h('option', { value: g.name, selected: g.name === S.me.group.name }, g.name)))
}

function page () {
  const inbox = S.data.inbox
  const waiting = inbox ? inbox.questions.length + inbox.held.length + inbox.proposals.length : 0
  const tabs = [['inbox', 'Inbox', waiting], ['board', 'Board'], ['flows', 'Workflows'], ['group', 'Group']]
  const me = S.me.roster.members.find((m) => m.id === S.me.id)
  return [
    h('header', {}, h('div', { class: 'bar' },
      h('div', { class: 'who' }, h('b', {}, (me && me.name) || 'pai'), h('span', { class: 'mono muted' }, short(S.me.id)), groupPicker(), S.me.admin ? h('span', { class: 'pill s-claimed' }, 'admin') : null, me && me.roles.length ? h('span', { class: 'muted' }, me.roles.join(', ')) : null, S.error ? h('span', { class: 'pill s-failed' }, 'offline: ' + S.error) : null),
      h('nav', { role: 'tablist' }, tabs.map(([id, label, n]) => h('button', { role: 'tab', 'aria-selected': String(S.tab === id), onclick: () => { S.tab = id; try { localStorage.setItem('pai-tab', id) } catch (e) {} ; render(); refresh() } }, label, n ? h('span', { class: 'count' }, n) : null)))
    )),
    h('main', {}, S.tab === 'inbox' ? inboxView() : S.tab === 'board' ? boardView() : S.tab === 'flows' ? flowsView() : groupView())
  ]
}

try { S.tab = localStorage.getItem('pai-tab') || 'inbox' } catch (e) {}
refresh()
// Live: every couple of seconds while the page is in view. A redraw held
// back for someone's hands happens once they're done.
setInterval(() => {
  if (document.visibilityState !== 'visible') return
  refresh(true)
}, 2500)
const later = () => setTimeout(() => { if (S.dirty && !busyHands()) render() }, 0)
document.addEventListener('pointerdown', () => { S.pressing = true }, true)
document.addEventListener('pointerup', () => { S.pressing = false; later() }, true)
document.addEventListener('focusout', later)
document.addEventListener('selectionchange', later)
</script>
</body>
</html>
`
