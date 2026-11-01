import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import { AgentSort, AskTarget, PrRef, ReviewRpcs, SortEvent, SortResult } from '../src/index.ts'

const decision = {
  id: 'api-client',
  title: 'Planning API client patches the spec',
  lens: 'architecture',
  reason: 'departs',
  theme: 'API client',
  note: 'Core has no custom transforms.',
  existing: { path: 'packages/api-client-core/openapi-ts.config.ts', why: 'default setup' },
  authorWhy: null,
  files: [{ path: 'packages/api-client-planning/openapi-ts.config.ts', ranges: [{ start: 3, end: 36 }] }],
}

describe('domain schemas', () => {
  it('decodes a sort result from the agent JSON', () => {
    const decoded = Schema.decodeUnknownSync(AgentSort)({ decisions: [decision], skim: [], claims: [] })
    expect(decoded.decisions[0]?.lens).toBe('architecture')
  })

  it('rejects an unknown lens', () => {
    expect(() => Schema.decodeUnknownSync(AgentSort)({ decisions: [{ ...decision, lens: 'vibes' }], skim: [], claims: [] })).toThrow()
  })

  it('AskTarget decodes both tags', () => {
    const lines = Schema.decodeUnknownSync(AskTarget)({ _tag: 'Lines', path: 'a.ts', start: 1, end: 2, side: 'RIGHT', commit: 'h' })
    const dec = Schema.decodeUnknownSync(AskTarget)({ _tag: 'Decision', decision })
    expect([lines._tag, dec._tag]).toEqual(['Lines', 'Decision'])
  })

  it('PrRef round-trips through encode and decode', () => {
    const ref = { host: 'github.com', owner: 'acme', repo: 'core', number: 2926 }
    expect(Schema.decodeUnknownSync(PrRef)(Schema.encodeSync(PrRef)(ref))).toEqual(ref)
  })

  it('SortEvent is Running or Done', () => {
    expect(Schema.decodeUnknownSync(SortEvent)({ _tag: 'Running', startedAt: 'now' })._tag).toBe('Running')
  })

  it('ReviewRpcs lists its procedures', () => {
    expect([...ReviewRpcs.requests.keys()].sort()).toEqual(
      ['Ask', 'Configure', 'GetChats', 'GetDescription', 'GetDrafts', 'GetFilePatch', 'GetPr', 'GetSettings', 'Health', 'PoolStatus', 'Recall', 'Remember', 'SetDrafts', 'SetState', 'Sort', 'Stack', 'SubmitReview'],
    )
  })
})

it('a cached SortResult without a summary still decodes', () => {
  const old = { headSha: 'h', decisions: [], skim: [], trusted: [], claims: [], unclaimedDecisionIds: [], lines: { decision: 0, skim: 0, trusted: 0 } }
  expect(Schema.decodeUnknownSync(SortResult)(old)).toEqual(old)
})
