import type { CompanionUnavailable, PrRef } from '@pr-review/domain'
import { toast } from 'sonner'
import { Button } from './ui/index.tsx'

const REPO = 'https://github.com/JorrinKievit/pr-review'

export const githubFilesUrl = (ref: PrRef) => `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}/files?native=1`

/** Installs or updates the companion of one release. Store builds for Chromium get their id from the store, so they pass it. */
export const installLine = (version: string, chromiumId?: string) =>
  `curl -fsSL ${REPO}/releases/download/v${version}/install.sh | sh${chromiumId ? ` -s -- --extension-id ${chromiumId}` : ''}`

/** The line for this build of the extension. */
export const thisInstallLine = () =>
  installLine(chrome.runtime.getManifest().version, chrome.runtime.getURL('').startsWith('chrome-extension://') ? chrome.runtime.id : undefined)

function InstallLine() {
  const line = thisInstallLine()
  return (
    <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
      <code className="min-w-0 flex-1 font-mono text-sm break-all">{line}</code>
      <Button size="xs" variant="outline" onClick={() => void navigator.clipboard.writeText(line).then(() => toast('Copied'))}>
        Copy
      </Button>
    </div>
  )
}

/** Shown when the native companion is missing, stopped answering, or is from another release. */
export function Setup({ prRef, reason }: { prRef: PrRef; reason: CompanionUnavailable['reason'] }) {
  return (
    <main className="mx-auto mt-24 max-w-[40rem] px-6">
      {reason === 'not-installed' && (
        <>
          <h1 className="mb-2 text-lg font-medium">Install the companion</h1>
          <p className="mb-2 text-muted-foreground">
            PR Review does its work on your machine. A small companion program fetches the PR with git and runs it past your own AI agent logins (Claude Code, Codex
            and others).
          </p>
          <p className="mb-4 text-muted-foreground">
            Browsers only start a local program that has been registered with them, and they don't let an extension register one itself. Run this once in a
            terminal (inside WSL if that is where you work), then reload this page:
          </p>
          <InstallLine />
          <p className="mb-4 text-sm text-dim">
            It downloads the companion to <code>~/.local/share/pr-review</code> and tells Chrome, Edge and Firefox where it is. The browser starts it while a review
            is open. It needs Node 24 or later, and <code>gh auth login</code> and <code>gh auth setup-git</code> for each GitHub host you review on.{' '}
            <a className="text-primary hover:underline" href={`${REPO}#why-the-companion-needs-installing`}>
              More about the companion
            </a>
          </p>
        </>
      )}
      {reason === 'mismatch' && (
        <>
          <h1 className="mb-2 text-lg font-medium">Update the companion</h1>
          <p className="mb-4 text-muted-foreground">The companion on this machine is from a different release than this extension. Run this to install the matching one, then reload this page:</p>
          <InstallLine />
        </>
      )}
      {reason === 'disconnected' && (
        <>
          <h1 className="mb-2 text-lg font-medium">The companion stopped</h1>
          <p className="mb-4 text-muted-foreground">The companion exited. Reload this page to start it again. If it keeps stopping, check ~/.cache/pr-review/host.log.</p>
        </>
      )}
      <a className="text-primary hover:underline" href={githubFilesUrl(prRef)}>
        Open on GitHub instead
      </a>
    </main>
  )
}
