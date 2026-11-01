import { Kbd } from '../ui/index.tsx'

const hints = [
  [['j', 'k'], 'next / previous'],
  [['a'], 'accept'],
  [['p'], 'push back'],
  [['⌘J'], 'discuss'],
  [['⌘K'], 'jump to'],
  [['esc'], 'close'],
] as const

export function FooterHints() {
  return (
    <footer className="flex h-8 shrink-0 items-center gap-3.5 border-t border-border px-3 text-xs text-dim">
      {hints.map(([keys, label]) => (
        <span key={label} className="flex items-center gap-1">
          {keys.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
          {label}
        </span>
      ))}
      <span className="ml-auto">Select lines to ask Claude, or click + beside a line to comment</span>
    </footer>
  )
}
