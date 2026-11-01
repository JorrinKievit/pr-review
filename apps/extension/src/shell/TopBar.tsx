import type { PrRef, PrView } from '@pr-review/domain'
import { ReviewPopover } from '../review/ReviewPopover.tsx'
import { githubFilesUrl } from '../Setup.tsx'
import { Kbd, Pill } from '../ui/index.tsx'

export function TopBar(props: { prRef: PrRef; pr: PrView; decided: number; total: number; reviewOpen: boolean; onReviewOpenChange: (open: boolean) => void }) {
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
      <span className="ml-auto flex items-center gap-2" aria-label="Items reviewed">
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
