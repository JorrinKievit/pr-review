import { parsePatch, type StructuredPatch } from 'diff'

/** The files of a `git diff`; text that is no diff, or that `parsePatch` can't read, has none. */
export const parseDiff = (patch: string): ReadonlyArray<StructuredPatch> => {
  try {
    return parsePatch(patch).filter((f) => f.oldFileName !== undefined || f.newFileName !== undefined)
  } catch {
    return []
  }
}

/** A side's path, without git's `a/`/`b/`; undefined for /dev/null. */
export const pathOf = (name: string | undefined) => (name === undefined || name === '/dev/null' ? undefined : name.replace(/^[ab]\//, ''))

/** True when two files' patches make the same change, whatever base they sit on: blob ids and hunk positions aside. */
export const sameChange = (a: StructuredPatch, b: StructuredPatch) => JSON.stringify(shape(a)) === JSON.stringify(shape(b))

const shape = (f: StructuredPatch) => [f.oldFileName, f.newFileName, f.oldMode, f.newMode, f.isRename, f.isCopy, f.isCreate, f.isDelete, f.isBinary, f.hunks.map((h) => h.lines)]

/** Line ranges per file on one side (new by default): the lines GitHub accepts a review comment on. */
export const hunkLines = (patch: string, side: 'LEFT' | 'RIGHT' = 'RIGHT') =>
  new Map(
    parseDiff(patch).flatMap((f) => {
      const path = pathOf(side === 'RIGHT' ? f.newFileName : f.oldFileName)
      const ranges = f.hunks.map((h): [number, number] => (side === 'RIGHT' ? [h.newStart, h.newLines] : [h.oldStart, h.oldLines]))
      return path ? [[path, ranges.filter(([, n]) => n > 0).map(([start, n]): [number, number] => [start, start + n - 1])] as const] : []
    }),
  )

/** The line in `ranges` nearest to `line`, or undefined when there are none. */
export const nearestLine = (ranges: ReadonlyArray<readonly [number, number]>, line: number) =>
  ranges.map(([from, to]) => Math.min(Math.max(line, from), to)).reduce<number | undefined>((best, l) => (best === undefined || Math.abs(l - line) < Math.abs(best - line) ? l : best), undefined)

/**
 * Where line `line` of `path` sits after the change `git diff` printed as `patch`. Undefined when the file went or the
 * line was rewritten into a different number of lines; a same-size rewrite keeps its place, since a comment on it
 * usually still applies.
 */
export const moveLine = (patch: string, path: string, line: number): { path: string; line: number } | undefined => {
  const file = parseDiff(patch).find((f) => pathOf(f.oldFileName) === path)
  if (!file) return { path, line }
  const to = pathOf(file.newFileName)
  if (!to) return undefined
  let shift = 0
  for (const h of file.hunks) {
    // An empty side's start already names the line after it.
    let [o, n] = [h.oldStart, h.newStart]
    if (line < o) return { path: to, line: line + shift }
    const ls = h.lines
    for (let i = 0; i < ls.length; i++) {
      const c = ls[i]![0]
      if (c === ' ') {
        if (o === line) return { path: to, line: n }
        o++, n++
      } else if (c === '+') n++
      else if (c === '-') {
        let k = 0
        while (ls[i + k]?.[0] === '-') k++
        let a = 0
        while (ls[i + k + a]?.[0] === '+') a++
        if (line >= o && line < o + k) return k === a ? { path: to, line: n + line - o } : undefined
        o += k
        n += a
        i += k + a - 1
      }
    }
    shift = n - o
  }
  return { path: to, line: line + shift }
}
