import { useAtomValue } from '@effect/atom-react'
import type { PrRef } from '@pr-review/domain'
import { AsyncResult } from 'effect/reactivity'
import { useEffect } from 'react'
import { useAtoms } from './atoms.ts'
import { Spinner } from './ui/index.tsx'

/** Where GitHub's "Files changed" lands: a stacked PR opens the stack view, any other PR its own view. */
export function OpenPage({ prRef, go }: { prRef: PrRef; go: (view: 'pr' | 'stack') => void }) {
  const { prAtom } = useAtoms()
  const pr = useAtomValue(prAtom(prRef))
  // A failure goes to the PR view, which explains it.
  const view = AsyncResult.isSuccess(pr) ? (pr.value.stack.length > 1 ? 'stack' : 'pr') : AsyncResult.isFailure(pr) ? 'pr' : undefined
  useEffect(() => void (view && go(view)), [view])
  return (
    <main className="flex h-full items-center justify-center gap-2 text-muted-foreground">
      <Spinner /> Opening #{prRef.number}…
    </main>
  )
}
