import { assert, describe, it } from '@effect/vitest'
import { hunkLines, moveLine, nearestLine, sameChange } from '../src/interdiff.ts'

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

describe('moveLine', () => {
  // Old x.txt is a..p, one letter a line; the new one adds a first line, rewrites d to D and n to two lines.
  const patch = [
    'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', 'index 01e79c3..0000000', '--- a/gone.txt', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-1', '-2', '-3',
    'diff --git a/x.txt b/x.txt', 'index b03757e..11baa4e 100644', '--- a/x.txt', '+++ b/x.txt',
    '@@ -1,7 +1,8 @@', '+NEW', ' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g',
    '@@ -11,6 +12,7 @@ j', ' k', ' l', ' m', '-n', '+X1', '+X2', ' o', ' p', '',
  ].join('\n')
  const at = (path: string, line: number) => moveLine(patch, path, line)?.line

  it('follows the lines added above, between and inside hunks', () => {
    assert.deepStrictEqual([1, 8, 13, 16].map((l) => at('x.txt', l)), [2, 9, 14, 18])
  })
  it('keeps a line rewritten in place, and drops one rewritten into more lines', () => {
    assert.strictEqual(at('x.txt', 4), 5)
    assert.strictEqual(at('x.txt', 14), undefined)
  })
  it('drops a deleted file and leaves an untouched one as is', () => {
    assert.strictEqual(moveLine(patch, 'gone.txt', 2), undefined)
    assert.deepStrictEqual(moveLine(patch, 'other.txt', 7), { path: 'other.txt', line: 7 })
  })
})
