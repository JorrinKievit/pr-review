import type { Decision, StackEntry } from '@pr-review/domain'

/** PRs above `prNumber` in the stack (entries run bottom to top) that touch a file the decision touches. */
export function dependentsOf(decision: Decision, prNumber: number, entries: ReadonlyArray<{ pr: StackEntry; files: ReadonlyArray<string> }>): number[] {
  const paths = new Set(decision.files.map((f) => f.path))
  const at = entries.findIndex((e) => e.pr.number === prNumber)
  return entries
    .slice(at + 1)
    .filter((e) => e.files.some((f) => paths.has(f)))
    .map((e) => e.pr.number)
}
