import { useAtomValue } from '@effect/atom-react'
import type { PrRef, StackEntryStatus, StackEvent, StackOverview } from '@pr-review/domain'
import { useHotkeys } from '@tanstack/react-hotkeys'
import { AsyncResult } from 'effect/reactivity'
import { useState } from 'react'
import { useAtoms } from '../atoms.ts'
import { cn } from '../lib/utils.ts'
import { useRemembered } from '../remembered.ts'
import { failureOf, isUnavailable } from '../result.ts'
import { ReviewPage } from '../review/ReviewPage.tsx'
import { itemId, itemsOf } from '../review/items.ts'
import { Setup } from '../Setup.tsx'
import { Kbd, Spinner } from '../ui/index.tsx'
import { Overview, shortTitle } from './Overview.tsx'

type Selection = { kind: 'overview' } | { kind: 'pr'; pr: number; focus?: string }

export function StackPage({ prRef }: { prRef: PrRef }) {
  const { stackAtom } = useAtoms()
  const stack = useAtomValue(stackAtom(prRef))
  const error = failureOf(stack)
  if (isUnavailable(error)) return <Setup prRef={prRef} reason={error.reason} />
  if (AsyncResult.isFailure(stack))
    return (
      <main className="mx-auto mt-24 max-w-[34rem] px-6">
        <h1 className="mb-2 text-lg font-medium">This stack could not be loaded</h1>
        <p className="text-muted-foreground">{error && 'message' in error ? String(error.message) : 'The companion failed while reading the stack.'}</p>
      </main>
    )
  if (!AsyncResult.isSuccess(stack))
    return (
      <main className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Spinner /> Finding the stack for #{prRef.number}…
      </main>
    )
  return <Loaded prRef={prRef} entries={stack.value.entries} overview={stack.value.overview} overviewError={stack.value.overviewError} stackOpinion={stack.value.stackOpinion} />
}

