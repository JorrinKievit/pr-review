import { useAtomSet } from '@effect/atom-react'
import type { PrRef, PrView } from '@pr-review/domain'
import { useAtoms } from '../atoms.ts'
import { githubFilesUrl } from '../Setup.tsx'
import { Button } from '../ui/index.tsx'

/** A PR whose review the reviewer stopped: nothing runs until they start it again. */
export function Stopped({ prRef, pr }: { prRef: PrRef; pr: PrView }) {
  const resume = useAtomSet(useAtoms().resumeReviewAtom)
  return (
    <main className="mx-auto mt-24 max-w-[38rem] px-6">
      <p className="text-sm text-dim">
        {pr.owner}/{pr.repo} #{pr.number}
      </p>
      <h1 className="mb-3 text-lg font-medium">{pr.title}</h1>
      <p className="mb-5 text-muted-foreground">You stopped Claude's review of this PR.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => resume({ ref: prRef, headSha: pr.headSha })}>
          Start review
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href={githubFilesUrl(prRef)}>Open on GitHub</a>
        </Button>
      </div>
    </main>
  )
}
