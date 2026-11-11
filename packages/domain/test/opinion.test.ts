import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import { type Finding, lowerSeverity, PrOpinion, rankFindings } from '../src/index.ts'

let n = 0
const f = (over: Partial<Finding>): Finding => ({
  severity: 'should',
  axis: 'standards',
  kind: 'design',
  title: 't',
  take: 'x',
  evidence: [],
  alternative: null,
  comment: null,
  anchor: null,
  handledIn: null,
  id: `f${n++}`,
  pr: 10,
  decisionId: null,
  verified: true,
  ...over,
})
const ids = (fs: Finding[]) => fs.map((x) => x.id)

describe('rankFindings', () => {
  it('puts blocks before should before ask', () => {
    const r = rankFindings([f({ id: 'a', severity: 'ask' }), f({ id: 'b', severity: 'blocks' }), f({ id: 'c' })], [10])
    expect(ids(r)).toEqual(['b', 'c', 'a'])
  })

  it('within a severity keeps bottom-of-stack PRs first', () => {
    const r = rankFindings([f({ id: 'a', pr: 11 }), f({ id: 'b', pr: 10 })], [10, 11])
    expect(ids(r)).toEqual(['b', 'a'])
  })

  it('within one PR keeps input order', () => {
    const r = rankFindings([f({ id: 'a' }), f({ id: 'b' }), f({ id: 'c' })], [10])
    expect(ids(r)).toEqual(['a', 'b', 'c'])
  })

  it('sinks handled findings below every unhandled one', () => {
    const r = rankFindings([f({ id: 'a', severity: 'blocks', handledIn: 11 }), f({ id: 'b', severity: 'ask' })], [10, 11])
    expect(ids(r)).toEqual(['b', 'a'])
  })
})

describe('lowerSeverity', () => {
  it('steps down and stops at ask', () => {
    expect(['blocks', 'should', 'ask'].map((s) => lowerSeverity(s as never))).toEqual(['should', 'ask', 'ask'])
  })
})

describe('PrOpinion', () => {
  it('round-trips through JSON', () => {
    const opinion: PrOpinion = {
      headSha: 'abc',
      ticket: null,
      ticketNote: '',
      decisions: [{ decisionId: 'd', authorCase: 'c', checked: null, findings: [f({ anchor: { path: 'a.ts', line: 1 } })], deep: false }],
      stackHeads: { '11': 'def' },
    }
    const json = JSON.stringify(Schema.encodeSync(PrOpinion)(opinion))
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(PrOpinion))(json)).toEqual(opinion)
  })
})
