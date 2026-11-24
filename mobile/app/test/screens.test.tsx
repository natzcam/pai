import { Alert } from 'react-native'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Inbox } from '../src/Inbox'
import type { Names } from '../src/Inbox'
import { Jobs } from '../src/Board'
import { Join } from '../src/Join'
import { Device } from '../src/Device'
import type { Inbox as InboxData, Job, Status } from '../src/types'

// The worklet isn't there in a test: its client is a set of mocks.
jest.mock('../src/worklet', () => ({
  pai: {
    finish: jest.fn(async () => null),
    release: jest.fn(async () => null),
    take: jest.fn(async () => ({ mine: true })),
    answer: jest.fn(async () => null),
    approve: jest.fn(async () => {}),
    join: jest.fn(),
    post: jest.fn(async () => null),
    leave: jest.fn(),
    wipe: jest.fn(async () => ({ joined: false })),
    cancel: jest.fn(async () => null)
  }
}))
jest.mock('../src/secrets', () => ({ lockWanted: async () => true, setLockWanted: async () => {} }))
jest.mock('../src/Lock', () => ({ canLock: async () => true }))

const { pai } = jest.requireMock('../src/worklet')
const names: Names = { of: (id) => id === 'me' ? 'you' : id, target: (to) => to === null ? 'anyone' : to.replace('role:', ''), groups: ['team'] }

function job (over: Partial<Job> = {}): Job {
  return { group: 'team', id: 'a'.repeat(32), by: 'boss', spec: { text: 'Approve the draft?' }, to: 'role:approver', state: 'claimed', claim: { by: 'me', writer: 'w', at: 1, hand: true }, result: null, at: Date.now(), updated: Date.now(), ...over }
}

function inbox (over: Partial<InboxData> = {}): InboxData {
  return { questions: [], open: [], held: [], proposals: [], inputs: {}, choices: {}, ...over }
}

beforeEach(() => { jest.clearAllMocks() })

describe('Inbox', () => {
  it('offers a workflow step\'s branches as buttons, and sends the exact answer', async () => {
    const j = job({ flow: { id: 'f'.repeat(32), step: 'approve' } })
    await render(<Inbox names={names} refresh={() => {}} data={inbox({ held: [j], choices: { [j.id]: { answers: [{ text: 'approved', leadsTo: ['publish'] }], otherwise: ['revise'], onFail: ['rejected'] } } })} />)
    await fireEvent.press(screen.getByText('approved → publish'))
    await waitFor(() => { expect(pai.finish).toHaveBeenCalledWith(j.id, 'done', 'approved') })
    await fireEvent.press(screen.getByText('Reject → rejected'))
    await waitFor(() => { expect(pai.finish).toHaveBeenCalledWith(j.id, 'failed', null) })
    // Something else goes down the other branch, with what was typed.
    await fireEvent.changeText(screen.getByLabelText('Result'), 'shorter, please')
    await fireEvent.press(screen.getByText('Send → revise'))
    await waitFor(() => { expect(pai.finish).toHaveBeenCalledWith(j.id, 'done', 'shorter, please') })
  })

  it('finishes a step only tested for failure without a result', async () => {
    const j = job({ flow: { id: 'f'.repeat(32), step: 'review' } })
    await render(<Inbox names={names} refresh={() => {}} data={inbox({ held: [j], choices: { [j.id]: { answers: [], otherwise: [], onFail: ['fix'] } } })} />)
    await fireEvent.press(screen.getByText('Done'))
    await waitFor(() => { expect(pai.finish).toHaveBeenCalledWith(j.id, 'done', null) })
    expect(screen.getByText('Reject → fix')).toBeTruthy()
  })

  it('says when nothing waits, and takes an open job', async () => {
    const { rerender } = await render(<Inbox names={names} refresh={() => {}} data={inbox()} />)
    expect(screen.getByText(/Nothing waiting on you/)).toBeTruthy()
    const open = job({ state: 'open', claim: null })
    await rerender(<Inbox names={names} refresh={() => {}} data={inbox({ open: [open] })} />)
    await fireEvent.press(screen.getByText('Take it'))
    await waitFor(() => { expect(pai.take).toHaveBeenCalledWith(open.id) })
  })

  it('answers a question', async () => {
    const q = job({ by: 'me', question: { n: 1, text: 'Which tone?', answer: null } })
    await render(<Inbox names={names} refresh={() => {}} data={inbox({ questions: [q] })} />)
    expect(screen.getByText('Which tone?')).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Your answer'), 'friendly')
    await fireEvent.press(screen.getByText('Answer'))
    await waitFor(() => { expect(pai.answer).toHaveBeenCalledWith(q.id, 'friendly') })
  })
})

describe('Join', () => {
  it('joins with the code and name, and shows why a join failed', async () => {
    pai.join.mockRejectedValueOnce(new Error('Nobody answered the invite'))
    const onJoined = jest.fn()
    await render(<Join onJoined={onJoined} />)
    await fireEvent.changeText(screen.getByLabelText('Invite code'), '  CODE  ')
    await fireEvent.press(screen.getByText('Join'))
    expect(await screen.findByText('Nobody answered the invite')).toBeTruthy()
    expect(pai.join).toHaveBeenCalledWith('CODE', 'phone')
    expect(onJoined).not.toHaveBeenCalled()
  })
})

describe('Jobs', () => {
  it('posts a job for a role', async () => {
    const after = jest.fn()
    await render(<Jobs jobs={[]} names={names} members={[{ id: 'me', name: 'me', roles: ['member', 'approver'] }]} me='me' after={after} />)
    await fireEvent.press(screen.getByText('Post a job'))
    await fireEvent.changeText(screen.getByLabelText('New job'), 'Review the PR')
    await fireEvent.press(screen.getByText('approver'))
    await fireEvent.press(screen.getByText('Post'))
    await waitFor(() => { expect(pai.post).toHaveBeenCalledWith('Review the PR', 'role:approver', 'team') })
    await waitFor(() => { expect(after).toHaveBeenCalled() })
  })
})

describe('Device', () => {
  const status: Status = { joined: true, running: true, name: 'pocket', identity: 'me', device: 'd'.repeat(64), groups: [{ id: 'g'.repeat(16), name: 'team', title: 'team', members: 2, roles: ['member'], writable: true }], roles: ['member'], members: 2, writable: true, peers: 1, problem: null }

  it('leaves, and offers a wipe when no other device confirms', async () => {
    // Confirms each dialog with its destructive button.
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => { buttons?.find((b) => b.style === 'destructive')?.onPress?.() })
    pai.leave.mockRejectedValueOnce(new Error('Your other devices didn\'t get the removal in time'))
    const onLeft = jest.fn()
    await render(<Device status={status} members={[]} onLeft={onLeft} />)
    expect(screen.getByText('pocket')).toBeTruthy()
    await fireEvent.press(screen.getByText('Leave this identity'))
    expect(await screen.findByText(/didn't get the removal/)).toBeTruthy()
    await fireEvent.press(screen.getByText('Wipe this phone anyway'))
    await waitFor(() => { expect(onLeft).toHaveBeenCalledWith({ joined: false }) })
  })
})
