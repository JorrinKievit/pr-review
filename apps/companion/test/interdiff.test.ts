import { assert, describe, it } from '@effect/vitest'
import { hunkLines, nearestLine, sameChange } from '../src/interdiff.ts'

const patch = (index: string, hunk: string, extra = '') => `diff --git a/a.ts b/a.ts
index ${index} 100644
--- a/a.ts
+++ b/a.ts
@@ ${hunk} @@ function f() {
 one
+two
${extra}`

describe('sameChange', () => {
  it('same change on a moved base is the same', () => assert.isTrue(sameChange(patch('111..222', '-1,1 +1,2'), patch('333..444', '-40,1 +41,2'))))
  it('an extra added line is a change', () => assert.isFalse(sameChange(patch('111..222', '-1,1 +1,2'), patch('111..222', '-1,1 +1,3', '+three\n'))))
})

describe('hunkLines', () => {
  it('maps each file to its new-side hunk lines', () => {
    const lines = hunkLines(
      `${patch('1..2', '-1,1 +1,2')}diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -5 +6 @@\n-a\n++++ not a header\n`,
    )
    assert.deepStrictEqual([...lines], [['a.ts', [[1, 2]]], ['b.ts', [[6, 6]]]])
  })

  it('nearestLine keeps a line in range and moves one outside to the closest edge', () => {
    const ranges: Array<[number, number]> = [[10, 13], [31, 32]]
    assert.deepStrictEqual([12, 40, 25, 1].map((l) => nearestLine(ranges, l)), [12, 32, 31, 10])
    assert.isUndefined(nearestLine([], 5))
  })
})
