import type { PrRef } from '@pr-review/domain'

export const githubFilesUrl = (ref: PrRef) => `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}/files?native=1`

/** Shown when the native companion is missing or stopped answering. */
export function Setup({ prRef, reason }: { prRef: PrRef; reason: 'not-installed' | 'disconnected' }) {
  return (
    <main className="mx-auto mt-24 max-w-[34rem] px-6">
      <h1 className="mb-2 text-lg font-medium">{reason === 'not-installed' ? 'Install the companion' : 'The companion stopped'}</h1>
      <p className="mb-4 text-muted-foreground">
        {reason === 'not-installed'
          ? 'Reviews run on your machine, through your own AI agent logins. Install the companion once, then reload this page.'
          : 'The companion exited. Reload this page to start it again. If it keeps stopping, check ~/.cache/pr-review/host.log.'}
      </p>
      {reason === 'not-installed' && (
        <pre className="mb-4 rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-sm">
          {'gh auth setup-git\napps/companion/bin/pr-review install'}
        </pre>
      )}
      <a className="text-primary hover:underline" href={githubFilesUrl(prRef)}>
        Open on GitHub instead
      </a>
    </main>
  )
}
