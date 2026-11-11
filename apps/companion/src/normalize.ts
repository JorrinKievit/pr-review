import type { AgentSort, FileStat, SortResult, TrustedGroup } from '@pr-review/domain'
import { neverTrusted } from './trusted.ts'

/**
 * Make the agent's sort safe to show: real paths only, every file placed. Claude decides what is trusted; rule
 * candidates it left unplaced keep their rule group, and paths that always need a human never are. When in doubt, up a pile.
 */
export function normalize(agent: AgentSort, files: ReadonlyArray<FileStat>, candidates: ReadonlyArray<TrustedGroup>, headSha: string, never: ReadonlyArray<string> = [], mergeBase?: string): SortResult {
  const known = new Set(files.map((f) => f.path))

  const decisions = agent.decisions
    .map((d) => ({ ...d, files: d.files.filter((x) => known.has(x.path)) }))
    .filter((d) => d.files.length > 0)
  const inDecision = new Set(decisions.flatMap((d) => d.files.map((x) => x.path)))

  const skim = agent.skim
    .map((s) => ({ ...s, files: s.files.filter((p) => known.has(p) && !inDecision.has(p)) }))
    .filter((s) => s.files.length > 0)
  const inSkim = new Set(skim.flatMap((s) => s.files))
  const claimed = new Set<string>()
  const keep = (groups: ReadonlyArray<TrustedGroup>) =>
    groups
      .map((t) => ({ ...t, files: t.files.filter((p) => known.has(p) && !inDecision.has(p) && !inSkim.has(p) && !neverTrusted(p, never) && !claimed.has(p) && claimed.add(p)) }))
      .filter((t) => t.files.length > 0)
  // Claude's groups first, so a candidate it placed itself takes its grouping and reason.
  const byClaude = keep(agent.trusted ?? [])
  const trustedOut = [...keep(candidates), ...byClaude]

  const placed = new Set([...inDecision, ...inSkim, ...claimed])
  const unplaced = files.map((f) => f.path).filter((p) => !placed.has(p))
  if (unplaced.length) skim.push({ area: 'Unsorted', summary: 'Not placed by the sort.', files: unplaced })

  const ids = new Set(decisions.map((d) => d.id))
  const claims = agent.claims.map((c) => ({ ...c, decisionIds: c.decisionIds.filter((id) => ids.has(id)) }))
  const covered = new Set(claims.flatMap((c) => c.decisionIds))
  const unclaimedDecisionIds = claims.length ? decisions.map((d) => d.id).filter((id) => !covered.has(id)) : []

  const size = new Map(files.map((f) => [f.path, f.additions + f.deletions]))
  const sum = (paths: Iterable<string>) => [...paths].reduce((n, p) => n + (size.get(p) ?? 0), 0)

  return {
    headSha,
    ...(mergeBase ? { mergeBase } : {}),
    ...(agent.summary ? { summary: agent.summary } : {}),
    decisions,
    skim,
    trusted: trustedOut,
    claims,
    unclaimedDecisionIds,
    lines: {
      decision: sum(inDecision),
      skim: sum(skim.flatMap((s) => s.files)),
      trusted: sum(trustedOut.flatMap((t) => t.files)),
    },
  }
}
