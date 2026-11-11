import type { AskTarget, Draft, PrRef, Thread } from '@pr-review/domain'
import { useRef, useState } from 'react'
import { useFocusOnMount } from '../ui/focus.ts'
import { Streamdown } from 'streamdown'
import { cn } from '../lib/utils.ts'
import { Button, Spinner } from '../ui/index.tsx'
import { RuleDialog } from './RuleDialog.tsx'
import { CommentBox } from './CommentBox.tsx'
import { useConversation } from './conversation.ts'
import { useDrafts } from './drafts.ts'

type Lines = Extract<AskTarget, { _tag: 'Lines' }>
export type Mode = 'ask' | 'comment'

const span = (t: { start: number; end: number }) => (t.start === t.end ? `line ${t.end}` : `lines ${t.start}–${t.end}`)
const draftTarget = (t: Lines, headSha: string): Omit<Draft, 'id' | 'body'> => ({ path: t.path, line: t.end, ...(t.start !== t.end ? { startLine: t.start } : {}), side: t.side, headSha })

const box = 'mx-2.5 my-1.5 rounded-lg border border-border bg-card px-3 py-2 font-sans text-base whitespace-normal'

/**
 * A conversation with Claude about some lines, under them like a review thread. Started from a selection it
 * opens with tabs: ask Claude, or write a comment for the review.
 */
export function LineThread(props: { prRef: PrRef; headSha: string; target: Lines; active?: Mode; onClose?: () => void }) {
  const { turns, busy, failed, send } = useConversation(props.prRef, props.headSha, props.target)
  const [question, setQuestion] = useState('')
  const [hidden, setHidden] = useState(false)
  const [mode, setMode] = useState<Mode>(props.active ?? 'ask')
  const [commenting, setCommenting] = useState<string>()
  const answered = turns.at(-1)
  const askInput = useRef<HTMLInputElement>(null)
  useFocusOnMount(askInput, props.active === 'ask')
  const comment = (text: string) => {
    setCommenting(text)
    setMode('comment')
  }
  const showComment = props.active ? mode === 'comment' : commenting !== undefined

  if (hidden)
    return (
      <button type="button" onClick={() => setHidden(false)} className="mx-2.5 my-1 flex items-center gap-2 font-sans text-sm text-muted-foreground hover:text-foreground">
        <span className="text-primary">Claude</span> {turns.length} {turns.length === 1 ? 'question' : 'questions'} on {span(props.target)}
      </button>
    )

  return (
    <div className={box}>
      {props.active ? (
        <div role="tablist" className="mb-2 flex items-center gap-1 text-sm">
          {(['ask', 'comment'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn('rounded-md px-2 py-0.5 text-muted-foreground hover:text-foreground', mode === m && 'bg-accent text-foreground')}
            >
              {m === 'ask' ? 'Ask Claude' : 'Comment'}
            </button>
          ))}
          <span className="ml-auto text-dim">{span(props.target)}</span>
        </div>
      ) : (
        <div className="mb-1.5 flex items-center gap-2 text-sm text-dim">
          <span className="text-primary">Claude</span> on {span(props.target)}
          <button type="button" onClick={() => setHidden(true)} className="ml-auto hover:text-foreground">
            Hide
          </button>
        </div>
      )}
      {turns.map((t, i) => (
        <div key={i} className="mb-2 flex flex-col gap-1">
          <p className="self-end rounded-lg border border-border px-2.5 py-1 text-foreground">{t.question}</p>
          <div className="min-w-0 rounded-lg bg-accent px-2.5 py-1.5 [overflow-wrap:anywhere] text-muted-foreground">
            {t.answer ? <Streamdown className="text-sm text-foreground">{t.answer}</Streamdown> : <Spinner className="size-3" />}
          </div>
        </div>
      ))}
      {failed && <p className="mb-2 text-sm text-destructive">Claude could not answer. Ask again.</p>}
      {showComment ? (
        <CommentBox
          key={commenting}
          prRef={props.prRef}
          target={draftTarget(props.target, props.headSha)}
          {...(commenting !== undefined ? { initial: commenting } : {})}
          onDone={() => {
            setCommenting(undefined)
            if (props.active) props.onClose?.()
          }}
        />
      ) : (
        <div className="flex gap-1.5">
          <input
            ref={askInput}
            aria-label="Ask Claude"
            value={question}
            disabled={busy}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && send(question)) setQuestion('')
              if (e.key === 'Escape') props.onClose?.()
            }}
            placeholder={turns.length ? 'Ask a follow-up…' : `Ask Claude about ${span(props.target)}…`}
            className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary"
          />
          {answered && !answered.streaming && (
            <Button size="xs" variant="outline" onClick={() => comment(answered.answer)}>
              Comment with this answer
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** A comment waiting in the pending review, editable until the review is sent. */
export function DraftNote({ prRef, draft }: { prRef: PrRef; draft: Draft }) {
  const { edit, remove } = useDrafts(prRef)
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(draft.body)
  const editor = useRef<HTMLTextAreaElement>(null)
  useFocusOnMount(editor, editing)
  const save = () => {
    if (!body.trim()) return
    edit(draft.id, body)
    setEditing(false)
  }
  return (
    <div className={box}>
      <div className="mb-1 flex items-center gap-2 text-sm text-dim">
        <span className="rounded-sm border border-warn px-1 text-xs text-warn">Pending</span>
        {draft.startLine !== undefined && span({ start: draft.startLine, end: draft.line })}
        <span className="ml-auto flex gap-2">
          <button type="button" onClick={() => setEditing(true)} className="hover:text-foreground">
            Edit
          </button>
          <button type="button" onClick={() => remove(draft.id)} className="hover:text-destructive">
            Delete
          </button>
        </span>
      </div>
      {editing ? (
        <div>
          <textarea
            ref={editor}
            aria-label="Edit comment"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
              if (e.key === 'Escape') setEditing(false)
            }}
            className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:border-primary"
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => (setBody(draft.body), setEditing(false))}>
              Cancel
            </Button>
            <Button size="xs" disabled={!body.trim()} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <Streamdown className="text-sm">{draft.body}</Streamdown>
      )}
    </div>
  )
}

/** A comment thread already on GitHub. The viewer's own comments can become a rule. */
export function GitHubThread({ prRef, viewer, comments }: { prRef: PrRef; viewer: string; comments: ReadonlyArray<Thread> }) {
  const [ruling, setRuling] = useState<number>()
  return (
    <div className={box}>
      {comments.map((c) => (
        <div key={c.id} className="mb-1.5 last:mb-0">
          <p className="flex items-center gap-2 text-sm">
            <span className="font-medium">{c.author}</span> <span className="text-dim">{new Date(c.createdAt).toLocaleDateString()}</span>
            {c.author === viewer && ruling !== c.id && (
              <button type="button" onClick={() => setRuling(c.id)} className="ml-auto text-dim hover:text-foreground">
                Make it a rule
              </button>
            )}
          </p>
          <Streamdown className="text-sm text-muted-foreground">{c.body}</Streamdown>
          {ruling === c.id && <RuleDialog prRef={prRef} text={c.body} onClose={() => setRuling(undefined)} />}
        </div>
      ))}
    </div>
  )
}
