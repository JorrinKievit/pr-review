import type { Checks, FileStat, TrustedGroup, TrustRule } from '@pr-review/domain'
import { matchesGlob } from 'node:path'

const matches = (path: string, globs: ReadonlyArray<string>) => globs.some((g) => matchesGlob(path, g))

export const neverTrusted = matches

/** The rule group a path is a candidate for; the agent has the final say. */
export const trustedGroup = (path: string, rules: ReadonlyArray<TrustRule>, never: ReadonlyArray<string>): string | null =>
  matches(path, never) ? null : (rules.find((r) => matches(path, r.patterns))?.group ?? null)

export function buildTrusted(files: ReadonlyArray<FileStat>, checks: Checks, rules: ReadonlyArray<TrustRule>, never: ReadonlyArray<string>): { groups: TrustedGroup[]; rest: FileStat[] } {
  const by = new Map<string, string[]>()
  const rest: FileStat[] = []
  for (const f of files) {
    const g = trustedGroup(f.path, rules, never)
    if (g) by.set(g, [...(by.get(g) ?? []), f.path])
    else rest.push(f)
  }
  return { groups: rules.flatMap((r) => (by.has(r.group) ? [{ group: r.group, why: `CI checks: ${checks}`, files: by.get(r.group)! }] : [])), rest }
}
