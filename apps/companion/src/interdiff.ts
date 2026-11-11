/** True when two patches make the same change, whatever base they sit on: blob hashes and hunk line numbers are ignored. */
export const sameChange = (a: string, b: string) => normalizePatch(a) === normalizePatch(b)

const normalizePatch = (patch: string) =>
  patch
    .split('\n')
    .filter((l) => !l.startsWith('index '))
    .map((l) => l.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, '@@'))
    .join('\n')

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

/** New-side line ranges per file: the lines GitHub accepts a review comment on. */
export const hunkLines = (patch: string) => {
  const files = new Map<string, Array<[number, number]>>()
  let current: Array<[number, number]> | undefined
  let header = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) [current, header] = [undefined, true]
    else if (header && line.startsWith('+++ ')) {
      current = line === '+++ /dev/null' ? undefined : []
      if (current) files.set(line.slice('+++ b/'.length), current)
    } else {
      const m = HUNK.exec(line)
      if (!m) continue
      header = false
      const [start, count] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2])]
      if (count > 0) current?.push([start, start + count - 1])
    }
  }
  return files
}

/** The line in `ranges` nearest to `line`, or undefined when there are none. */
export const nearestLine = (ranges: ReadonlyArray<readonly [number, number]>, line: number) =>
  ranges.map(([from, to]) => Math.min(Math.max(line, from), to)).reduce<number | undefined>((best, l) => (best === undefined || Math.abs(l - line) < Math.abs(best - line) ? l : best), undefined)

/**
 * Where line `line` of `path` sits after the change `git diff` printed as `patch`. Undefined when the file went or the
 * line was rewritten into a different number of lines; a same-size rewrite keeps its place, since a comment on it
 * usually still applies.
 */
export const moveLine = (patch: string, path: string, line: number): { path: string; line: number } | undefined => {
  for (const section of patch.split(/^diff --git /m).slice(1)) {
    const ls = section.split('\n')
    const field = (prefix: string) => ls.find((l) => l.startsWith(prefix))?.slice(prefix.length)
    if ((field('--- a/') ?? field('rename from ')) !== path) continue
    if (ls.includes('+++ /dev/null')) return undefined
    const to = field('+++ b/') ?? field('rename to ') ?? path
    let shift = 0
    for (let i = 0; i < ls.length; i++) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(ls[i]!)
      if (!m) continue
      // An empty side names the line before it.
      let o = Number(m[1]) + (m[2] === '0' ? 1 : 0)
      let n = Number(m[3]) + (m[4] === '0' ? 1 : 0)
      if (line < o) return { path: to, line: line + shift }
      for (i++; i < ls.length && /^[ +\-\\]/.test(ls[i]!); i++) {
        const l = ls[i]!
        if (l[0] === ' ') {
          if (o === line) return { path: to, line: n }
          o++, n++
        } else if (l[0] === '+') n++
        else if (l[0] === '-') {
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
      i--
      shift = n - o
    }
    return { path: to, line: line + shift }
  }
  return { path, line }
}
