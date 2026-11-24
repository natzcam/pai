// The groups' boards as this person sees them: the jobs, and the workflows
// with their steps (each naming its group, when there's more than one).
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { pai } from './worklet'
import type { FlowSummary, FlowView, Job, JobState, Member } from './types'
import type { Names } from './Inbox'
import { Body, Button, Card, Chip, Empty, Field, Note, Row, Small, ago, useTheme } from './ui'
import type { Theme } from './ui'

function stateColor (t: Theme, state: JobState | FlowView['state']): string {
  return state === 'done' ? t.ok : state === 'failed' ? t.danger : state === 'canceled' ? t.muted : state === 'claimed' || state === 'running' ? t.warn : t.accent
}

function JobCard ({ job, names, me, after }: { job: Job, names: Names, me: string | null, after: () => void }): ReactNode {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelable = job.by === me && (job.state === 'open' || job.state === 'claimed')
  return (
    <Pressable onPress={() => { setOpen(!open) }} accessibilityRole='button' accessibilityLabel={`Job: ${job.spec.text.slice(0, 60)}`}>
      <Card>
        <Row>
          <Chip label={job.state} color={stateColor(t, job.state)} />
          {names.groups.length > 1 ? <Chip label={job.group} /> : null}
          <Chip label={names.target(job.to)} />
          <Small>{names.of(job.by)} · {ago(job.updated)}</Small>
        </Row>
        <Body lines={open ? undefined : 2}>{job.spec.text}</Body>
        {open && job.claim && <Small>{job.state === 'claimed' ? 'Held' : 'Was held'} by {names.of(job.claim.by)}{job.claim.hand ? ' (a person)' : ''}</Small>}
        {open && job.result !== null && <Note color={stateColor(t, job.state)}>{job.result}</Note>}
        {open && job.lastError && <Small color={t.danger}>Last attempt lost: {job.lastError}</Small>}
        {open && cancelable && <Button kind='danger' label='Cancel this job' busy={busy} onPress={() => { setBusy(true); setError(null); pai.cancel(job.id).then(after, (err: Error) => { setError(err.message) }).finally(() => { setBusy(false) }) }} />}
        {error !== null && <Note color={t.danger}>{error}</Note>}
      </Card>
    </Pressable>
  )
}

