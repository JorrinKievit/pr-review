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
