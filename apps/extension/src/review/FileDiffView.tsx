import { useAtomValue } from '@effect/atom-react'
import { parsePatchFiles } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import { type AskTarget, type Draft, type LineRange, type PrRef, type Thread, targetKey } from '@pr-review/domain'
import { AsyncResult } from 'effect/reactivity'
import { useMemo, useState } from 'react'
import { useAtoms } from '../atoms.ts'
import { Spinner } from '../ui/index.tsx'
import { narrowPatch } from './hunks.ts'
import { useDrafts } from './drafts.ts'
import { DraftNote, GitHubThread, LineThread, type Mode } from './LineThread.tsx'

type Side = 'LEFT' | 'RIGHT'
type Selection = { start: number; end: number; side: Side; mode: Mode }
type Lines = Extract<AskTarget, { _tag: 'Lines' }>
/** What sits under one line: comments on GitHub, pending comments, Claude conversations, and the one being started. */
type Note = { side: Side; line: number; github: Thread[][]; drafts: Draft[]; chats: Lines[]; active?: { target: Lines; mode: Mode } }

const sideOf = (s: string | undefined): Side => (s === 'deletions' ? 'LEFT' : 'RIGHT')

function selectionOf(range: { start: number; end: number; side?: string | undefined; endSide?: string | undefined }, mode: Mode): Selection {
  const side = sideOf(range.endSide ?? range.side)
  // ponytail: a range spanning both sides collapses to its last line; GitHub's start_side would keep it
  if (sideOf(range.side) !== side) return { start: range.end, end: range.end, side, mode }
  return { start: Math.min(range.start, range.end), end: Math.max(range.start, range.end), side, mode }
}

/**
 * One file's diff, narrowed to `ranges`. Comments and conversations sit under their lines; selecting lines
 * asks Claude, the + in the gutter starts a comment.
 */