// Posts a job: for a role, a member, or anyone, in one of the groups.
function NewJob ({ members, names, after }: { members: Member[], names: Names, after: () => void }): ReactNode {
  const t = useTheme()
  const [text, setText] = useState('')
  const [to, setTo] = useState<string | null>(null)
  const [group, setGroup] = useState<string | null>(names.groups[0] ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const roles = [...new Set(members.flatMap((m) => m.roles))].sort().map((r) => `role:${r}`)
  const targets: Array<string | null> = [null, ...roles, ...members.map((m) => m.id)]
  return (
    <Card>
      <Field value={text} onChangeText={setText} placeholder='A new job: what should be done?' multiline accessibilityLabel='New job' />
      {names.groups.length > 1 && <Small>In</Small>}
      {names.groups.length > 1 && (
        <Row gap={6}>
          {names.groups.map((g) => <Button key={g} kind={group === g ? 'primary' : 'plain'} label={g} onPress={() => { setGroup(g) }} />)}
        </Row>
      )}
      <Small>For</Small>
      <Row gap={6}>
        {targets.map((x) => (
          <Button key={x ?? 'anyone'} kind={to === x ? 'primary' : 'plain'} label={names.target(x)} onPress={() => { setTo(x) }} />
        ))}
      </Row>
      <Button label='Post' busy={busy} disabled={text.trim() === ''} onPress={() => {
        setBusy(true)
        setError(null)
        pai.post(text.trim(), to, group).then(() => { setText(''); after() }, (err: Error) => { setError(err.message) }).finally(() => { setBusy(false) })
      }} />
      {error !== null && <Note color={t.danger}>{error}</Note>}
    </Card>
  )
}

export function Jobs ({ jobs, names, members, me, after }: { jobs: Job[] | null, names: Names, members: Member[], me: string | null, after: () => void }): ReactNode {
  const [posting, setPosting] = useState(false)
  if (jobs === null) return <Empty>Loading…</Empty>
  const sorted = [...jobs].sort((a, b) => b.updated - a.updated)
  return (
    <View>
      {posting ? <NewJob members={members} names={names} after={() => { setPosting(false); after() }} /> : <Button kind='plain' label='Post a job' onPress={() => { setPosting(true) }} />}
      <View style={{ height: 10 }} />
      {sorted.length === 0 ? <Empty>No jobs on the board.</Empty> : sorted.map((j) => <JobCard key={j.id} job={j} names={names} me={me} after={after} />)}
    </View>
  )
}

function FlowDetail ({ id, names, me, after }: { id: string, names: Names, me: string | null, after: () => void }): ReactNode {
  const t = useTheme()
  const [flow, setFlow] = useState<FlowView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { pai.flow(id).then((f) => { setFlow(f); if (f) setInput(f.input) }, (err: Error) => { setError(err.message) }) }, [id])
  // After an action, this workflow's own view is read again too.
  const act = (what: string, fn: () => Promise<unknown>): void => {
    setBusy(what)
    setError(null)
    fn().then(async () => { setFlow(await pai.flow(id)); after() }, (err: Error) => { setError(err.message) }).finally(() => { setBusy(null) })
  }
  if (flow === null) return error !== null ? <Note color={t.danger}>{error}</Note> : <Small>Loading…</Small>
  return (
    <View style={{ gap: 6 }}>
      {flow.steps.map((s) => {
        const where = flow.done.includes(s.name) ? 'done' : flow.skipped.includes(s.name) ? 'skipped' : flow.failed.includes(s.name) ? 'failed' : flow.items?.[s.name] ? `${flow.items[s.name]!.done}/${flow.items[s.name]!.n} items` : flow.jobs[s.name] ? 'running' : 'waiting'
        const color = where === 'done' ? t.ok : where === 'failed' ? t.danger : where === 'waiting' || where === 'skipped' ? t.muted : t.warn
        return (
          <Row key={s.name}>
            <Chip label={where} color={color} />
            <Body>{s.name}</Body>
            <Small>{s.flow !== undefined ? 'a workflow' : names.target(s.to ?? null)}{s.repeat ? ` · round ${(flow.loops?.[s.name]?.round ?? 0) + 1} of up to ${s.repeat.max}` : ''}</Small>
          </Row>
        )
      })}
      {flow.output !== null && flow.state !== 'running' && <Note color={stateColor(t, flow.state)}>{flow.output}</Note>}
      {flow.state === 'running' && flow.by === me && <Button kind='danger' label='Cancel this workflow' busy={busy === 'cancel'} onPress={() => { act('cancel', async () => { await pai.cancelFlow(flow.id) }) }} />}
      <Small>Run it again on</Small>
      <Field value={input} onChangeText={setInput} multiline accessibilityLabel='Workflow input' />
      <Button kind='plain' label='Run again' busy={busy === 'rerun'} disabled={input.trim() === ''} onPress={() => { act('rerun', async () => { await pai.rerun(flow.id, input.trim()) }) }} />
      {error !== null && <Note color={t.danger}>{error}</Note>}
    </View>
  )
}

export function Flows ({ flows, names, me, after }: { flows: FlowSummary[] | null, names: Names, me: string | null, after: () => void }): ReactNode {
  const t = useTheme()
  const [open, setOpen] = useState<string | null>(null)
  if (flows === null) return <Empty>Loading…</Empty>
  if (flows.length === 0) return <Empty>No workflows. Start one with pai flow start on a computer.</Empty>
  const sorted = [...flows].sort((a, b) => b.updated - a.updated)
  return (
    <View>
      {sorted.map((f) => (
        <Card key={f.id}>
          <Row>
            <Chip label={f.state} color={stateColor(t, f.state)} />
            {names.groups.length > 1 ? <Chip label={f.group} /> : null}
            <Body>{f.name ?? 'workflow'}</Body>
            <Small>{f.done}/{f.steps} steps · {names.of(f.by)}{f.schedule ? ` · ${f.schedule}` : ''} · {ago(f.updated)}</Small>
          </Row>
          {open === f.id ? <FlowDetail id={f.id} names={names} me={me} after={after} /> : null}
          <Button kind='plain' label={open === f.id ? 'Hide steps' : 'Show steps'} onPress={() => { setOpen(open === f.id ? null : f.id) }} />
        </Card>
      ))}
    </View>
  )
}
