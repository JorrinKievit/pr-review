import type { StackEntry } from '@pr-review/domain'

/** Bottom-first, depth-first list of the open PRs stacked with `number`, found by following base branches. */
export function buildStack(prs: StackEntry[], number: number, defaultBranch: string): StackEntry[] {
  const byHead = new Map(prs.map((p) => [p.headRef, p]))
  let bottom = prs.find((p) => p.number === number)
  if (!bottom) return []
  const seen = new Set<number>()
  while (bottom.baseRef !== defaultBranch && !seen.has(bottom.number)) {
    seen.add(bottom.number)
    const below = byHead.get(bottom.baseRef)
    if (!below) break
    bottom = below
  }

  const out: StackEntry[] = []
  const visit = (p: StackEntry) => {
    if (out.includes(p)) return
    out.push(p)
    prs.filter((c) => c.baseRef === p.headRef).sort((a, b) => a.number - b.number).forEach(visit)
  }
  visit(bottom)
  return out
}
