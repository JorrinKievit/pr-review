/** True when two patches make the same change, whatever base they sit on: blob hashes and hunk line numbers are ignored. */
export const sameChange = (a: string, b: string) => normalizePatch(a) === normalizePatch(b)

const normalizePatch = (patch: string) =>
  patch
    .split('\n')
    .filter((l) => !l.startsWith('index '))
    .map((l) => l.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, '@@'))
    .join('\n')
