import type { LineRange } from '@pr-review/domain'

const HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

/**
 * The patch narrowed to hunks touching `ranges` (new-file lines), with how many hunks were left out.
 * Narrowed as text so the parser's line counts match what is kept. No ranges, or no overlap, keeps every hunk.
 */
export function narrowPatch(patch: string, ranges: ReadonlyArray<LineRange>): { patch: string; hidden: number } {
  if (ranges.length === 0) return { patch, hidden: 0 }
  const [head, ...hunks] = patch.split(/^(?=@@ )/m)
  const kept = hunks.filter((h) => {
    const [, start, count = '1'] = HEADER.exec(h) ?? []
    const from = Number(start)
    const to = from + Math.max(Number(count), 1) - 1
    return ranges.some((r) => r.start <= to && r.end >= from)
  })
  if (kept.length === 0) return { patch, hidden: 0 }
  return { patch: head + kept.join(''), hidden: hunks.length - kept.length }
}