export function FileDiffView(props: {
  prRef: PrRef
  mergeBase: string
  headSha: string
  path: string
  /** Where the file was before the PR moved it. */
  previous?: string | undefined
  ranges: ReadonlyArray<LineRange>
  threads: ReadonlyArray<Thread>
  collapsed?: boolean
  onToggle?: () => void
  /** Shown instead of the diff when there is none. */
  empty?: string
}) {
  const { patchAtom, chatsAtom } = useAtoms()
  const patch = useAtomValue(patchAtom(props.prRef, props.mergeBase, props.headSha, props.path, props.previous))
  const chats = useAtomValue(chatsAtom(props.prRef, props.headSha))
  const { drafts } = useDrafts(props.prRef)
  const [selection, setSelection] = useState<Selection>()
  const [whole, setWhole] = useState(false)
  const narrowed = useMemo(
    () => (AsyncResult.isSuccess(patch) && patch.value ? narrowPatch(patch.value, whole ? [] : props.ranges) : undefined),
    [patch, props.ranges, whole],
  )
  const file = useMemo(() => narrowed && parsePatchFiles(narrowed.patch)[0]?.files[0], [narrowed])
  const notes = useMemo(() => {
    const byLine = new Map<string, Note>()
    const at = (side: Side, line: number) => {
      const k = `${side}:${line}`
      return byLine.get(k) ?? byLine.set(k, { side, line, github: [], drafts: [], chats: [] }).get(k)!
    }
    const replies = Map.groupBy(
      props.threads.filter((t) => t.inReplyTo !== null),
      (t) => t.inReplyTo,
    )
    for (const t of props.threads) if (t.path === props.path && t.line !== null && t.inReplyTo === null) at(t.side, t.line).github.push([t, ...(replies.get(t.id) ?? [])])
    for (const d of drafts) if (d.path === props.path) at(d.side, d.line).drafts.push(d)
    const active: Lines | undefined = selection && {
      _tag: 'Lines',
      path: props.path,
      start: selection.start,
      end: selection.end,
      side: selection.side,
      commit: selection.side === 'LEFT' ? props.mergeBase : props.headSha,
    }
    for (const c of AsyncResult.isSuccess(chats) ? chats.value : [])
      if (c.target._tag === 'Lines' && c.target.path === props.path && (!active || targetKey(c.target) !== targetKey(active))) at(c.target.side, c.target.end).chats.push(c.target)
    if (active && selection) at(active.side, active.end).active = { target: active, mode: selection.mode }
    return [...byLine.values()]
  }, [chats, drafts, selection, props.threads, props.path, props.mergeBase, props.headSha])

  if (AsyncResult.isFailure(patch)) return <div className="rounded-lg border border-border bg-card px-3 py-2 text-destructive">Could not load {props.path}.</div>
  if (!file)
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-muted-foreground">
        {AsyncResult.isSuccess(patch) ? `${props.path}: ${props.empty ?? 'no textual changes'}` : <><Spinner /> {props.path}</>}
      </div>
    )
  // The header lives in the diff's shadow DOM and takes no click handler, so clicks on it are caught here.
  const onHeaderClick = (e: React.MouseEvent) => {
    if (props.onToggle && e.nativeEvent.composedPath().some((n) => n instanceof Element && n.hasAttribute('data-diffs-header'))) props.onToggle()
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border" onClick={onHeaderClick}>
      <FileDiff
        fileDiff={file}
        options={{
          diffStyle: 'unified',
          themeType: 'system',
          collapsed: props.collapsed ?? false,
          ...(props.onToggle ? { unsafeCSS: '[data-diffs-header] { cursor: pointer; }' } : {}),
          stickyHeader: true,
          enableLineSelection: true,
          enableGutterUtility: true,
          onGutterUtilityClick: (range) => setSelection(selectionOf(range, 'comment')),
          // Clicking the + also selects its line; that selection must not turn the comment back into a question.
          onLineSelectionEnd: (range) =>
            setSelection((prev) => {
              if (!range) return undefined
              const next = selectionOf(range, 'ask')
              return prev && prev.start === next.start && prev.end === next.end && prev.side === next.side ? prev : next
            }),
        }}
        {...(props.onToggle
          ? {
              renderHeaderPrefix: () => (
                // Its click reaches the header handler above.
                <button type="button" aria-label={`${props.collapsed ? 'Expand' : 'Collapse'} ${props.path}`} className="mr-1 px-1 text-muted-foreground hover:text-foreground">
                  {props.collapsed ? '▸' : '▾'}
                </button>
              ),
            }
          : {})}
        lineAnnotations={notes.map((n) => ({ side: n.side === 'LEFT' ? 'deletions' : 'additions', lineNumber: n.line, metadata: n }))}
        renderAnnotation={({ metadata: n }) => (
          <>
            {n.github.map((comments) => (
              <GitHubThread key={comments[0]!.id} comments={comments} />
            ))}
            {n.drafts.map((d) => (
              <DraftNote key={d.id} prRef={props.prRef} draft={d} />
            ))}
            {n.chats.map((t) => (
              <LineThread key={targetKey(t)} prRef={props.prRef} headSha={props.headSha} target={t} />
            ))}
            {n.active && (
              <LineThread
                key={`${targetKey(n.active.target)} ${n.active.mode}`}
                prRef={props.prRef}
                headSha={props.headSha}
                target={n.active.target}
                active={n.active.mode}
                onClose={() => setSelection(undefined)}
              />
            )}
          </>
        )}
      />
      {narrowed && narrowed.hidden > 0 && (
        <button type="button" onClick={() => setWhole(true)} className="w-full border-t border-border bg-card px-3 py-1.5 text-left text-sm text-muted-foreground hover:text-foreground">
          Show {narrowed.hidden} more {narrowed.hidden === 1 ? 'change' : 'changes'} in this file
        </button>
      )}
    </div>
  )
}
