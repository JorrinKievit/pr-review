import { useAtomSet } from '@effect/atom-react'
import { Popover } from '@base-ui/react/popover'
import type { PrRef, PrView } from '@pr-review/domain'
import { Exit } from 'effect'
import { useState } from 'react'
import { toast } from 'sonner'
import { useAtoms } from '../atoms.ts'
import { useRemembered } from '../remembered.ts'
import { errorOf } from '../result.ts'
import { Button } from '../ui/index.tsx'
import { useDrafts } from './drafts.ts'

type Event = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
const eventLabel: Record<Event, string> = { APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes', COMMENT: 'Comment' }
const doneLabel: Record<Event, string> = { APPROVE: 'Approved', REQUEST_CHANGES: 'Changes requested', COMMENT: 'Review sent' }

/** Sends the pending comments with a verdict as one GitHub review. Authors can only comment on their own PR. */
export function ReviewPopover({ prRef, pr, onSent, ...control }: { prRef: PrRef; pr: PrView; open?: boolean; onOpenChange?: (open: boolean) => void; onSent?: () => void }) {
  const { submitReviewAtom } = useAtoms()
  const submit = useAtomSet(submitReviewAtom, { mode: 'promiseExit' })
  const { drafts } = useDrafts(prRef)
  const [ownOpen, setOwnOpen] = useState(false)
  const open = control.open ?? ownOpen
  const setOpen = control.onOpenChange ?? setOwnOpen
  const [body, setBody] = useRemembered(`summary:${prRef.host}/${prRef.owner}/${prRef.repo}#${prRef.number}`, '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const own = pr.author === pr.viewer
  const events: ReadonlyArray<Event> = own ? ['COMMENT'] : ['COMMENT', 'REQUEST_CHANGES', 'APPROVE']
  const empty = !body.trim() && drafts.length === 0

  const send = async (event: Event) => {
    setBusy(true)
    setError(undefined)
    const exit = await submit({ ref: prRef, event, body, commitId: pr.headSha })
    setBusy(false)
    if (Exit.isSuccess(exit)) {
      toast(doneLabel[event])
      setOpen(false)
      setBody('')
      onSent?.()
      return
    }
    const e = errorOf(exit.cause) as { _tag?: string; message?: string } | undefined
    setError(
      e?._tag === 'ReviewRejected'
        ? `GitHub refused the review: ${e.message}. A commented line may be gone from the PR. Your comments are kept.`
        : 'The review was not sent. Your comments are kept. Try again.',
    )
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button size="xs">
            Review{drafts.length > 0 && <span className="rounded-sm bg-primary-foreground/20 px-1 tabular-nums">{drafts.length}</span>}
          </Button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-50">
          <Popover.Popup className="w-80 rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-lg outline-none">
            <p className="mb-1.5 text-sm text-muted-foreground">
              {drafts.length === 0 ? 'No pending comments' : `${drafts.length} pending ${drafts.length === 1 ? 'comment' : 'comments'}`}
            </p>
            <textarea
              aria-label="Review summary"
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Summary for the author (optional)"
              className="mb-2 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:border-primary"
            />
            {own && <p className="mb-2 text-sm text-dim">This is your PR, so GitHub only lets you comment.</p>}
            {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-1.5">
              {events.map((e) => (
                <Button key={e} size="xs" variant={e === 'APPROVE' ? 'default' : 'outline'} disabled={busy || (e !== 'APPROVE' && empty)} onClick={() => void send(e)}>
                  {eventLabel[e]}
                </Button>
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
