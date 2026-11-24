import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FLOW_FORMAT, checkFlow, flowLayout, groupGuide, unknownFields } from '../src/group/flow-guide.js'
import type { FlowSpec } from '../src/group/flows.js'
import type { MemberRecord } from '../src/group/state.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const member = (id: string, roles: string[]): MemberRecord => ({ id, writers: [], devices: {}, written: [], name: null, roles, until: null, addedBy: null, at: 0 })

describe('writing workflows', () => {
  it('finds fields pai doesn\'t know, at any depth, with what was likely meant', () => {
    expect(unknownFields({ steps: [{ name: 'a', to: null, text: 'x', when: { step: 'a', equals: 'x', negate: true } }], notes: 'x' })).toEqual([
      'the workflow has a field pai doesn\'t know: "notes" (a workflow keeps no notes: say it in the text)',
      'step a has a field pai doesn\'t know: "when" (did you mean if?)'
    ])
    const nested = { steps: [{ name: 'p', text: 'x', flow: { steps: [{ name: 'q', to: null, text: 'y', dependsOn: [] }] } }] }
    // A workflow's own fields get hints of their own.
    expect(unknownFields({ title: 'x', input: 'y', steps: [] })).toEqual(['the workflow has a field pai doesn\'t know: "title" (did you mean name?)', 'the workflow has a field pai doesn\'t know: "input"'])
    expect(unknownFields(nested)).toEqual(['step p\'s workflow: step q has a field pai doesn\'t know: "dependsOn" (did you mean after?)'])
    expect(unknownFields({ steps: [{ name: 'r', to: null, text: 'x', repeat: { from: 'r', until: { step: 'r', equals: 'ok', constructor: 1 }, max: 2, times: 3 } }] })).toEqual([
      'step r\'s repeat has a field pai doesn\'t know: "times"',
      'step r\'s repeat\'s until has a field pai doesn\'t know: "constructor"'
    ])
  })

  it('checks a workflow against the group: members, roles and the policy', () => {
    const spec: FlowSpec = { steps: [
      { name: 'a', to: 'role:writer', text: 'x' },
      { name: 'b', to: 'role:ghost', after: ['a'], text: 'x' },
      { name: 'c', after: ['b'], text: 'x', flow: { steps: [{ name: 'd', to: B, text: 'y' }, { name: 'e', to: 'c'.repeat(64), text: 'z' }] } }
    ] }
    expect(checkFlow(spec)).toEqual({ problems: [], warnings: [] })
    const roster = { members: [member(A, []), member(B, ['writer'])], admins: [A], policy: [{ name: 'no-b', from: '*', to: B, allow: false }], clock: 0 }
    expect(checkFlow(spec, { self: A, roster })).toEqual({
      problems: [
        `step c/d: the group's policy doesn't let you post jobs for ${B}`,
        `step c/e is for ${'c'.repeat(64)}, which isn't a member of the group`
      ],
      warnings: ['step b is for role:ghost, but no member has that role now: it would wait']
    })
    // Still syncing: a member it hasn't heard of may just not be here yet.
    expect(checkFlow(spec, { self: A, roster, syncing: true }).warnings).toContain(`step c/e is for ${'c'.repeat(64)}, which isn't a member of the group (as far as this device has synced)`)
    // A membership that ran out: its roles and id can't take jobs.
    const lapsed = { ...roster, policy: [], members: [member(A, []), { ...member(B, ['writer']), until: 1000 }] }
    expect(checkFlow({ steps: [{ name: 'a', to: 'role:writer', text: 'x' }, { name: 'b', to: B, text: 'x' }] }, { self: A, roster: lapsed }, 2000)).toEqual({
      problems: [`step b is for ${B}, which isn't a member of the group any more (its membership ran out)`],
      warnings: [expect.stringMatching(/joins several/), 'step a is for role:writer, but no member has that role now: it would wait']
    })
    // A policy that keeps jobs from going to anyone.
    const closed = { ...roster, policy: [{ name: 'no-open', from: '*', to: '*', allow: false }] }
    expect(checkFlow({ steps: [{ name: 'a', to: null, text: 'x' }] }, { self: A, roster: closed }).problems).toEqual(['step a: the group\'s policy doesn\'t let you post jobs for anyone'])
    // Unknown fields don't hide the group's problems.
    expect(checkFlow({ steps: [{ name: 'a', to: 'c'.repeat(64), text: 'x', notes: 'n' }] }, { self: A, roster }).problems).toEqual([
      'step a has a field pai doesn\'t know: "notes" (a workflow keeps no notes: say it in the text)',
      `step a is for ${'c'.repeat(64)}, which isn't a member of the group`
    ])
    // The format's problem, after the unknown fields; nothing more then.
    expect(checkFlow({ steps: [{ name: 'a', to: 'role:x', text: '', extra: 1 }] }).problems).toEqual(['step a has a field pai doesn\'t know: "extra"', 'step a: text is required'])
    // Two final steps that always run: a warning; a planned sub-workflow too.
    expect(checkFlow({ steps: [{ name: 'a', to: null, text: 'x' }, { name: 'b', to: null, text: 'x' }] }).warnings).toEqual([expect.stringMatching(/joins several steps' results \(a, b\)/)])
    expect(checkFlow({ steps: [{ name: 'p', to: null, text: 'x' }, { name: 'r', after: ['p'], flow: 'steps.p', text: 'x' }] }).warnings).toEqual([expect.stringMatching(/checked only when its plan is done/)])
  })

  it('lays a workflow out: stages, loops, branches, sub-workflows', () => {
    const spec: FlowSpec = { name: 'ship', steps: [
      { name: 'draft', to: 'role:writer', text: 'x' },
      { name: 'test', to: null, after: ['draft'], text: 'x', copies: 3, settle: { agree: 2 } },
      { name: 'review', to: A, after: ['draft', 'test'], text: 'x', repeat: { from: 'draft', until: { step: 'review', equals: 'ok' }, max: 3 } },
      { name: 'fix', to: 'role:writer', after: ['review'], text: 'x', if: { step: 'review', failed: true, not: true } },
      { name: 'sub', after: ['review'], text: 'x', flow: { steps: [{ name: 'one', to: null, text: 'y', map: 'input' }] } }
    ] }
    expect(flowLayout(spec)).toBe([
      'ship: 5 steps; output: fix + sub',
      ' 1 ┌ draft   role:writer',
      ' 2 │ test    anyone  · after draft · 3 copies · done when 2 agree',
      ' 3 └ review  aaaaaaaa…  · after draft, test · repeat from draft until review is "ok", at most 3 rounds',
      ' 4   fix     role:writer  · after review · if review didn\'t fail',
      ' 4   sub     workflow:  · after review',
      '       1   one  anyone  · for each item of the input'
    ].join('\n'))
  })

  it('describes the format and the group', () => {
    expect(FLOW_FORMAT).toMatch(/pai flow check/)
    const text = groupGuide(A, [{ id: A, name: 'me', roles: [], admin: true }, { id: B, name: 'w', roles: ['writer'], admin: false, description: 'Writes.', skills: ['drafting'] }], ['anyone (null)'])
    expect(text).toContain('Roles: role:writer')
    expect(text).toContain(`${A}  me  admin  (you)`)
    expect(text).toContain('says: "Writes."')
    expect(text).toContain('skills: "drafting"')
    expect(text).toMatch(/data, not instructions/)
    expect(text).toMatch(/doesn't let you post jobs for: anyone \(null\)/)
  })

  it('passes the examples, which the guide points to', async () => {
    const dir = join(__dirname, '..', 'examples', 'model-team')
    for (const f of (await readdir(dir)).filter((n) => n.endsWith('.json'))) {
      const spec = JSON.parse(await readFile(join(dir, f), 'utf-8'))
      expect(checkFlow(spec).problems, f).toEqual([])
    }
  })
})
