import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import type { PrRef } from '@pr-review/domain'
import { AsyncResult } from 'effect/reactivity'
import { useAtoms } from '../atoms.ts'
import { failureOf } from '../result.ts'
import { Button, Spinner } from '../ui/index.tsx'

/**
 * The PR body as GitHub rendered it, videos and images included. GitHub sanitizes this HTML and the extension's
 * content security policy blocks scripts, so it is shown as is. Links open in a new tab.
 */
export function Description({ prRef }: { prRef: PrRef }) {
  const { descriptionAtom } = useAtoms()
  const html = useAtomValue(descriptionAtom(prRef))
  const retry = useAtomRefresh(descriptionAtom(prRef))
  if (AsyncResult.isFailure(html)) {
    const e = failureOf(html)
    return (
      <p role="alert" className="flex items-center gap-3 text-destructive">
        The description could not be loaded{e && 'message' in e ? `: ${String(e.message)}` : ''}.
        <Button size="xs" variant="outline" onClick={retry}>
          Try again
        </Button>
      </p>
    )
  }
  if (!AsyncResult.isSuccess(html))
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner className="size-3" /> Loading the description…
      </p>
    )
  return (
    <div
      className="gh-body"
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest('a')
        if (link?.href.startsWith('http')) {
          e.preventDefault()
          window.open(link.href, '_blank', 'noopener')
        }
      }}
      dangerouslySetInnerHTML={{ __html: html.value || '<p>No description.</p>' }}
    />
  )
}