/** The stack's PRs beside either the overview or a PR's own review page, so a PR reads the same in both. */
function Loaded({ prRef, entries, overview, overviewError, stackOpinion }: { prRef: PrRef; entries: ReadonlyArray<StackEntryStatus>; overview: StackOverview | null; overviewError?: string | undefined; stackOpinion?: StackEvent['stackOpinion'] }) {
  const [stored, setSel] = useRemembered<Selection>(`at:stack:${prRef.host}/${prRef.owner}/${prRef.repo}#${prRef.number}`, { kind: 'overview' })
  // A remembered PR can be merged since, and older versions remembered an item instead.
  const sel: Selection = stored.kind === 'pr' && entries.some((e) => e.pr.number === stored.pr) ? stored : { kind: 'overview' }
  const prIndex = sel.kind === 'pr' ? entries.findIndex((e) => e.pr.number === sel.pr) : -1
  // What the open review page reports beats the stack's saved verdicts, which only refresh with the stack.
  const [live, setLive] = useState<Record<number, { decided: number; total: number }>>({})

  const progress = (pr: number) => {
    if (live[pr]) return live[pr]
    const e = entries.find((x) => x.pr.number === pr)
    const ids = e?.result ? itemsOf(e.result, (ds) => ds).flatMap((i) => itemId(i) ?? []) : []
    return { decided: ids.filter((id) => e!.state[id]).length, total: ids.length }
  }
  const go = (next: Selection) => setSel(next)
  const stepPr = (by: number) => {
    const i = prIndex + by
    if (i < 0) return go({ kind: 'overview' })
    if (entries[i]) go({ kind: 'pr', pr: entries[i].pr.number })
  }

  useHotkeys([
    { hotkey: ']', callback: () => stepPr(1) },
    { hotkey: '[', callback: () => stepPr(-1) },
  ])

  const bottom = entries[0]?.pr
  const lines = entries.reduce((n, e) => n + (e.result ? e.result.lines.decision + e.result.lines.skim + e.result.lines.trusted : 0), 0)
  const sorted = entries.filter((e) => e.status === 'done').length
  const failed = entries.filter((e) => e.status === 'failed')
  const totals = entries.map((e) => progress(e.pr.number))
  const decided = totals.reduce((n, p) => n + p.decided, 0)
  const total = totals.reduce((n, p) => n + p.total, 0)
  const changed = entries.reduce((n, e) => n + Object.keys(e.rereview ?? {}).length, 0)

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border px-3 text-sm text-muted-foreground">
        <span>
          {prRef.owner}/{prRef.repo}
        </span>
        <span aria-hidden>›</span>
        <b className="min-w-0 truncate font-medium text-foreground">Stack: {bottom?.title}</b>
        <span>
          {entries.length} PRs · {lines} lines
        </span>
        <span className="ml-auto flex items-center gap-2">
          {sorted < entries.length && `${sorted} / ${entries.length} sorted · `}
          {decided} / {total} reviewed
          <i className="block h-1 w-16 overflow-hidden rounded-sm bg-border">
            <b className="block h-full bg-ok" style={{ width: `${total ? (decided / total) * 100 : 0}%` }} />
          </i>
        </span>
      </header>
      {failed.length > 0 && (
        <p role="alert" className="border-b border-border bg-destructive/10 px-5 py-1.5 text-sm">
          {failed.length === 1 ? `#${failed[0]!.pr.number} could not be sorted` : `${failed.length} PRs could not be sorted`}: {failed[0]!.error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Stack" className="flex w-56 shrink-0 flex-col border-r border-border bg-card px-1.5 py-2">
          {changed > 0 && <p className="mx-2 mb-1 text-xs text-warn">{`${changed} ${changed === 1 ? 'decision' : 'decisions'} changed since you looked`}</p>}
          <button
            type="button"
            aria-current={sel.kind === 'overview'}
            onClick={() => go({ kind: 'overview' })}
            className={cn('mb-1 w-full rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-accent/60', sel.kind === 'overview' && 'bg-accent text-foreground')}
          >
            Overview
          </button>
          {entries.map((e, i) => {
            const n = e.pr.number
            const { decided: d, total: t } = progress(n)
            const isActive = sel.kind === 'pr' && sel.pr === n
            return (
              <button
                key={n}
                type="button"
                aria-current={isActive}
                title={e.pr.title}
                onClick={() => go({ kind: 'pr', pr: n })}
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-accent/60', isActive && 'bg-accent text-foreground')}
              >
                <span className="w-4 shrink-0 text-right text-xs text-dim tabular-nums">{i + 1}</span>
                <span className="shrink-0 text-xs text-dim">#{n}</span>
                <span className="min-w-0 flex-1 truncate">{shortTitle(e.pr.title)}</span>
                {e.status === 'running' ? (
                  <Spinner className="size-3 shrink-0" />
                ) : e.status === 'failed' ? (
                  <span className="shrink-0 text-xs text-destructive">failed</span>
                ) : e.status === 'queued' ? (
                  <span className="shrink-0 text-xs text-dim">queued</span>
                ) : (
                  t > 0 && <span className={cn('shrink-0 text-xs tabular-nums', d === t ? 'text-ok' : 'text-dim')}>{`${d}/${t}`}</span>
                )}
              </button>
            )
          })}
          <p className="mt-auto flex items-center gap-1 px-2 pt-2 text-xs text-dim">
            <Kbd>[</Kbd>
            <Kbd>]</Kbd> previous / next PR
          </p>
        </nav>
        {sel.kind === 'pr' ? (
          <div className="min-w-0 flex-1">
            <ReviewPage
              key={sel.pr}
              prRef={{ ...prRef, number: sel.pr }}
              focus={sel.focus}
              onProgress={(d, t) => setLive((l) => (l[sel.pr]?.decided === d && l[sel.pr]?.total === t ? l : { ...l, [sel.pr]: { decided: d, total: t } }))}
            />
          </div>
        ) : (
          <main className="min-w-0 flex-1 overflow-y-auto">
            <Overview
              prRef={prRef}
              entries={entries}
              overview={overview}
              overviewError={overviewError}
              stackOpinion={stackOpinion}
              progress={progress}
              onOpen={(pr) => go({ kind: 'pr', pr })}
              onOpenDecision={(pr, id) => go({ kind: 'pr', pr, focus: `d:${id}` })}
            />
          </main>
        )}
      </div>
    </div>
  )
}
