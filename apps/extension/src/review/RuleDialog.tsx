import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { appendPatch, type PrRef, type RuleDraft, ruleBranch, ruleTitle } from '@pr-review/domain'
import { AsyncResult } from 'effect/reactivity'
import { useState } from 'react'
import { toast } from 'sonner'
import { useAtoms } from '../atoms.ts'
import { failureOf } from '../result.ts'
import { Button, Working } from '../ui/index.tsx'

const field = 'w-full rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:border-primary'
const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast('Copied'))

/** Claude drafts a rule for the repo's review guidance from `text`; the reviewer edits it and copies the patch. Nothing is committed. */
export function RuleDialog(props: { prRef: PrRef; text: string; onClose: () => void }) {
  const atom = useAtoms().ruleAtom(props.prRef, props.text)
  const result = useAtomValue(atom)
  const retry = useAtomRefresh(atom)
  return (
    <section role="dialog" aria-label="Make it a rule" className="mt-2 flex flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2.5 font-sans text-base whitespace-normal">
      {AsyncResult.isSuccess(result) ? (
        <Editor draft={result.value} onClose={props.onClose} />
      ) : AsyncResult.isFailure(result) ? (
        <div className="flex items-center gap-1.5 text-destructive">
          {String((failureOf(result) as { message?: string } | undefined)?.message ?? 'Claude could not draft a rule')}
          <Button size="xs" variant="outline" onClick={retry}>
            Try again
          </Button>
          <Button size="xs" variant="ghost" onClick={props.onClose}>
            Close
          </Button>
        </div>
      ) : (
        <Working step="Drafting a rule" />
      )}
    </section>
  )
}

function Editor({ draft, onClose }: { draft: RuleDraft; onClose: () => void }) {
  const [path, setPath] = useState(draft.path)
  const [rule, setRule] = useState(draft.text)
  const same = path === draft.path
  const patch = path.trim() && rule.trim() ? appendPatch(path.trim(), same ? draft.old : null, rule) : ''
  const branch = ruleBranch(rule)
  const title = ruleTitle(rule)
  return (
    <>
      <label className="flex flex-col gap-1 text-sm text-dim">
        File
        <input value={path} onChange={(e) => setPath(e.target.value)} className={`${field} font-mono text-sm`} />
      </label>
      {!same && <p className="text-sm text-warn">Patch assumes a new file</p>}
      <label className="flex flex-col gap-1 text-sm text-dim">
        Rule
        <textarea rows={3} value={rule} onChange={(e) => setRule(e.target.value)} className={field} />
      </label>
      <pre aria-label="Patch" className="max-h-60 overflow-auto rounded-md border border-border bg-card px-2 py-1.5 font-mono text-xs">
        {patch}
      </pre>
      <p className="text-sm text-muted-foreground">
        Branch <code className="font-mono text-xs">{branch}</code>
        <br />
        Title <span>{title}</span>
      </p>
      <div className="flex items-center justify-end gap-1.5">
        <span className="mr-auto text-xs text-dim">Nothing is committed or pushed</span>
        <Button size="xs" variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button size="xs" variant="outline" disabled={!branch.slice(6)} onClick={() => copy(`${branch}\n${title}`)}>
          Copy branch and title
        </Button>
        <Button size="xs" disabled={!patch} onClick={() => copy(patch)}>
          Copy patch
        </Button>
      </div>
    </>
  )
}
