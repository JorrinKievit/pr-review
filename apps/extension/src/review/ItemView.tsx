import type { Decision, DecisionState, FindingStates, PrOpinion, PrRef, PrView, Rereview } from '@pr-review/domain'
import { useState } from 'react'
import { Streamdown } from 'streamdown'
import { Button, Kbd, Pill } from '../ui/index.tsx'
import { CommentBox } from './CommentBox.tsx'
import { Description } from './Description.tsx'
import { DecisionFindings, VerdictPill } from './Findings.tsx'
import { FileDiffView } from './FileDiffView.tsx'
import { type Item, itemFiles, itemTitle, linesIn } from './items.ts'

/** Pinned to the bottom of the pane, so a verdict or the next item is one click away wherever the diff is scrolled. */
export function ActionBar(props: {
  verdict?: DecisionState | undefined
  /** The verdict from before the author's latest changes, when this is a follow-up. */
  was?: DecisionState | undefined
  onAccept?: () => void
  onPushBack?: (() => void) | undefined
  onDiscuss?: (() => void) | undefined
  onNext?: (() => void) | undefined
}) {
  const acceptLabel = props.verdict === 'accepted' ? 'Accepted' : props.was === 'pushed-back' ? 'Resolved' : props.was ? 'Still fine' : 'Accept'
  const pushBackLabel = props.verdict === 'pushed-back' ? 'Pushed back' : props.was === 'pushed-back' ? 'Still not right' : 'Push back'
  if (!props.onAccept && !props.onNext) return null
  return (
    <div className="sticky bottom-0 -mx-5 mt-4 flex items-center gap-1.5 border-t border-border bg-background/95 px-5 py-2 backdrop-blur">
      {props.onAccept && (
        <>
          <Button size="sm" variant={props.verdict === 'accepted' ? 'secondary' : 'default'} onClick={props.onAccept}>
            {acceptLabel} <Kbd className="border-none bg-transparent text-primary-foreground/80">a</Kbd>
          </Button>
          {props.onPushBack && (
            <Button size="sm" variant="outline" onClick={props.onPushBack}>
              {pushBackLabel} <Kbd className="border-none bg-transparent">p</Kbd>
            </Button>
          )}
          {props.onDiscuss && (
            <Button size="sm" variant="ghost" onClick={props.onDiscuss}>
              Discuss <Kbd className="border-none bg-transparent">⌘J</Kbd>
            </Button>
          )}
        </>
      )}
      {props.onNext && (
        <Button size="sm" variant="ghost" className="ml-auto" onClick={props.onNext}>
          Next <Kbd className="border-none bg-transparent">j</Kbd>
        </Button>
      )}
    </div>
  )
}

/** For reasons that only make sense next to existing code: how to introduce it. */
const existingLabel: Partial<Record<Decision['reason'], string>> = { departs: 'Departs from:', duplicate: 'Possible duplicate of:' }

const lensLabel = { architecture: 'Architecture', quality: 'Code quality', ui: 'UI/UX' } as const
const reasonLabel = {
  departs: 'Departs from the codebase',
  'shared-layer': 'Shared layer',
  duplicate: 'Possible duplicate',
  convention: 'Convention',
  permissions: 'Permissions',
  'data-model': 'Data model',
  dependency: 'Dependency',
  config: 'Config',
} as const

