import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import type { DecisionState, DecisionStates, OpinionEvent, PrRef, PrView, ReviewEvent } from '@pr-review/domain'
import { useHotkeys } from '@tanstack/react-hotkeys'
import { AsyncResult } from 'effect/reactivity'
import { useContext, useEffect, useMemo, useState } from 'react'
import { useAtoms } from '../atoms.ts'
import { useRemembered } from '../remembered.ts'
import { failureOf, isUnavailable } from '../result.ts'
import { Setup } from '../Setup.tsx'
import { CommandPalette } from '../shell/CommandPalette.tsx'
import { FooterHints } from '../shell/FooterHints.tsx'
import { Sidebar } from '../shell/Sidebar.tsx'
import { TopBar } from '../shell/TopBar.tsx'
import { Button, Spinner } from '../ui/index.tsx'
import { ChatPanel } from './ChatPanel.tsx'
import { buildItems, isOpen, itemId, nextOpen, stackMoved, startAt } from './items.ts'
import { ItemView } from './ItemView.tsx'
import { Preparing } from './Preparing.tsx'

/** What the stack view passes when it shows a PR's review inside it. */
type Embed = {
  /** The item to open on, such as `d:<decision id>` from a finding. */
  focus?: string | undefined
  onProgress?: ((decided: number, total: number) => void) | undefined
}

export function ReviewPage({ prRef, ...embed }: { prRef: PrRef } & Embed) {
  const { prAtom } = useAtoms()
  const pr = useAtomValue(prAtom(prRef))
  const error = failureOf(pr)
  if (isUnavailable(error)) return <Setup prRef={prRef} reason={error.reason} />
  if (AsyncResult.isFailure(pr))
    return (
      <main className="mx-auto mt-24 max-w-[34rem] px-6">
        <h1 className="mb-2 text-lg font-medium">This PR could not be loaded</h1>
        <p className="text-muted-foreground">{error && 'message' in error ? String(error.message) : 'The companion failed while reading the PR.'}</p>
      </main>
    )
  if (!AsyncResult.isSuccess(pr))
    return (
      <main className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Spinner /> Fetching #{prRef.number}…
      </main>
    )
  return <Loaded prRef={prRef} pr={pr.value} {...embed} />
}

type ReviewDone = Extract<ReviewEvent, { _tag: 'Done' }>

/** Waits once behind the progress screen, then shows the review from the latest `Done`; a refresh keeps it up until the next one. */
function Loaded({ prRef, pr, ...embed }: { prRef: PrRef; pr: PrView } & Embed) {
  const atom = useAtoms().reviewAtom(prRef, pr.headSha)
  const result = useAtomValue(atom)
  const event = AsyncResult.isSuccess(result) ? result.value : undefined
  const [shown, setShown] = useState<ReviewDone>()
  if (event?._tag === 'Done' && event !== shown) setShown(event)
  const review = event?._tag === 'Done' ? event : shown
  if (review) return <Ready prRef={prRef} pr={pr} review={review} {...embed} />
  if (AsyncResult.isFailure(result)) return <Ready prRef={prRef} pr={pr} {...embed} sortError={String((failureOf(result) as { message?: string } | undefined)?.message ?? 'unknown error')} />
  return <Preparing pr={pr} phases={event?._tag === 'Preparing' ? event.phases : []} />
}

