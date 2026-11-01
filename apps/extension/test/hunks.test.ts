import { parsePatchFiles } from '@pierre/diffs'
import { narrowPatch } from '../src/review/hunks.ts'

const patch = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,4 @@
 one
+two
 three
 four
@@ -20,3 +21,4 @@
 twenty
+twenty-one
 twenty-two
 twenty-three
`

const parse = (p: string) => parsePatchFiles(p)[0]!.files[0]!

test('keeps only overlapping hunks', () => {
  const { patch: narrowed, hidden } = narrowPatch(patch, [{ start: 22, end: 22 }])
  const f = parse(narrowed)
  expect(f.hunks).toHaveLength(1)
  expect(f.hunks[0]!.additionStart).toBe(21)
  expect(hidden).toBe(1)
})

test('the narrowed diff counts only the lines it keeps, so the renderer does not run past them', () => {
  const f = parse(narrowPatch(patch, [{ start: 2, end: 2 }]).patch)
  const last = f.hunks.at(-1)!
  expect(f.hunks).toHaveLength(1)
  expect(f.unifiedLineCount).toBe(last.unifiedLineStart + last.unifiedLineCount)
  expect(f.splitLineCount).toBe(last.splitLineStart + last.splitLineCount)
})

test('empty ranges keeps all', () => {
  expect(narrowPatch(patch, [])).toEqual({ patch, hidden: 0 })
})

test('ranges outside every hunk keep all, so nothing is hidden by a bad range', () => {
  expect(narrowPatch(patch, [{ start: 500, end: 510 }])).toEqual({ patch, hidden: 0 })
})