/** The main pane: one decision, skim area, trusted group or the unsorted list, with its diffs. Without handlers it is read-only. */
export function ItemView(props: {
  prRef: PrRef
  pr: PrView
  item: Item
  verdict?: DecisionState | undefined
  /** Set when this item was judged on an earlier push and its files changed since. */
  rereview?: Rereview[string] | undefined
  commenting?: boolean
  onAccept?: () => void
  onPushBack?: () => void
  onDiscuss?: () => void
  onCommentDone?: () => void
  onNext?: () => void
  /** Claude's finished opinion on the PR, with what the reviewer did with each finding. */
  opinion?: { opinion: PrOpinion; states: FindingStates } | undefined
}) {
  const { item, pr } = props
  // Sorts from before renames were detected list a moved file under both paths.
  const movedFrom = new Set(pr.files.flatMap((f) => f.previous ?? []))
  const files = itemFiles(item).filter((p) => !movedFrom.has(p))
  const rangesInItem = (path: string) => (item.kind === 'decision' ? (item.decision.files.find((f) => f.path === path)?.ranges ?? []) : [])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const allCollapsed = files.length > 0 && files.every((f) => collapsed.has(f))
  const changed = props.verdict ? undefined : props.rereview
  const [sinceOnly, setSinceOnly] = useState(true)
  const said = changed ? pr.threads.filter((t) => t.author === pr.viewer && files.includes(t.path)) : []
  const base = changed && sinceOnly ? changed.since : pr.mergeBase
  const rangesFor = (path: string) => (base !== pr.mergeBase ? [] : rangesInItem(path))
  const toggle = (path: string) => setCollapsed((c) => (c.has(path) ? new Set([...c].filter((p) => p !== path)) : new Set([...c, path])))
  const first = item.kind === 'decision' ? item.decision.files[0] : undefined
  const firstRange = first?.ranges[0]
  const opinionId = item.kind === 'decision' ? item.decision.id : item.kind === 'skim' ? item.opinionId : undefined
  const take = opinionId === undefined ? undefined : props.opinion?.opinion.decisions.find((d) => d.decisionId === opinionId)

  return (
    <article className="mx-auto max-w-[60rem] px-5 py-4">
      <h2 className="mb-1 text-lg font-medium">{itemTitle(item)}</h2>
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        {item.kind === 'decision' && (
          <>
            <Pill>{lensLabel[item.decision.lens]}</Pill>
            <Pill>{reasonLabel[item.decision.reason]}</Pill>
            {item.unclaimed && <Pill className="text-warn">Not in the author's list</Pill>}
          </>
        )}
        {take && props.opinion && <VerdictPill opinion={take} states={props.opinion.states} />}
        {item.kind !== 'description' && (
          <span>
            {files.length} {files.length === 1 ? 'file' : 'files'} · {linesIn(pr.files, files)} lines
          </span>
        )}
        {files.length > 0 && (
          <button type="button" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(files))} className="ml-auto hover:text-foreground">
            {allCollapsed ? 'Expand all files' : 'Collapse all files'}
          </button>
        )}
      </div>

      {changed && (
        <section aria-label="Follow-up" className="mb-3 rounded-lg border border-info/40 bg-info/10 px-3 py-2.5">
          <p>
            You {changed.was === 'accepted' ? 'accepted' : 'pushed'} this{changed.was === 'accepted' ? '' : ' back'} on an earlier push. The author has changed its files since
            {sinceOnly ? '; below is only what changed.' : '.'}{' '}
            <button type="button" onClick={() => setSinceOnly((s) => !s)} className="text-info hover:underline">
              {sinceOnly ? 'Show the whole change' : 'Show only what changed since'}
            </button>
          </p>
          {said.length > 0 && (
            <ul aria-label="What you said" className="mt-2 flex flex-col gap-1.5 border-t border-info/30 pt-2">
              {said.map((t) => (
                <li key={t.id}>
                  <span className="font-mono text-sm text-muted-foreground">
                    {t.path}
                    {t.line === null ? ' (outdated)' : `:${t.line}`}
                  </span>
                  <Streamdown className="text-sm">{t.body}</Streamdown>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {item.kind === 'decision' && (
        <div className="mb-3 rounded-lg border border-border bg-card px-3 py-2.5 text-muted-foreground">
          <p>{item.decision.note}</p>
          {item.decision.existing ? (
            <p className="mt-1.5">
              <span className="text-foreground">{existingLabel[item.decision.reason] ?? 'Existing way:'}</span> <code className="font-mono text-sm">{item.decision.existing.path}</code>.{' '}
              {item.decision.existing.why}
            </p>
          ) : (
            existingLabel[item.decision.reason] && <p className="mt-1.5 text-dim">Claude did not name the existing code this is compared with.</p>
          )}
          {item.decision.authorWhy && (
            <p className="mt-1.5">
              <span className="text-foreground">Author's reason:</span> {item.decision.authorWhy}
            </p>
          )}
        </div>
      )}
      {item.kind === 'skim' && <p className="mb-3 text-muted-foreground">{item.area.summary}</p>}
      {opinionId !== undefined && props.opinion && (
        <DecisionFindings prRef={props.prRef} headSha={pr.headSha} prNumber={pr.number} decisionId={opinionId} opinion={take} states={props.opinion.states} />
      )}
      {item.kind === 'trusted' && <p className="mb-3 text-muted-foreground">{item.group.why}</p>}
      {item.kind === 'description' && <Description prRef={props.prRef} />}

      {props.commenting && first && (
        <CommentBox
          prRef={props.prRef}
          // ponytail: a whole-file decision comments on line 1, which GitHub rejects when line 1 is outside the diff
          target={{
            path: first.path,
            line: firstRange?.end ?? 1,
            ...(firstRange && firstRange.start !== firstRange.end ? { startLine: firstRange.start } : {}),
            side: 'RIGHT',
            headSha: pr.headSha,
          }}
          onDone={() => props.onCommentDone?.()}
        />
      )}

      <div className="mt-3 flex flex-col gap-3">
        {files.map((path) => (
          <FileDiffView
            key={`${base} ${path}`}
            prRef={props.prRef}
            mergeBase={base}
            headSha={pr.headSha}
            path={path}
            previous={pr.files.find((f) => f.path === path)?.previous}
            ranges={rangesFor(path)}
            threads={pr.threads}
            viewer={pr.viewer}
            collapsed={collapsed.has(path)}
            onToggle={() => toggle(path)}
            {...(base !== pr.mergeBase ? { empty: 'unchanged since your review' } : {})}
          />
        ))}
      </div>
      <ActionBar
        onNext={props.onNext}
        {...(item.kind !== 'unsorted' && props.onAccept ? { verdict: props.verdict, was: changed?.was, onAccept: props.onAccept } : {})}
        {...(item.kind === 'decision' ? { onPushBack: props.onPushBack, onDiscuss: props.onDiscuss } : {})}
      />
    </article>
  )
}
