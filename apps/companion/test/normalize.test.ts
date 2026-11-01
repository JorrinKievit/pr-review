import { test } from '@effect/vitest'
import assert from 'node:assert/strict'
import { normalize } from '../src/normalize.ts'
import type { AgentSort, Decision, FileStat, TrustedGroup } from '@pr-review/domain'

const f = (path: string, additions = 10, deletions = 0): FileStat => ({ path, additions, deletions })
const decision = (id: string, paths: string[]): Decision => ({
  id,
  title: id,
  lens: 'architecture',
  reason: 'shared-layer',
  theme: 't',
  note: 'n',
  existing: null,
  authorWhy: null,
  files: paths.map((path) => ({ path, ranges: [] })),
})
const agent = (a: Partial<AgentSort>): AgentSort => ({ decisions: [], skim: [], claims: [], ...a })

const files = [f('a.ts'), f('b.ts'), f('c.ts'), f('x.test.ts', 5)]
const trusted: TrustedGroup[] = [{ group: 'tests', why: 'CI checks: pass', files: ['x.test.ts'] }]

test('drops unknown paths', () => {
  const r = normalize(agent({ decisions: [decision('d1', ['a.ts', 'nope.ts'])], skim: [{ area: 's', summary: '', files: ['ghost.ts', 'b.ts'] }] }), files, trusted, 'sha')
  assert.deepEqual(r.decisions[0]!.files.map((x) => x.path), ['a.ts'])
  assert.deepEqual(r.skim[0]!.files, ['b.ts'])
})

test('drops a decision left with no files', () => {
  const r = normalize(agent({ decisions: [decision('d1', ['nope.ts'])] }), files, trusted, 'sha')
  assert.equal(r.decisions.length, 0)
})

test('unplaced file goes to Unsorted', () => {
  const r = normalize(agent({ decisions: [decision('d1', ['a.ts'])], skim: [{ area: 's', summary: '', files: ['b.ts'] }] }), files, trusted, 'sha')
  const unsorted = r.skim.find((s) => s.area === 'Unsorted')!
  assert.deepEqual(unsorted.files, ['c.ts'])
})

test('decision wins over skim', () => {
  const r = normalize(agent({ decisions: [decision('d1', ['a.ts'])], skim: [{ area: 's', summary: '', files: ['a.ts', 'b.ts', 'c.ts'] }] }), files, trusted, 'sha')
  assert.deepEqual(r.skim.find((s) => s.area === 's')!.files, ['b.ts', 'c.ts'])
})

test('decision may claim a trusted file', () => {
  const r = normalize(agent({ decisions: [decision('d1', ['x.test.ts'])], skim: [{ area: 's', summary: '', files: ['a.ts', 'b.ts', 'c.ts'] }] }), files, trusted, 'sha')
  assert.deepEqual(r.trusted, [])
  assert.deepEqual(r.decisions[0]!.files.map((x) => x.path), ['x.test.ts'])
})

test('Claude can send a rule candidate to skim', () => {
  const r = normalize(agent({ skim: [{ area: 's', summary: '', files: ['x.test.ts', 'a.ts', 'b.ts', 'c.ts'] }] }), files, trusted, 'sha')
  assert.deepEqual(r.trusted, [])
  assert.ok(r.skim.flatMap((s) => s.files).includes('x.test.ts'))
})

test('candidates Claude did not place keep their rule group', () => {
  const r = normalize(agent({ skim: [{ area: 's', summary: '', files: ['a.ts', 'b.ts', 'c.ts'] }] }), files, trusted, 'sha')
  assert.deepEqual(r.trusted, trusted)
})

test('Claude can trust files the rules missed, but never a migration', () => {
  const all = [...files, f('db/migrations/1.sql')]
  const r = normalize(
    agent({ skim: [{ area: 's', summary: '', files: ['a.ts', 'b.ts'] }], trusted: [{ group: 'Fixtures', why: 'Sample data only', files: ['c.ts', 'db/migrations/1.sql'] }] }),
    all,
    trusted,
    'sha',
    ['**/migrations/**'],
  )
  assert.deepEqual(r.trusted, [trusted[0], { group: 'Fixtures', why: 'Sample data only', files: ['c.ts'] }])
  assert.deepEqual(r.skim.at(-1), { area: 'Unsorted', summary: 'Not placed by the sort.', files: ['db/migrations/1.sql'] })
})

test('unclaimed ids listed when claims exist', () => {
  const a = agent({ decisions: [decision('d1', ['a.ts']), decision('d2', ['b.ts'])], claims: [{ text: 'c', decisionIds: ['d1'] }] })
  assert.deepEqual(normalize(a, files, trusted, 'sha').unclaimedDecisionIds, ['d2'])
  assert.deepEqual(normalize(agent({ decisions: [decision('d1', ['a.ts'])] }), files, trusted, 'sha').unclaimedDecisionIds, [])
})

test('lines counted once in highest pile', () => {
  const r = normalize(agent({ decisions: [decision('d1', ['a.ts']), decision('d2', ['a.ts', 'b.ts'])], skim: [{ area: 's', summary: '', files: ['c.ts'] }] }), files, trusted, 'sha')
  assert.deepEqual(r.lines, { decision: 20, skim: 10, trusted: 5 })
  assert.equal(r.headSha, 'sha')
})

test('keeps the summary of what the PR does', () => {
  assert.equal(normalize(agent({ summary: 'Adds supplier admin endpoints.' }), files, trusted, 'sha').summary, 'Adds supplier admin endpoints.')
  assert.equal('summary' in normalize(agent({}), files, trusted, 'sha'), false)
})

test("a candidate Claude trusted itself takes Claude's group", () => {
  const r = normalize(agent({ skim: [{ area: 's', summary: '', files: ['a.ts', 'b.ts', 'c.ts'] }], trusted: [{ group: 'Tests', why: 'Only renames a fixture', files: ['x.test.ts'] }] }), files, trusted, 'sha')
  assert.deepEqual(r.trusted, [{ group: 'Tests', why: 'Only renames a fixture', files: ['x.test.ts'] }])
})
