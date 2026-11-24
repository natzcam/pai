import { describe, expect, it } from 'vitest'
import { InvalidTransitionError, appendArtifact, canTransition, createTask, endsStream, isTerminal, transition } from '../src/task/task.js'

describe('task lifecycle', () => {
  it('follows the happy path', () => {
    let task = createTask('t1', 'c1')
    expect(task.status.state).toBe('TASK_STATE_SUBMITTED')
    task = transition(task, 'TASK_STATE_WORKING')
    task = transition(task, 'TASK_STATE_INPUT_REQUIRED')
    task = transition(task, 'TASK_STATE_WORKING')
    task = transition(task, 'TASK_STATE_COMPLETED')
    expect(isTerminal(task.status.state)).toBe(true)
  })

  it('rejects leaving a terminal state', () => {
    const done = transition(transition(createTask('t', 'c'), 'TASK_STATE_WORKING'), 'TASK_STATE_COMPLETED')
    expect(() => transition(done, 'TASK_STATE_WORKING')).toThrow(InvalidTransitionError)
  })

  it('does not mutate the input', () => {
    const task = createTask('t', 'c')
    transition(task, 'TASK_STATE_WORKING')
    expect(task.status.state).toBe('TASK_STATE_SUBMITTED')
  })

  it('only allows completion from working', () => {
    expect(canTransition('TASK_STATE_SUBMITTED', 'TASK_STATE_COMPLETED')).toBe(false)
    expect(canTransition('TASK_STATE_WORKING', 'TASK_STATE_COMPLETED')).toBe(true)
  })
})

describe('artifacts and stream ends', () => {
  const art = (id: string, text: string) => ({ artifactId: id, parts: [{ text }] })

  it('appends parts to an artifact with the same id, or replaces it', () => {
    let task = createTask('t', 'c')
    task = appendArtifact(task, art('a', '1'))
    task = appendArtifact(task, art('a', '2'), true)
    task = appendArtifact(task, art('b', 'x'))
    expect(task.artifacts?.map((a) => a.parts.length)).toEqual([2, 1])
    task = appendArtifact(task, art('a', 'new'))
    expect(task.artifacts?.[0]?.parts).toEqual([{ text: 'new' }])
  })

  it('knows which states end a stream', () => {
    expect(endsStream('TASK_STATE_WORKING')).toBe(false)
    expect(endsStream('TASK_STATE_SUBMITTED')).toBe(false)
    expect(endsStream('TASK_STATE_INPUT_REQUIRED')).toBe(true)
    expect(endsStream('TASK_STATE_AUTH_REQUIRED')).toBe(true)
    expect(endsStream('TASK_STATE_COMPLETED')).toBe(true)
    expect(endsStream('TASK_STATE_REJECTED')).toBe(true)
  })
})
