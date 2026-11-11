import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import type { OpinionEvent, PrRef, PrView } from '@pr-review/domain'
import { AsyncResult } from 'effect/reactivity'
import { useEffect } from 'react'
import { useAtoms } from '../atoms.ts'
import { failureOf } from '../result.ts'
import { ReviewPopover } from '../review/ReviewPopover.tsx'
import { githubFilesUrl } from '../Setup.tsx'
import { Button, Kbd, Pill, Working } from '../ui/index.tsx'

/** A run of Claude's opinion: its step while working, nothing once done. */
function OpinionRun({ prRef, headSha, onDone }: { prRef: PrRef; headSha: string; onDone: () => void }) {
  const atom = useAtoms().opinionAtom(prRef, headSha, true)
  const result = useAtomValue(atom)
  const retry = useAtomRefresh(atom)
  const finished = AsyncResult.isSuccess(result) && result.value._tag === 'Done'
  useEffect(() => {
    if (finished) onDone()
  }, [finished])
  if (AsyncResult.isFailure(result))
    return (
      <span className="flex items-center gap-1.5 text-destructive">
        The opinion failed: {String((failureOf(result) as { message?: string } | undefined)?.message ?? 'unknown error')}
        <Button size="xs" variant="outline" onClick={retry}>
          Try again
        </Button>
      </span>
    )
  const e = AsyncResult.isSuccess(result) ? result.value : undefined
  if (e?._tag === 'Done') return null
  return <Working className="max-w-72" step={e?._tag === 'Running' ? e.step : undefined} startedAt={e?._tag === 'Running' ? e.startedAt : undefined} />
}

export function TopBar(props: {
  prRef: PrRef
  pr: PrView
  decided: number
  total: number
  reviewOpen: boolean
  onReviewOpenChange: (open: boolean) => void
  /** The cached opinion; `Idle` offers to run one. */
  opinion: OpinionEvent | undefined
  running: boolean
  onRunOpinion: () => void
  onOpinionDone: () => void
}) {
  const { pr } = props
  const position = pr.stack.findIndex((s) => s.number === pr.number)
  return (
    <header className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border px-3 text-sm text-muted-foreground">
      <span>
        {pr.owner}/{pr.repo}
      </span>
      <span aria-hidden>›</span>
      <b className="min-w-0 truncate font-medium text-foreground">
        #{pr.number} {pr.title}
      </b>
      <Pill>{pr.author}</Pill>
      {pr.stack.length > 1 && position >= 0 && (
        <a href={`#/stack/${pr.host}/${pr.owner}/${pr.repo}/${pr.number}`} title="Open the stack view">
          <Pill className="hover:text-foreground">
            Stack {position + 1}/{pr.stack.length}
          </Pill>
        </a>
      )}
      <span className="ml-auto flex min-w-0 items-center">
        {props.running ? (
          <OpinionRun prRef={props.prRef} headSha={pr.headSha} onDone={props.onOpinionDone} />
        ) : (
          (props.opinion?._tag === 'Idle' || (props.opinion?._tag === 'Done' && props.opinion.opinion.carriedFrom !== undefined)) && (
            <Button size="xs" variant="outline" onClick={props.onRunOpinion}>
              Claude's opinion
            </Button>
          )
        )}
      </span>
      <span className="flex items-center gap-2" aria-label="Items reviewed">
        {props.decided} / {props.total} reviewed
        <i className="block h-1 w-16 overflow-hidden rounded-sm bg-border">
          <b className="block h-full bg-ok" style={{ width: `${props.total ? (props.decided / props.total) * 100 : 0}%` }} />
        </i>
      </span>
      <a className="hover:text-foreground" href={githubFilesUrl(props.prRef)}>
        Open on GitHub
      </a>
      <ReviewPopover prRef={props.prRef} pr={pr} open={props.reviewOpen} onOpenChange={props.onReviewOpenChange} />
      <Kbd>⌘K</Kbd>
    </header>
  )
}
