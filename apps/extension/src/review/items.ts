import type { Decision, DecisionState, DecisionStates, FileStat, PrView, SkimArea, SortEvent, SortResult, TrustedGroup } from '@pr-review/domain'
import type { DotTone } from '../ui/index.tsx'

export type Item =
  | { readonly kind: 'decision'; readonly key: string; readonly decision: Decision; readonly unclaimed: boolean }
  | { readonly kind: 'skim'; readonly key: string; readonly area: SkimArea }
  | { readonly kind: 'trusted'; readonly key: string; readonly group: TrustedGroup }
  | { readonly kind: 'unsorted'; readonly key: string; readonly files: ReadonlyArray<string> }
  | { readonly kind: 'description'; readonly key: string }

export const description: Item = { kind: 'description', key: 'about' }

/** Sidebar order: the description, decisions, skim areas, trusted groups. Until the sort is done every file sits in one Unsorted item. */
export function buildItems(pr: PrView, sort: SortEvent | undefined): ReadonlyArray<Item> {
  const about = pr.body.trim() ? [description] : []
  if (sort?._tag !== 'Done') return [...about, { kind: 'unsorted', key: 'unsorted', files: pr.files.map((f) => f.path) }]
  return [...about, ...itemsOf(sort.result, byTheme)]
}

/** Decisions of a theme next to each other, themes in the order Claude first named them. */
export const byTheme = (ds: ReadonlyArray<Decision>) => {
  const order = [...new Set(ds.map((d) => d.theme))]
  return [...ds].sort((a, b) => order.indexOf(a.theme) - order.indexOf(b.theme))
}

/** Where a PR opens: on its first item until reviewing has started, then on the first item still open. */
export function startAt(items: ReadonlyArray<Item>, states: DecisionStates): number {
  const ids = items.map(itemId)
  if (!ids.some((id) => id !== undefined && states[id])) return 0
  const open = ids.findIndex((id) => id !== undefined && !states[id])
  return open >= 0 ? open : Math.max(0, ids.findIndex((id) => id !== undefined))
}

export function itemsOf(result: SortResult, order: (ds: ReadonlyArray<Decision>) => ReadonlyArray<Decision> = (ds) => ds): ReadonlyArray<Item> {
  const unclaimed = new Set(result.unclaimedDecisionIds)
  return [
    ...order(result.decisions).map((decision): Item => ({ kind: 'decision', key: `d:${decision.id}`, decision, unclaimed: unclaimed.has(decision.id) })),
    ...result.skim.map((area): Item => ({ kind: 'skim', key: `s:${area.area}`, area })),
    ...result.trusted.map((group): Item => ({ kind: 'trusted', key: `t:${group.group}`, group })),
  ]
}

export const itemTone = (item: Item, verdict: DecisionState | undefined, changed = false): DotTone => {
  if (verdict) return verdict
  if (changed) return 'changed'
  if (item.kind === 'decision') return item.decision.lens === 'architecture' ? 'open-arch' : 'open'
  return 'idle'
}

export const itemFiles = (item: Item): ReadonlyArray<string> =>
  item.kind === 'decision'
    ? item.decision.files.map((f) => f.path)
    : item.kind === 'skim'
      ? item.area.files
      : item.kind === 'trusted'
        ? item.group.files
        : item.kind === 'unsorted'
          ? item.files
          : []

export const itemTitle = (item: Item) =>
  item.kind === 'decision'
    ? item.decision.title
    : item.kind === 'skim'
      ? item.area.area
      : item.kind === 'trusted'
        ? (trustedLabel[item.group.group] ?? item.group.group)
        : item.kind === 'description'
          ? 'Description'
          : 'Unsorted'

/** Names for the rule groups; Claude's own groups are named already. */
export const trustedLabel: Partial<Record<string, string>> = {
  tests: 'Tests',
  generated: 'Generated files',
  translations: 'Translations',
  lockfiles: 'Lockfiles',
}

/** The key an item's verdict is saved under: a decision's id, or the skim area or trusted group. The unsorted list has none. */
export const itemId = (item: Item): string | undefined =>
  item.kind === 'decision' ? item.decision.id : item.kind === 'skim' ? `skim:${item.area.area}` : item.kind === 'trusted' ? `trusted:${item.group.group}` : undefined

/** The next item after `from` without a verdict, wrapping; -1 when every item has one. */
export function nextOpen(items: ReadonlyArray<Item>, from: number, states: DecisionStates): number {
  for (let step = 1; step <= items.length; step++) {
    const i = (from + step) % items.length
    const id = itemId(items[i]!)
    if (id !== undefined && !states[id]) return i
  }
  return -1
}

export const linesIn = (files: ReadonlyArray<FileStat>, paths: ReadonlyArray<string>) => {
  const set = new Set(paths)
  return files.filter((f) => set.has(f.path)).reduce((n, f) => n + f.additions + f.deletions, 0)
}

export type Verdict = DecisionState | undefined
