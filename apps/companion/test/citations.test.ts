import { it } from '@effect/vitest'
import assert from 'node:assert/strict'
import { Effect } from 'effect'
import type { AgentFinding, Evidence } from '@pr-review/domain'
import { checkFinding } from '../src/citations.ts'

const file = ['a', 'b', 'const x = compute(1, 2)', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')

const ev = (over: Partial<Evidence> = {}): Evidence => ({ ref: 'head', path: 'src/a.ts', line: 3, quote: 'const x = compute(1, 2)', ...over })
const finding = (evidence: Evidence[], over: Partial<AgentFinding> = {}): AgentFinding => ({
  severity: 'blocks',
  axis: 'standards',
  kind: 'rule',
  title: 't',
  take: 'x',
  evidence,
  alternative: null,
  comment: null,
  anchor: null,
  handledIn: null,
  ...over,
})
const run = (f: AgentFinding, text: string | undefined) => Effect.runSync(checkFinding(f, () => Effect.succeed(text)))

it.effect('quote on the cited line is kept', () =>
  Effect.sync(() => {
    const r = run(finding([ev()]), file)
    assert.equal(r.evidence[0]!.line, 3)
    assert.equal(r.verified, true)
    assert.equal(r.severity, 'blocks')
  }),
)

it.effect('quote 5 lines off moves the line', () =>
  Effect.sync(() => {
    const r = run(finding([ev({ line: 8 })]), file)
    assert.equal(r.evidence[0]!.line, 3)
    assert.equal(r.verified, true)
  }),
)

it.effect('quote matches after trimming and a trailing …', () =>
  Effect.sync(() => {
    const r = run(finding([ev({ quote: '  const x = compute…' })]), file)
    assert.equal(r.evidence.length, 1)
    assert.equal(r.verified, true)
  }),
)

it.effect('quote not in the file drops the evidence', () =>
  Effect.sync(() => {
    const r = run(finding([ev({ quote: 'nothing like this' })]), file)
    assert.equal(r.evidence.length, 0)
    assert.equal(r.verified, false)
  }),
)

it.effect('missing file drops evidence', () =>
  Effect.sync(() => {
    const r = run(finding([ev()]), undefined)
    assert.equal(r.evidence.length, 0)
  }),
)

it.effect('no code evidence lowers severity blocks→should', () =>
  Effect.sync(() => {
    const r = run(finding([ev({ quote: 'nope' })]), file)
    assert.equal(r.severity, 'should')
  }),
)

it.effect('docs-only finding keeps severity, unverified', () =>
  Effect.sync(() => {
    const r = run(finding([ev({ ref: 'docs', path: 'react', line: 0, quote: 'effects' })], { kind: 'framework' }), file)
    assert.equal(r.evidence.length, 1)
    assert.equal(r.severity, 'blocks')
    assert.equal(r.verified, false)
  }),
)

it.effect('upstream without related evidence keeps severity, unverified', () =>
  Effect.sync(() => {
    const r = run(finding([ev({ ref: 'related', quote: 'nope' })], { kind: 'upstream' }), file)
    assert.equal(r.severity, 'blocks')
    assert.equal(r.verified, false)
  }),
)
