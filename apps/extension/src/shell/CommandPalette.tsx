import { Command } from 'cmdk'
import { type Item, itemTitle } from '../review/items.ts'

/** ⌘K: jump to any decision, skim area or trusted group by name. */
export function CommandPalette(props: { open: boolean; items: ReadonlyArray<Item>; onOpenChange: (open: boolean) => void; onSelect: (i: number) => void }) {
  return (
    <Command.Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      label="Jump to"
      overlayClassName="fixed inset-0 bg-black/40"
      contentClassName="fixed top-[18vh] left-1/2 w-[34rem] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
    >
      <Command.Input placeholder="Jump to…" className="h-11 w-full border-b border-border bg-transparent px-3.5 outline-none placeholder:text-dim" />
      <Command.List className="max-h-80 overflow-y-auto p-1.5">
        <Command.Empty className="px-2 py-3 text-muted-foreground">Nothing matches.</Command.Empty>
        {props.items.map((item, i) => (
          <Command.Item
            key={item.key}
            value={`${item.kind} ${itemTitle(item)}`}
            onSelect={() => {
              props.onSelect(i)
              props.onOpenChange(false)
            }}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-foreground"
          >
            <span className="w-16 text-xs text-dim">{item.kind === 'decision' ? item.decision.lens : item.kind}</span>
            {itemTitle(item)}
          </Command.Item>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