/** The review, built once per `Done`: its order holds while the page is open. Without one (the sort failed) every file is unsorted. */
function Ready({ prRef, pr, review, sortError, focus, onProgress }: { prRef: PrRef; pr: PrView; review?: ReviewDone; sortError?: string } & Embed) {
  const { reviewAtom, stateAtom, opinionAtom } = useAtoms()
  const registry = useContext(RegistryContext)
  const refreshReview = () => registry.refresh(reviewAtom(prRef, pr.headSha))
  const saveState = useAtomSet(stateAtom)
  // The cached opinion, which dismissals, deeper looks and runs refresh; until it is read, the one the review came with.
  const cachedResult = useAtomValue(opinionAtom(prRef, pr.headSha, false))
  const cached = AsyncResult.isSuccess(cachedResult) && cachedResult.value._tag === 'Done' ? cachedResult.value : undefined
  const done = cached ?? (review?.opinion ? { opinion: review.opinion, states: review.findingStates } : undefined)
  const opinionError = review?.opinionError
  // Idle offers the run: on demand, or when only a carried opinion is here. A failed opinion has its own retry line.
  const opinion: OpinionEvent | undefined = opinionError || !review ? undefined : done ? { _tag: 'Done', ...done } : { _tag: 'Idle' }
  const [runningOpinion, setRunningOpinion] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const items = useMemo(() => buildItems(pr, review), [pr, review])
  const openFindings = done ? done.opinion.decisions.flatMap((d) => d.findings).filter((f) => isOpen(f, done.states)) : []

  const [selectedKey, setSelectedKey] = useRemembered<string | undefined>(`at:${prRef.host}/${prRef.owner}/${prRef.repo}#${prRef.number}`, undefined)
  useEffect(() => {
    if (focus && items.some((i) => i.key === focus)) setSelectedKey(focus)
  }, [focus])
  const [overrides, setOverrides] = useState<Record<string, DecisionState | null>>({})
  const [commentingOn, setCommentingOn] = useState<string>()
  const [chatOpen, setChatOpen] = useState(false)
  const [chatFocus, setChatFocus] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const states: DecisionStates = useMemo(() => {
    const merged: Record<string, DecisionState> = { ...review?.state }
    for (const [id, s] of Object.entries(overrides)) s ? (merged[id] = s) : delete merged[id]
    return merged
  }, [review, overrides])

  const rereview = review?.rereview ?? {}

  const chosen = items.findIndex((i) => i.key === selectedKey)
  const index = chosen >= 0 ? chosen : startAt(items, states)
  const item = items[index]!
  const decision = item.kind === 'decision' ? item.decision : undefined
  const id = itemId(item)
  const [reviewOpen, setReviewOpen] = useState(false)
  const select = (i: number) => {
    setSelectedKey(items[Math.max(0, Math.min(items.length - 1, i))]!.key)
    setCommentingOn(undefined)
  }

  const verdict = (state: DecisionState) => {
    if (id === undefined) return
    // Until something is chosen the open item follows the verdicts; pin it so this one stays put.
    if (selectedKey !== item.key) setSelectedKey(item.key)
    const next = states[id] === state ? null : state
    setOverrides((o) => ({ ...o, [id]: next }))
    saveState({ ref: prRef, headSha: pr.headSha, decisionId: id, state: next })
    return next
  }
  /** Accepting moves to the next open item; after the last one, the review is ready to send. */
  const accept = () => {
    if (verdict('accepted') !== 'accepted') return
    const next = nextOpen(items, index, { ...states, [id!]: 'accepted' })
    if (next < 0) setReviewOpen(true)
    else select(next)
  }
  const pushBack = () => {
    if (!decision) return
    if (states[decision.id] !== 'pushed-back') verdict('pushed-back')
    setCommentingOn(decision.id)
  }
  const discuss = () => {
    if (!decision) return
    setChatOpen(true)
    setChatFocus((n) => n + 1)
  }

  useHotkeys([
    { hotkey: 'J', callback: () => select(index + 1) },
    { hotkey: 'K', callback: () => select(index - 1) },
    { hotkey: 'A', callback: accept },
    { hotkey: 'P', callback: pushBack },
    { hotkey: '/', callback: discuss, options: { preventDefault: true } },
    { hotkey: 'Mod+J', callback: () => (chatOpen ? setChatOpen(false) : discuss()), options: { ignoreInputs: false, preventDefault: true } },
    { hotkey: 'Mod+K', callback: () => setPaletteOpen((o) => !o), options: { ignoreInputs: false, preventDefault: true } },
    {
      hotkey: 'Escape',
      callback: () => (commentingOn ? setCommentingOn(undefined) : setChatOpen(false)),
      options: { ignoreInputs: false },
    },
  ])

  const reviewable = items.flatMap((i) => itemId(i) ?? [])
  const decided = reviewable.filter((i) => states[i]).length
  useEffect(() => onProgress?.(decided, reviewable.length), [decided, reviewable.length])

  return (
    <div className="flex h-full flex-col">
      <TopBar
        prRef={prRef}
        pr={pr}
        decided={decided}
        total={reviewable.length}
        reviewOpen={reviewOpen}
        onReviewOpenChange={setReviewOpen}
        opinion={opinion}
        running={runningOpinion}
        onRunOpinion={() => setRunningOpinion(true)}
        onOpinionDone={() => {
          setRunningOpinion(false)
          // A retried opinion comes back through the review, which drops the error and ranks by it.
          if (retrying) refreshReview()
          setRetrying(false)
        }}
      />
      {opinionError && !runningOpinion && (
        <div className="flex items-center gap-3 border-b border-border bg-destructive/10 px-3 py-1.5 text-sm">
          <span>Claude's opinion failed: {opinionError}</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setRetrying(true)
              setRunningOpinion(true)
            }}
          >
            Try again
          </Button>
        </div>
      )}
      {done?.opinion.carriedFrom !== undefined && !runningOpinion && (
        <div className="border-b border-border bg-info/10 px-3 py-1.5 text-sm">
          Opinion carried over from an earlier push for {done.opinion.decisions.length} {done.opinion.decisions.length === 1 ? 'decision' : 'decisions'}
        </div>
      )}
      {done && done.opinion.carriedFrom === undefined && !runningOpinion && stackMoved(pr, done.opinion.stackHeads) && (
        <div className="flex items-center gap-3 border-b border-border bg-info/10 px-3 py-1.5 text-sm">
          <span>The stack moved since this opinion.</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              registry.refresh(opinionAtom(prRef, pr.headSha, true))
              setRunningOpinion(true)
            }}
          >
            Run again
          </Button>
        </div>
      )}
      {sortError !== undefined && (
        <div className="flex items-center gap-3 border-b border-border bg-destructive/10 px-3 py-1.5 text-sm">
          <span>The sort failed: {sortError}. Files stay unsorted.</span>
          <Button size="xs" variant="outline" onClick={refreshReview}>
            Sort again
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          items={items}
          selected={index}
          states={states}
          rereview={rereview}
          result={review?.sort}
          findings={openFindings}
          ticket={done?.opinion.ticketNote || undefined}
          onSelect={select}
        />
        <main key={item.key} className="min-w-0 flex-1 overflow-y-auto">
          <ItemView
            key={item.key}
            prRef={prRef}
            pr={pr}
            item={item}
            verdict={id === undefined ? undefined : states[id]}
            rereview={id === undefined ? undefined : rereview[id]}
            commenting={decision !== undefined && commentingOn === decision.id}
            onAccept={accept}
            onPushBack={pushBack}
            onDiscuss={discuss}
            onCommentDone={() => setCommentingOn(undefined)}
            {...(index < items.length - 1 ? { onNext: () => select(index + 1) } : {})}
            opinion={done}
          />
        </main>
        {chatOpen && decision && <ChatPanel key={decision.id} prRef={prRef} headSha={pr.headSha} decision={decision} focus={chatFocus} />}
      </div>
      <FooterHints />
      <CommandPalette open={paletteOpen} items={items} onOpenChange={setPaletteOpen} onSelect={select} />
    </div>
  )
}
