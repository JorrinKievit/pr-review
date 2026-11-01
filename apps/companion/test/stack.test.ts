import { test } from '@effect/vitest'
import assert from 'node:assert/strict'
import { buildStack } from '../src/stack.ts'
import type { StackEntry } from '@pr-review/domain'

const b = (n: string) => `feat/credits-${n}`
const pr = (number: number, baseRef: string, headRef: string): StackEntry => ({ number, title: `#${number}`, baseRef, headRef, headSha: `sha${number}` })

// A real stack (open PRs only), shuffled so order comes from the walk, not the input.
const core1136: StackEntry[] = [
  pr(2829, b('25'), b('26')),
  pr(2567, 'master', b('01')),
  pr(2568, b('01'), b('02')),
  pr(2569, b('02'), b('03')),
  pr(2570, b('03'), b('04')),
  pr(2571, b('04'), b('05')),
  pr(2572, b('05'), b('06')),
  pr(2573, b('06'), b('07')),
  pr(2574, b('07'), b('08')),
  pr(2575, b('08'), b('09')),
  pr(2576, b('09'), b('10')),
  pr(2577, b('10'), b('11')),
  pr(2627, b('11'), b('14')),
  pr(2628, b('14'), b('15')),
  pr(2633, b('15'), b('19')),
  pr(2634, b('19'), b('20')),
  pr(2635, b('20'), b('21')),
  pr(2636, b('21'), b('22')),
  pr(2638, b('22'), b('24')),
  pr(2639, b('24'), b('25')),
  pr(1, 'master', 'unrelated'),
]

test('buildStack walks a stack from the middle, bottom first', () => {
  const s = buildStack(core1136, 2633, 'master').map((e) => e.number)
  assert.equal(s.length, 20)
  assert.deepEqual(s.slice(0, 2), [2567, 2568])
  assert.deepEqual(s.slice(-2), [2639, 2829])
})

test('buildStack includes forks, lower number first', () => {
  const prs = [pr(10, 'master', 'x'), pr(12, 'x', 'y'), pr(11, 'x', 'z')]
  assert.deepEqual(buildStack(prs, 12, 'master').map((e) => e.number), [10, 11, 12])
})

test('buildStack returns a lone PR', () => {
  assert.deepEqual(buildStack(core1136, 1, 'master').map((e) => e.number), [1])
})
