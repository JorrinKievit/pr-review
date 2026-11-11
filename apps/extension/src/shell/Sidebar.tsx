import type { DecisionStates, Finding, Rereview, SortResult } from '@pr-review/domain'
import { cn } from '../lib/utils.ts'
import { SeverityPill } from '../review/Findings.tsx'
import { type Item, itemFiles, itemId, itemTitle, itemTone, worstSeverity } from '../review/items.ts'
import { Dot, type DotTone } from '../ui/index.tsx'

type Row = { item: Item; i: number }

/** Piles in review order. The bar shows where the changed lines went: decisions, skim, trusted. */
export function Sidebar(props: {
  items: ReadonlyArray<Item>
  selected: number
  states: DecisionStates
  rereview: Rereview
  result: SortResult | undefined
  /** Claude's findings still open. */
  findings: ReadonlyArray<Finding>
  /** What the opinion found about the PR's ticket. */
  ticket?: string | undefined
  onSelect: (i: number) => void
}) {
  const groups = [
    { label: 'PR', kind: 'description' },
    { label: 'Decisions', kind: 'decision' },
    { label: 'Skim', kind: 'skim' },
    { label: 'Trusted', kind: 'trusted' },
    { label: 'Files', kind: 'unsorted' },
  ] as const
  const lines = props.result?.lines
  const total = lines ? lines.decision + lines.skim + lines.trusted || 1 : 1
  const changed = Object.keys(props.rereview).length
  const verdictOf = (item: Item) => props.states[itemId(item) ?? '']
  const worst = (rows: ReadonlyArray<Row>) => {
    const ids = new Set(rows.map((r) => itemId(r.item)))
    const s = worstSeverity(props.findings.filter((f) => ids.has(f.decisionId ?? undefined)))
    return s && <SeverityPill severity={s} short />
  }

  const row = ({ item, i }: Row) => (
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
      <Dot tone={itemTone(item, verdictOf(item), (itemId(item) ?? '') in props.rereview)} />
      <span className="min-w-0 flex-1 truncate">{item.kind === 'unsorted' ? 'All files' : itemTitle(item)}</span>
      {item.kind === 'decision' && worst([{ item, i }])}
      {item.kind !== 'decision' && item.kind !== 'description' && <span className="text-xs text-dim">{itemFiles(item).length}</span>}
    </button>
  )

  /** A theme with several decisions is one row, open while one of its decisions is. */
  const theme = (name: string, rows: ReadonlyArray<Row>) => {
    if (rows.length === 1) return row(rows[0]!)
    const open = rows.some((r) => r.i === props.selected)
    const decided = rows.filter((r) => verdictOf(r.item))
    const next = rows.find((r) => !verdictOf(r.item))
    const tone: DotTone = next ? itemTone(next.item, undefined) : rows.every((r) => verdictOf(r.item) === 'accepted') ? 'accepted' : 'pushed-back'
    return (
      <div key={`theme:${name}`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => props.onSelect((next ?? rows[0]!).i)}
          className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-accent/60', open && 'text-foreground')}
        >
          <Dot tone={tone} />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {!open && worst(rows)}
          <span className={cn('text-xs tabular-nums', decided.length === rows.length ? 'text-ok' : 'text-dim')}>{`${decided.length}/${rows.length}`}</span>
        </button>
        {open && (
          <div role="group" aria-label={name} className="mb-1 ml-3 border-l border-border pl-1">
            {rows.map(row)}
          </div>
        )}
      </div>
    )
  }

  return (
    <nav aria-label="Review items" className="w-64 shrink-0 overflow-y-auto border-r border-border bg-card px-1.5 py-2">
      {lines && (
        <div className="mx-2 mt-0.5 mb-1.5 flex h-1 gap-0.5 overflow-hidden rounded-sm" title={`${lines.decision} lines to read, ${lines.skim} to skim, ${lines.trusted} trusted`}>
          <i className="block rounded-sm bg-destructive" style={{ width: `${(lines.decision / total) * 100}%` }} />
          <i className="block rounded-sm bg-warn" style={{ width: `${(lines.skim / total) * 100}%` }} />
          <i className="block rounded-sm bg-dim" style={{ width: `${(lines.trusted / total) * 100}%` }} />
        </div>
      )}
      {props.ticket && (
        <p className="mx-2 mb-1 truncate text-xs text-dim" title={props.ticket}>
          Ticket: {props.ticket}
        </p>
      )}
      {changed > 0 && <p className="mx-2 mb-1 text-xs text-warn">{`${changed} ${changed === 1 ? 'decision' : 'decisions'} changed since you looked`}</p>}
      {groups.map((g) => {
        const rows = props.items.map((item, i) => ({ item, i })).filter((r) => r.item.kind === g.kind)
        if (rows.length === 0) return null
        const decided = g.kind === 'unsorted' || g.kind === 'description' ? undefined : rows.filter((r) => verdictOf(r.item)).length
        return (
          <section key={g.kind}>
            <h3 className="flex justify-between px-2 pt-2.5 pb-1 text-xs font-normal text-dim">
              <span>{g.label}</span>
              <span>{decided !== undefined ? `${decided} / ${rows.length}` : g.kind === 'description' ? '' : rows.reduce((n, r) => n + itemFiles(r.item).length, 0)}</span>
            </h3>
            {g.kind === 'decision'
              ? [...Map.groupBy(rows, (r) => (r.item.kind === 'decision' ? r.item.decision.theme : '')).entries()].map(([name, rs]) => theme(name, rs))
              : rows.map(row)}
          </section>
        )
      })}
    </nav>
  )
}
