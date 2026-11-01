import type { DecisionStates, Rereview, SortResult } from '@pr-review/domain'
import { cn } from '../lib/utils.ts'
import { type Item, itemFiles, itemId, itemTitle, itemTone } from '../review/items.ts'
import { Dot, Spinner } from '../ui/index.tsx'

/** Piles in review order. The bar shows where the changed lines went: decisions, skim, trusted. */
export function Sidebar(props: { items: ReadonlyArray<Item>; selected: number; states: DecisionStates; rereview: Rereview; result: SortResult | undefined; onSelect: (i: number) => void }) {
  const groups = [
    { label: 'PR', kind: 'description' },
    { label: 'Decisions', kind: 'decision' },
    { label: 'Skim', kind: 'skim' },
    { label: 'Trusted', kind: 'trusted' },
    { label: 'Sorting', kind: 'unsorted' },
  ] as const
  const lines = props.result?.lines
  const total = lines ? lines.decision + lines.skim + lines.trusted || 1 : 1

  return (
    <nav aria-label="Review items" className="w-64 shrink-0 overflow-y-auto border-r border-border bg-card px-1.5 py-2">
      {lines && (
        <div className="mx-2 mt-0.5 mb-1.5 flex h-1 gap-0.5 overflow-hidden rounded-sm" title={`${lines.decision} lines to read, ${lines.skim} to skim, ${lines.trusted} trusted`}>
          <i className="block rounded-sm bg-destructive" style={{ width: `${(lines.decision / total) * 100}%` }} />
          <i className="block rounded-sm bg-warn" style={{ width: `${(lines.skim / total) * 100}%` }} />
          <i className="block rounded-sm bg-dim" style={{ width: `${(lines.trusted / total) * 100}%` }} />
        </div>
      )}
      {groups.map((g) => {
        const rows = props.items.map((item, i) => ({ item, i })).filter((r) => r.item.kind === g.kind)
        if (rows.length === 0) return null
        const decided = g.kind === 'unsorted' || g.kind === 'description' ? undefined : rows.filter((r) => props.states[itemId(r.item) ?? '']).length
        return (
          <section key={g.kind}>
            <h3 className="flex justify-between px-2 pt-2.5 pb-1 text-xs font-normal text-dim">
              <span className="flex items-center gap-1.5">
                {g.label}
                {g.kind === 'unsorted' && <Spinner className="size-3" />}
              </span>
              <span>{decided !== undefined ? `${decided} / ${rows.length}` : g.kind === 'description' ? '' : rows.reduce((n, r) => n + itemFiles(r.item).length, 0)}</span>
            </h3>
            {rows.map(({ item, i }) => (
              <button
                key={item.key}
                type="button"
                aria-current={i === props.selected}
                onClick={() => props.onSelect(i)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-accent/60',
                  i === props.selected && 'bg-accent text-foreground',
                )}
              >
                <Dot tone={itemTone(item, props.states[itemId(item) ?? ''], (itemId(item) ?? '') in props.rereview)} />
                <span className="min-w-0 flex-1 truncate">{item.kind === 'unsorted' ? 'All files' : itemTitle(item)}</span>
                {item.kind !== 'decision' && item.kind !== 'description' && <span className="text-xs text-dim">{itemFiles(item).length}</span>}
              </button>
            ))}
          </section>
        )
      })}
    </nav>
  )
}
