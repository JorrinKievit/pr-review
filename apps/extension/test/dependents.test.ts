import type { Decision, StackEntry } from '@pr-review/domain'
import { dependentsOf } from '../src/stack/dependents.ts'

const pr = (number: number): StackEntry => ({ number, title: `#${number}`, baseRef: 'b', headRef: 'h', headSha: `s${number}` })
const decision = (paths: string[]): Decision => ({
  id: 'd', title: 'd', lens: 'architecture', reason: 'data-model', theme: 't', note: 'n', existing: null, authorWhy: null,
  files: paths.map((path) => ({ path, ranges: [] })),
})
const entries = [
  { pr: pr(1), files: ['src/Usage/Event.php'] },
  { pr: pr(2), files: ['src/Usage/Event.php', 'src/Billing/Grant.php'] },
  { pr: pr(3), files: ['src/Billing/Grant.php'] },
]

test('PR above touching the same file depends', () => {
  expect(dependentsOf(decision(['src/Usage/Event.php']), 1, entries)).toEqual([2])
})

test('PR below never depends', () => {
  expect(dependentsOf(decision(['src/Billing/Grant.php']), 3, entries)).toEqual([])
})

test('no overlap returns empty', () => {
  expect(dependentsOf(decision(['README.md']), 1, entries)).toEqual([])
})
