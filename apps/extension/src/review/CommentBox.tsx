import type { Draft, PrRef } from '@pr-review/domain'
import { useRef, useState } from 'react'
import { useFocusOnMount } from '../ui/focus.ts'
import { Button } from '../ui/index.tsx'
import { useDrafts } from './drafts.ts'

/** Writes one review comment into the pending review; nothing reaches GitHub until the review is sent. */
export function CommentBox(props: { prRef: PrRef; target: Omit<Draft, 'id' | 'body'>; initial?: string; autoFocus?: boolean; onDone: () => void }) {
  const { add } = useDrafts(props.prRef)
  const [body, setBody] = useState(props.initial ?? '')
  const input = useRef<HTMLTextAreaElement>(null)
  useFocusOnMount(input, props.autoFocus ?? true)
  const submit = () => {
    if (!body.trim()) return
    add({ ...props.target, body })
    props.onDone()
  }
  const where = props.target.startLine !== undefined && props.target.startLine !== props.target.line ? `lines ${props.target.startLine}–${props.target.line}` : `line ${props.target.line}`

  return (
    <div className="mt-2 font-sans whitespace-normal">
      <textarea
        ref={input}
        aria-label="Comment"
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          if (e.key === 'Escape') props.onDone()
        }}
        className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-base outline-none focus:border-primary"
        placeholder={`Comment on ${props.target.path} ${where}`}
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <span className="mr-auto text-xs text-dim">Sent with your review</span>
        <Button size="xs" variant="ghost" onClick={props.onDone}>
          Cancel
        </Button>
        <Button size="xs" disabled={!body.trim()} onClick={submit}>
          Add to review
        </Button>
      </div>
    </div>
  )
}
