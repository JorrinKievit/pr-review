import type { Phase, PrView } from '@pr-review/domain'
import { Check, X } from 'lucide-react'
import { cn } from '../lib/utils.ts'
import { clock, Dot, Spinner, useNow, Working } from '../ui/index.tsx'

function PhaseIcon({ state }: { state: Phase['state'] }) {
  if (state === 'running') return <Spinner className="size-3 shrink-0" />
  if (state === 'done') return <Check aria-label="done" className="size-3 shrink-0 text-ok" />
  if (state === 'failed') return <X aria-label="failed" className="size-3 shrink-0 text-destructive" />
  return <Dot tone="idle" className="mx-0.5" />
}

/** The one wait before the review: each phase with what it is doing right now. */
export function Preparing({ pr, phases }: { pr: PrView; phases: ReadonlyArray<Phase> }) {
  const now = useNow()
  return (
    <main className="mx-auto mt-24 max-w-[38rem] px-6">
      <p className="text-sm text-dim">
        {pr.owner}/{pr.repo} #{pr.number}
      </p>
      <h1 className="mb-5 text-lg font-medium">{pr.title}</h1>
      {phases.length === 0 ? (
        <Working step={`Fetching #${pr.number}`} />
      ) : (
        <ol aria-label="Preparing the review" className="flex flex-col gap-2.5">
          {phases.map((p) => (
            <li key={p.id}>
              <div className="flex items-center gap-2">
                <PhaseIcon state={p.state} />
                <span className={cn('min-w-0 flex-1 truncate', p.state === 'running' ? 'text-foreground' : 'text-muted-foreground')}>{p.label}</span>
                {p.startedAt && <span className="shrink-0 text-sm text-dim tabular-nums">{clock((p.endedAt ? Date.parse(p.endedAt) : now) - Date.parse(p.startedAt))}</span>}
              </div>
              {p.state === 'running' &&
                p.workers.map((w, i) => (
                  <div key={i} className="mt-1.5 ml-5 flex min-w-0 flex-col gap-0.5 border-l border-border pl-3">
                    {p.workers.length > 1 && <span className="text-xs text-dim">{w.account}</span>}
                    {w.current && <span className="truncate">{w.current}</span>}
                    {w.step && <span className="truncate text-sm text-muted-foreground">{w.step}</span>}
                    {[...w.recent].reverse().map((r, j) => (
                      <span key={j} className="truncate text-sm text-dim opacity-70">
                        {r}
                      </span>
                    ))}
                  </div>
                ))}
            </li>
          ))}
        </ol>
      )}
    </main>
  )
}
