import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import type { Decision, DecisionState, PrRef, Rereview, StackEntry, StackEntryStatus, StackOverview } from '@pr-review/domain'
import { useHotkeys } from '@tanstack/react-hotkeys'
import { AsyncResult } from 'effect/reactivity'
import { useMemo, useState } from 'react'
import { useAtoms } from '../atoms.ts'
import { cn } from '../lib/utils.ts'
import { useRemembered } from '../remembered.ts'
import { failureOf, isUnavailable } from '../result.ts'
import { ChatPanel } from '../review/ChatPanel.tsx'
import { ItemView } from '../review/ItemView.tsx'
import { ReviewPopover } from '../review/ReviewPopover.tsx'
import { useDrafts } from '../review/drafts.ts'
import { description, type Item, itemId, itemsOf, itemTitle, itemTone } from '../review/items.ts'
import { Setup } from '../Setup.tsx'
import { Button, Dot, Kbd, Spinner } from '../ui/index.tsx'
import { dependentsOf } from './dependents.ts'
import { Overview, PrLine, shortTitle } from './Overview.tsx'

const lensOrder = { architecture: 0, quality: 1, ui: 2 } as const

type Row = { key: string; pr: StackEntry; item: Item }
const decisionOf = (r: Row | undefined): Decision | undefined => (r?.item.kind === 'decision' ? r.item.decision : undefined)
type Selection = { kind: 'overview' } | { kind: 'pr'; pr: number } | { kind: 'decision'; key: string }
const prHash = (ref: PrRef, number: number) => `#/pr/${ref.host}/${ref.owner}/${ref.repo}/${number}`

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
  return <Loaded prRef={prRef} entries={stack.value.entries} overview={stack.value.overview} overviewError={stack.value.overviewError} />
}

