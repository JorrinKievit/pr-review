import type { SortResult, StackEntryStatus, StackOverview } from '@pr-review/domain'
import { cn } from '../lib/utils.ts'
import { Spinner, Working } from '../ui/index.tsx'

const panels = [
  ['tables', 'Tables'],
  ['modules', 'Modules'],
  ['endpoints', 'Endpoints'],
  ['sharedLayers', 'Shared layers'],
] as const

/** "company_group: new entity…" splits into the thing and what changed; a line without a short lead-in stays whole. */
const split = (line: string) => {
  const at = line.indexOf(': ')
  return at > 0 && at <= 60 ? { name: line.slice(0, at), what: line.slice(at + 2) } : undefined
}

/** Titles in a stack share a conventional-commit prefix ("feat(console): "); without it they can be told apart. */
export const shortTitle = (title: string) => title.replace(/^\w+(\([^)]*\))?!?:\s*/, '')

/** Under a PR's title: what it does (Claude's summary, else the author's opening paragraph), then what its sort is doing. */
export function PrLine({ entry }: { entry: StackEntryStatus }) {
  const what = entry.result?.summary ?? entry.pr.description
  return (
    <>
      {what && <span className="block">{what}</span>}
      {entry.status === 'running' && <Working step={entry.step} />}
      {entry.status === 'failed' && <span className="block text-destructive">{entry.error ?? 'Could not be sorted'}</span>}
    </>
  )
}

/** The stack at a glance: every PR bottom to top with what it does, then what the whole stack changes. */
export function Overview(props: {
  entries: ReadonlyArray<StackEntryStatus>
  overview: StackOverview | null
  overviewError?: string | undefined
  progress: (pr: number) => { decided: number; total: number }
  onOpen: (pr: number) => void
}) {
  const results: SortResult[] = props.entries.flatMap((e) => (e.result ? [e.result] : []))
  const pending = props.entries.some((e) => e.status === 'queued' || e.status === 'running')
  const decisions = results.reduce((n, r) => n + r.decisions.length, 0)
  const unclaimed = results.reduce((n, r) => n + r.unclaimedDecisionIds.length, 0)
  const { overview } = props
  return (
    <article className="mx-auto max-w-[60rem] px-5 py-4">
      <h2 className="mb-3 text-lg font-medium">Overview</h2>
      <ol aria-label="PRs in this stack" className="mb-6 flex flex-col gap-1">
        {props.entries.map((e, i) => {
          const { decided, total } = props.progress(e.pr.number)
          return (
            <li key={e.pr.number}>
              <button
                type="button"
                onClick={() => props.onOpen(e.pr.number)}
                className="flex w-full items-start gap-3 rounded-lg border border-transparent px-3 py-2 text-left hover:border-border hover:bg-card"
              >
                <span className="mt-0.5 w-5 shrink-0 text-right text-sm text-dim tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex gap-2">
                    <span className="text-dim">#{e.pr.number}</span>
                    <span className="truncate font-medium" title={e.pr.title}>
                      {shortTitle(e.pr.title)}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-sm text-muted-foreground">
                    <PrLine entry={e} />
                  </span>
                </span>
                <span className={cn('mt-0.5 shrink-0 text-sm tabular-nums', e.status === 'done' && total && decided === total ? 'text-ok' : 'text-muted-foreground')}>
                  {e.status === 'done' ? (total ? `${decided} / ${total}` : 'nothing to review') : e.status === 'running' ? 'sorting' : e.status}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      {overview ? (
        <>
          <h2 className="mb-2 text-lg font-medium">What the stack changes</h2>
          <p className="mb-5 max-w-[70ch] leading-relaxed">{overview.summary}</p>
          {panels.map(([key, label]) =>
            overview[key].length === 0 ? null : (
              <section key={key} aria-label={label} className="mb-5">
                <h3 className="mb-1 text-sm text-dim">
                  {label} <span className="tabular-nums">{overview[key].length}</span>
                </h3>
                <dl className="grid grid-cols-1 border-t border-border sm:grid-cols-[minmax(0,16rem)_1fr]">
                  {overview[key].flatMap((v) => {
                    const parts = split(v)
                    return parts
                      ? [
                          <div key={v} className="contents">
                            <dt className="border-b border-border pt-2 font-mono text-sm break-words sm:py-2 sm:pr-4">{parts.name}</dt>
                            <dd className="border-b border-border pb-2 text-muted-foreground sm:py-2">{parts.what}</dd>
                          </div>,
                        ]
                      : []
                  })}
                </dl>
                {overview[key]
                  .filter((v) => !split(v))
                  .map((v) => (
                    <p key={v} className="border-b border-border py-2 text-muted-foreground">
                      {v}
                    </p>
                  ))}
              </section>
            ),
          )}
        </>
      ) : props.overviewError ? (
        <p className="mb-4 text-muted-foreground">No stack summary: {props.overviewError.replace(/\.$/, '')}. Reload the page to try again.</p>
      ) : pending || results.length > 0 ? (
        <p className="mb-4 flex items-center gap-2 text-muted-foreground">
          <Spinner className="size-3" /> {pending ? 'The stack summary follows once every PR is sorted.' : 'Writing the stack summary…'}
        </p>
      ) : (
        <p className="mb-4 text-muted-foreground">No stack summary: no PR in the stack could be sorted.</p>
      )}
      <p className="text-sm text-muted-foreground">
        Author's decisions: {decisions - unclaimed} listed · {unclaimed} not in the list
      </p>
    </article>
  )
}
