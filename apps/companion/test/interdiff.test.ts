import { assert, describe, it } from '@effect/vitest'
import { sameChange } from '../src/interdiff.ts'

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