function Loaded({ prRef, entries, overview, overviewError }: { prRef: PrRef; entries: ReadonlyArray<StackEntryStatus>; overview: StackOverview | null; overviewError?: string | undefined }) {
  const { stateAtom } = useAtoms()
  const saveState = useAtomSet(stateAtom)
  // Stack order; inside a PR decisions (architecture first), then skim areas and trusted groups.
  const ordered = useMemo(
    () =>
      entries.flatMap((e) =>
        [...(e.pr.hasBody ? [description] : []), ...(e.result ? itemsOf(e.result, (ds) => [...ds].sort((a, b) => lensOrder[a.lens] - lensOrder[b.lens])) : [])].map(
          (item): Row => ({ key: `${e.pr.number}:${item.key}`, pr: e.pr, item }),
        ),
      ),
    [entries],
  )
  const rowsOf = (pr: number) => ordered.filter((r) => r.pr.number === pr)

  const [stored, setSel] = useRemembered<Selection>(`at:stack:${prRef.host}/${prRef.owner}/${prRef.repo}#${prRef.number}`, { kind: 'overview' })
  // A remembered item can be gone after a push re-sorted its PR.
  const gone = stored.kind === 'decision' ? !ordered.some((r) => r.key === stored.key) : stored.kind === 'pr' && !entries.some((e) => e.pr.number === stored.pr)
  const sel: Selection = gone ? { kind: 'overview' } : stored
  const [overrides, setOverrides] = useState<Record<string, DecisionState | null>>({})
  const [commenting, setCommenting] = useState<string>()
  const [chatOpen, setChatOpen] = useState(false)
  const [chatFocus, setChatFocus] = useState(0)

  const verdictOf = (r: Row): DecisionState | undefined => {
    const id = itemId(r.item)
    if (id === undefined) return undefined
    return r.key in overrides ? (overrides[r.key] ?? undefined) : entries.find((e) => e.pr.number === r.pr.number)?.state[id]
  }
  const rereviewOf = (r: Row) => entries.find((e) => e.pr.number === r.pr.number)?.rereview?.[itemId(r.item) ?? '']
  const reviewable = ordered.filter((r) => itemId(r.item) !== undefined)
  const [reviewOpen, setReviewOpen] = useState(false)
  const index = sel.kind === 'decision' ? ordered.findIndex((r) => r.key === sel.key) : -1
  const row = ordered[index]
  const decision = decisionOf(row)
  const activePr = sel.kind === 'pr' ? sel.pr : row?.pr.number
  const { drafts } = useDrafts({ ...prRef, number: activePr ?? prRef.number })
  const prIndex = entries.findIndex((e) => e.pr.number === activePr)
  const progress = (pr: number) => {
    const rs = rowsOf(pr).filter((r) => itemId(r.item) !== undefined)
    return { decided: rs.filter((r) => verdictOf(r)).length, total: rs.length }
  }

  const go = (next: Selection) => {
    setSel(next)
    setCommenting(undefined)
    setReviewOpen(false)
  }
  const goRow = (i: number) => (i < 0 ? go({ kind: 'overview' }) : ordered[i] && go({ kind: 'decision', key: ordered[i].key }))
  /** A PR opens on its first item until reviewing it has started, then on its first open item; an empty PR shows its card. */
  const goPr = (pr: number) => {
    const rs = rowsOf(pr)
    const reviewable = rs.filter((r) => itemId(r.item) !== undefined)
    const started = reviewable.some((r) => verdictOf(r))
    const target = started ? (reviewable.find((r) => !verdictOf(r)) ?? reviewable[0]) : rs[0]
    go(target ? { kind: 'decision', key: target.key } : { kind: 'pr', pr })
  }
  const stepPr = (by: number) => {
    const i = prIndex + by
    if (i < 0) return go({ kind: 'overview' })
    if (entries[i]) goPr(entries[i].pr.number)
  }
  const nextRow = () => {
    if (sel.kind === 'pr') {
      const after = ordered.findIndex((r) => entries.findIndex((e) => e.pr.number === r.pr.number) > prIndex)
      return after >= 0 ? goRow(after) : undefined
    }
    goRow(index + 1)
  }
  /** The next open item in the same PR, wrapping; -1 when the PR has none left. */
  const nextOpenInPr = (from: number, skip: string) => {
    for (let step = 1; step <= ordered.length; step++) {
      const r = ordered[(from + step) % ordered.length]!
      if (r.pr.number === ordered[from]!.pr.number && r.key !== skip && itemId(r.item) !== undefined && !verdictOf(r)) return (from + step) % ordered.length
    }
    return -1
  }

  const verdict = (state: DecisionState) => {
    const id = row && itemId(row.item)
    if (!row || id === undefined) return
    const next = verdictOf(row) === state ? null : state
    setOverrides((o) => ({ ...o, [row.key]: next }))
    saveState({ ref: { ...prRef, number: row.pr.number }, headSha: row.pr.headSha, decisionId: id, state: next })
    return next
  }
  /** Accepting moves to the PR's next open item; after its last one, to the PR's review when it has comments to send, else on to the next PR. */
  const accept = () => {
    if (verdict('accepted') !== 'accepted') return
    const next = nextOpenInPr(index, row!.key)
    if (next >= 0) goRow(next)
    else if (drafts.length) setReviewOpen(true)
    else stepPr(1)
  }
  const pushBack = () => {
    if (!row || !decision) return
    if (verdictOf(row) !== 'pushed-back') verdict('pushed-back')
    setCommenting(row.key)
  }
  const discuss = () => {
    if (!decision) return
    setChatOpen(true)
    setChatFocus((n) => n + 1)
  }

  useHotkeys([
    { hotkey: 'J', callback: nextRow },
    { hotkey: 'K', callback: () => (sel.kind === 'decision' ? goRow(index - 1) : stepPr(-1)) },
    { hotkey: ']', callback: () => stepPr(1) },
    { hotkey: '[', callback: () => stepPr(-1) },
    { hotkey: 'A', callback: accept },
    { hotkey: 'P', callback: pushBack },
    { hotkey: '/', callback: discuss, options: { preventDefault: true } },
    { hotkey: 'Mod+J', callback: () => (chatOpen ? setChatOpen(false) : discuss()), options: { ignoreInputs: false, preventDefault: true } },
    { hotkey: 'Enter', callback: () => activePr !== undefined && (location.hash = prHash(prRef, activePr)) },
    { hotkey: 'Escape', callback: () => (commenting ? setCommenting(undefined) : setChatOpen(false)), options: { ignoreInputs: false } },
  ])

  const bottom = entries[0]?.pr
  const results = entries.flatMap((e) => (e.result ? [e.result] : []))
  const lines = results.reduce((n, r) => n + r.lines.decision + r.lines.skim + r.lines.trusted, 0)
  const sorted = entries.filter((e) => e.status === 'done').length
  const failed = entries.filter((e) => e.status === 'failed')
  const decided = reviewable.filter((r) => verdictOf(r)).length
  const files = entries.map((e) => ({ pr: e.pr, files: e.result ? [...e.result.decisions.flatMap((d) => d.files.map((f) => f.path)), ...e.result.skim.flatMap((s) => s.files)] : [] }))
  const active = entries[prIndex]

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
          {decided} / {reviewable.length} reviewed
          <i className="block h-1 w-16 overflow-hidden rounded-sm bg-border">
            <b className="block h-full bg-ok" style={{ width: `${reviewable.length ? (decided / reviewable.length) * 100 : 0}%` }} />
          </i>
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Stack" className="w-80 shrink-0 overflow-y-auto border-r border-border bg-card px-1.5 py-2">
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
            const { decided: d, total } = progress(n)
            const isActive = activePr === n
            return (
              <div key={n}>
                <button
                  type="button"
                  aria-current={sel.kind === 'pr' && isActive}
                  title={e.pr.title}
                  onClick={() => goPr(n)}
                  className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-accent/60', isActive && 'text-foreground')}
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
                    total > 0 && <span className={cn('shrink-0 text-xs tabular-nums', d === total ? 'text-ok' : 'text-dim')}>{`${d}/${total}`}</span>
                  )}
                </button>
                {isActive && rowsOf(n).length > 0 && (
                  <div role="group" aria-label={`#${n}`} className="mb-1 ml-6 border-l border-border pl-1">
                    {rowsOf(n).map((r) => (
                      <button
                        key={r.key}
                        type="button"
                        aria-current={row?.key === r.key}
                        onClick={() => go({ kind: 'decision', key: r.key })}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent/60',
                          row?.key === r.key && 'bg-accent text-foreground',
                        )}
                      >
                        <Dot tone={itemTone(r.item, verdictOf(r), rereviewOf(r) !== undefined)} />
                        <span className="min-w-0 flex-1 truncate">{itemTitle(r.item)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
        <main key={sel.kind === 'decision' ? sel.key : sel.kind === 'pr' ? `pr:${sel.pr}` : 'overview'} className="min-w-0 flex-1 overflow-y-auto">
          {failed.length > 0 && (
            <p role="alert" className="border-b border-border bg-destructive/10 px-5 py-1.5 text-sm">
              {failed.length === 1 ? `#${failed[0]!.pr.number} could not be sorted` : `${failed.length} PRs could not be sorted`}: {failed[0]!.error}
            </p>
          )}
          {sel.kind === 'overview' && <Overview prRef={prRef} entries={entries} overview={overview} overviewError={overviewError} progress={progress} onOpen={goPr} onOpenDecision={(pr, id) => (ordered.some((r) => r.key === `${pr}:d:${id}`) ? go({ kind: 'decision', key: `${pr}:d:${id}` }) : goPr(pr))} />}
          {active && sel.kind !== 'overview' && (
            <PrBar prRef={prRef} entry={active} position={prIndex + 1} count={entries.length} dependents={row && decision ? dependentsOf(decision, row.pr.number, files) : []} onStep={stepPr} reviewOpen={reviewOpen} onReviewOpenChange={setReviewOpen} onSent={() => stepPr(1)} />
          )}
          {sel.kind === 'pr' && active && <PrCard entry={active} />}
          {row && (
            <StackItem
              prRef={prRef}
              row={row}
              verdict={verdictOf(row)}
              rereview={rereviewOf(row)}
              commenting={commenting === row.key}
              onAccept={accept}
              onPushBack={pushBack}
              onDiscuss={discuss}
              onCommentDone={() => setCommenting(undefined)}
              {...(index < ordered.length - 1 ? { onNext: nextRow } : {})}
            />
          )}
        </main>
        {chatOpen && row && decision && <ChatPanel key={row.key} prRef={{ ...prRef, number: row.pr.number }} headSha={row.pr.headSha} decision={decision} focus={chatFocus} />}
      </div>
      <footer className="flex h-8 shrink-0 items-center gap-3.5 border-t border-border px-3 text-xs text-dim">
        <span className="flex items-center gap-1">
          <Kbd>[</Kbd>
          <Kbd>]</Kbd> previous / next PR
        </span>
        <span className="flex items-center gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> next / previous item
        </span>
        <span className="flex items-center gap-1">
          <Kbd>a</Kbd> accept
        </span>
        <span className="flex items-center gap-1">
          <Kbd>p</Kbd> push back
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⌘J</Kbd> discuss
        </span>
        <span className="flex items-center gap-1">
          <Kbd>enter</Kbd> open the PR
        </span>
      </footer>
    </div>
  )
}

/** Which PR the pane is in and what it does, with a step to its neighbours. */
function PrBar(props: {
  prRef: PrRef
  entry: StackEntryStatus
  position: number
  count: number
  dependents: number[]
  onStep: (by: number) => void
  reviewOpen: boolean
  onReviewOpenChange: (open: boolean) => void
  onSent: () => void
}) {
  const { entry } = props
  const { prAtom } = useAtoms()
  const ref = { ...props.prRef, number: entry.pr.number }
  const pr = useAtomValue(prAtom(ref))
  return (
    <div className="border-b border-border bg-card px-5 py-2">
      <div className="mx-auto flex max-w-[60rem] items-start gap-3">
        <div className="min-w-0 flex-1 text-sm">
          <p className="flex gap-2">
            <span className="shrink-0 text-dim">
              PR {props.position} of {props.count}
            </span>
            <a href={prHash(props.prRef, entry.pr.number)} className="min-w-0 truncate font-medium hover:underline">
              #{entry.pr.number} {shortTitle(entry.pr.title)}
            </a>
          </p>
          <p className="text-muted-foreground">
            <PrLine entry={entry} />
            {props.dependents.length > 0 && <span className="text-dim"> · This decision affects {props.dependents.map((n) => `#${n}`).join(', ')}</span>}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="ghost" onClick={() => props.onStep(-1)}>
            Previous PR <Kbd className="border-none bg-transparent">[</Kbd>
          </Button>
          <Button size="xs" variant="ghost" disabled={props.position === props.count} onClick={() => props.onStep(1)}>
            Next PR <Kbd className="border-none bg-transparent">]</Kbd>
          </Button>
          {AsyncResult.isSuccess(pr) && <ReviewPopover prRef={ref} pr={pr.value} open={props.reviewOpen} onOpenChange={props.onReviewOpenChange} onSent={props.onSent} />}
        </span>
      </div>
    </div>
  )
}

/** A PR not sorted yet, or with no changes to show. */
function PrCard({ entry }: { entry: StackEntryStatus }) {
  return (
    <article className="mx-auto max-w-[60rem] px-5 py-4 text-muted-foreground">
      <p>{entry.status === 'done' ? 'Nothing to review in this PR.' : 'Its changes show here once it is sorted.'}</p>
    </article>
  )
}

function StackItem(props: {
  prRef: PrRef
  row: Row
  verdict: DecisionState | undefined
  rereview: Rereview[string] | undefined
  commenting: boolean
  onAccept: () => void
  onPushBack: () => void
  onDiscuss: () => void
  onCommentDone: () => void
  onNext?: () => void
}) {
  const { prAtom } = useAtoms()
  const { row } = props
  const ref = { ...props.prRef, number: row.pr.number }
  const pr = useAtomValue(prAtom(ref))
  const retry = useAtomRefresh(prAtom(ref))
  if (AsyncResult.isFailure(pr)) {
    const e = failureOf(pr)
    return (
      <div role="alert" className="mx-auto flex max-w-[60rem] items-center gap-3 px-5 py-4">
        <p className="text-destructive">
          #{row.pr.number} could not be loaded: {e && 'message' in e ? String(e.message) : 'the companion failed while reading it'}.
        </p>
        <Button size="xs" variant="outline" onClick={retry}>
          Try again
        </Button>
      </div>
    )
  }
  if (!AsyncResult.isSuccess(pr))
    return (
      <p className="flex items-center gap-2 px-5 py-4 text-muted-foreground">
        <Spinner className="size-3" /> Fetching #{row.pr.number}…
      </p>
    )
  return (
    <ItemView
      prRef={ref}
      pr={pr.value}
      item={row.item}
      verdict={props.verdict}
      rereview={props.rereview}
      commenting={props.commenting}
      onAccept={props.onAccept}
      onPushBack={props.onPushBack}
      onDiscuss={props.onDiscuss}
      onCommentDone={props.onCommentDone}
      {...(props.onNext ? { onNext: props.onNext } : {})}
    />
  )
}
