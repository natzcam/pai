import { describe, expect, it } from 'vitest'
import { ErrorCodes, failure, isFailure, isRequest, isResponse, parse, request, success } from '../src/protocol/jsonrpc.js'

describe('jsonrpc', () => {
  it('builds spec-shaped envelopes', () => {
    expect(request(1, 'message/send', { a: 1 })).toEqual({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { a: 1 } })
    expect(request('x', 'tasks/get')).toEqual({ jsonrpc: '2.0', id: 'x', method: 'tasks/get' })
    expect(success(1, 'ok')).toEqual({ jsonrpc: '2.0', id: 1, result: 'ok' })
    expect(failure(1, ErrorCodes.TaskNotFound, 'nope')).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'nope' } })
  })

  it('classifies messages', () => {
    expect(isRequest(request(1, 'm'))).toBe(true)
    expect(isResponse(request(1, 'm'))).toBe(false)
    const res = success(1, null)
    expect(isResponse(res)).toBe(true)
    expect(isFailure(res)).toBe(false)
    expect(isFailure(failure(null, -1, 'e'))).toBe(true)
  })

  it('rejects malformed payloads', () => {
    for (const bad of [null, 42, {}, { jsonrpc: '1.0', id: 1, method: 'm' }, { jsonrpc: '2.0', method: 'm' }]) {
      const out = parse(bad)
      expect('error' in out && out.error.code).toBe(ErrorCodes.InvalidRequest)
    }
  })
})
