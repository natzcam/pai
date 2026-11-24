// What's waiting on the person: questions agents asked on their jobs,
// jobs they took to do by hand, jobs they may take, and (an admin's)
// proposals to approve.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { pai } from './worklet'
import type { Choices, Inbox as InboxData, Job, Proposal } from './types'
import { Body, Button, Card, Chip, Empty, Field, Note, Row, Section, Small, ago, useTheme } from './ui'

// `groups`: the identity's groups' names; an item names its group only
// when there's more than one.
export interface Names { of: (id: string) => string, target: (to: string | null) => string, groups: string[] }

// Runs an action, keeping its busy flag and error for the card.
function useAction (after: () => void): { busy: string | null, error: string | null, run: (what: string, fn: () => Promise<unknown>) => void } {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  return {
    busy,
    error,
    run: (what, fn) => {
      setBusy(what)
      setError(null)
      fn().then(() => { after() }, (err: Error) => { setError(err.message) }).finally(() => { setBusy(null) })
    }
  }
}

function Origin ({ job, names }: { job: Job, names: Names }): ReactNode {
  return (
    <Row>
      {names.groups.length > 1 ? <Chip label={job.group} /> : null}
      <Small>from {names.of(job.by)} · {ago(job.at)}</Small>
      {job.flow ? <Chip label={`workflow · ${job.flow.step}${job.flow.item !== undefined ? ` #${job.flow.item + 1}` : ''}`} /> : null}
      {job.spec.context ? <Chip label={`thread ${job.spec.context}`} /> : null}
    </Row>
  )
}

function QuestionCard ({ job, names, after }: { job: Job, names: Names, after: () => void }): ReactNode {
  const t = useTheme()
  const [answer, setAnswer] = useState('')
  const a = useAction(after)
  const q = job.question!
  return (
    <Card>
      <Small>{names.of(job.claim?.by ?? '')} asks, working on:</Small>
      <Body lines={3} muted>{job.spec.text}</Body>
      <Note color={t.accent}>{q.text}</Note>
      <Field value={answer} onChangeText={setAnswer} placeholder='Your answer' multiline accessibilityLabel='Your answer' />
      <Button label='Answer' busy={a.busy === 'answer'} disabled={answer.trim() === ''} onPress={() => { a.run('answer', async () => { await pai.answer(job.id, answer.trim()); setAnswer('') }) }} />
      {a.error !== null && <Note color={t.danger}>{a.error}</Note>}
    </Card>
  )
}

function HeldCard ({ job, input, choices, names, after }: { job: Job, input: string | undefined, choices: Choices | undefined, names: Names, after: () => void }): ReactNode {
  const t = useTheme()
  const [result, setResult] = useState('')
  const a = useAction(after)
  const text = (): string | null => result.trim() === '' ? null : result.trim()
  const done = (what: string, value: string | null): void => { a.run(what, async () => { await pai.finish(job.id, 'done', value) }) }
  const fail = (): void => { a.run('failed', async () => { await pai.finish(job.id, 'failed', text()) }) }
  const steps = (s: string[]): string => s.length ? ` → ${s.join(', ')}` : ''
  const branching = choices !== undefined && (choices.answers.length > 0 || choices.onFail.length > 0)
  return (
    <Card>
      <Origin job={job} names={names} />
      <Body>{input ?? job.spec.text}</Body>
      {branching && choices.answers.map((c) => (
        <Button key={c.text} label={`${c.text}${steps(c.leadsTo)}`} busy={a.busy === `answer:${c.text}`} disabled={a.busy !== null} onPress={() => { done(`answer:${c.text}`, c.text) }} />
      ))}
      <Field value={result} onChangeText={setResult} placeholder={branching ? (choices.otherwise.length ? `Or say something else${steps(choices.otherwise)}` : 'Or a result of your own') : 'Result (or why it failed)'} multiline accessibilityLabel='Result' />
      <Row>
        <Button label={branching && choices.otherwise.length ? `Send${steps(choices.otherwise)}` : 'Done'} busy={a.busy === 'done'} disabled={a.busy !== null} onPress={() => { done('done', text()) }} />
        <Button kind='danger' label={branching && choices.onFail.length ? `Reject${steps(choices.onFail)}` : 'Fail'} busy={a.busy === 'failed'} disabled={a.busy !== null} onPress={fail} />
        <Button kind='plain' label='Give back' busy={a.busy === 'release'} disabled={a.busy !== null} onPress={() => { a.run('release', async () => { await pai.release(job.id) }) }} />
      </Row>
      {a.error !== null && <Note color={t.danger}>{a.error}</Note>}
    </Card>
  )
}

function OpenCard ({ job, names, after }: { job: Job, names: Names, after: () => void }): ReactNode {
  const t = useTheme()
  const a = useAction(after)
  return (
    <Card>
      <Row>
        <Chip label={names.target(job.to)} color={t.accent} />
        <Origin job={job} names={names} />
      </Row>
      <Body lines={6}>{job.spec.text}</Body>
      <Button label='Take it' busy={a.busy === 'take'} onPress={() => { a.run('take', async () => { const r = await pai.take(job.id); if (!r.mine) throw new Error('Someone else took it first') }) }} />
      {a.error !== null && <Note color={t.danger}>{a.error}</Note>}
    </Card>
  )
}

function ProposalCard ({ p, names, after }: { p: Proposal, names: Names, after: () => void }): ReactNode {
  const t = useTheme()
  const a = useAction(after)
  const { type, ...rest } = p.op
  return (
    <Card>
      <Small>{names.groups.length > 1 ? `${p.group}: ` : ''}{names.of(p.by)} proposes · {ago(p.at)} · {p.approvals.length} approved</Small>
      <Body>{type}</Body>
      <Body mono muted lines={4}>{JSON.stringify(rest)}</Body>
      <Button label='Approve' busy={a.busy === 'approve'} onPress={() => { a.run('approve', async () => { await pai.approve(p.pid) }) }} />
      {a.error !== null && <Note color={t.danger}>{a.error}</Note>}
    </Card>
  )
}

export function Inbox ({ data, names, refresh }: { data: InboxData | null, names: Names, refresh: () => void }): ReactNode {
  if (data === null) return <Empty>Loading…</Empty>
  const nothing = data.questions.length + data.held.length + data.open.length + data.proposals.length === 0
  return (
    <View>
      {nothing && <Empty>Nothing waiting on you. Questions, jobs for a person, and approvals show up here.</Empty>}
      {data.questions.length > 0 && <Section title='Questions' count={data.questions.length}>{data.questions.map((j) => <QuestionCard key={`${j.id}:${j.question?.n ?? 0}`} job={j} names={names} after={refresh} />)}</Section>}
      {data.held.length > 0 && <Section title='Yours to do' count={data.held.length}>{data.held.map((j) => <HeldCard key={j.id} job={j} input={data.inputs[j.id]} choices={data.choices[j.id]} names={names} after={refresh} />)}</Section>}
      {data.open.length > 0 && <Section title='Open for you' count={data.open.length}>{data.open.map((j) => <OpenCard key={j.id} job={j} names={names} after={refresh} />)}</Section>}
      {data.proposals.length > 0 && <Section title='Proposals' count={data.proposals.length}>{data.proposals.map((p) => <ProposalCard key={p.pid} p={p} names={names} after={refresh} />)}</Section>}
    </View>
  )
}

// How many things wait on the person, for the tab's badge.
export function waiting (data: InboxData | null): number {
  return data === null ? 0 : data.questions.length + data.held.length + data.open.length + data.proposals.length
}
