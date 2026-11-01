import { type ReactNode, useEffect, useState } from 'react'
import { Spinner } from '../components/ui/spinner.tsx'
import { cn } from '../lib/utils.ts'

export { Button } from '../components/ui/button.tsx'
export { Spinner } from '../components/ui/spinner.tsx'

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('rounded border border-border bg-accent px-1 font-mono text-xs text-muted-foreground', className)}>{children}</kbd>
}

export function Pill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 text-xs text-muted-foreground', className)}>
      {children}
    </span>
  )
}

/** Status dots: hollow = open (red for architecture, amber otherwise), filled = decided, half = changed since decided. */
export type DotTone = 'open-arch' | 'open' | 'accepted' | 'pushed-back' | 'changed' | 'info' | 'idle'
const dots: Record<DotTone, string> = {
  'open-arch': 'border-destructive',
  open: 'border-warn',
  accepted: 'border-ok bg-ok',
  'pushed-back': 'border-destructive bg-destructive',
  changed: 'border-info bg-[linear-gradient(90deg,var(--color-info)_50%,transparent_50%)]',
  info: 'border-info',
  idle: 'border-dim',
}
export function Dot({ tone, className }: { tone: DotTone; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full border-[1.5px]', dots[tone], className)} />
}

/** A running job: spinner, what it is doing now and, given a start time, how long it has been going. */
export function Working({ step, startedAt, className }: { step?: string | undefined; startedAt?: string | undefined; className?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const secs = startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)) : undefined
  return (
    <span className={cn('flex min-w-0 items-center gap-2 text-muted-foreground', className)}>
      <Spinner className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{step ?? 'Starting'}</span>
      {secs !== undefined && (
        <span className="shrink-0 text-dim tabular-nums">
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
        </span>
      )}
    </span>
  )
}
