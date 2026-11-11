import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { type DecisionOpinion, type Finding, type FindingStates, type PrRef, rankFindings, type Severity } from '@pr-review/domain'
import { AsyncResult } from 'effect/reactivity'
import { useState } from 'react'
import { useAtoms } from '../atoms.ts'
import { cn } from '../lib/utils.ts'
import { failureOf } from '../result.ts'
import { Button, Pill, Working } from '../ui/index.tsx'
import { useDrafts } from './drafts.ts'

export const severityLabel: Record<Severity, string> = { blocks: 'Blocks merge', should: 'Should fix', ask: 'Worth asking' }
const severityShort: Record<Severity, string> = { blocks: 'Blocks', should: 'Should fix', ask: 'Ask' }
export const severityTone: Record<Severity, string> = { blocks: 'border-destructive/40 text-destructive', should: 'border-warn/40 text-warn', ask: 'border-info/40 text-info' }

export const SeverityPill = ({ severity, short }: { severity: Severity; short?: boolean }) => (
  <Pill className={severityTone[severity]}>{(short ? severityShort : severityLabel)[severity]}</Pill>
)

/** Neither posted nor dismissed, and not already handled higher in the stack. */
export const isOpen = (f: Finding, states: FindingStates) => !states[f.id] && f.handledIn === null

/** Every finding on the PR, worst first; a row opens its decision. */
export function FindingsList(props: { findings: ReadonlyArray<Finding>; states: FindingStates; prNumber: number; titles: Readonly<Record<string, string>>; onOpen: (decisionId: string) => void }) {
  const rows = rankFindings(
    props.findings.filter((f) => props.states[f.id] !== 'dismissed'),
    [props.prNumber],
  )
  return (
    <ul aria-label="Findings" className="flex flex-col gap-1">
      {rows.map((f) => (
        <li key={f.id}>
          <button
            type="button"
            disabled={f.decisionId === null}
            onClick={() => f.decisionId !== null && props.onOpen(f.decisionId)}
            className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left hover:bg-accent/60"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <SeverityPill severity={f.severity} />
              <b className="min-w-0 truncate font-medium">{f.title}</b>
              {f.decisionId !== null && <span className="ml-auto shrink-0 text-xs text-dim">{props.titles[f.decisionId]}</span>}
            </span>
            <span className={cn('text-muted-foreground', !isOpen(f, props.states) && 'text-dim')}>{f.take}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The decision's opinion under its note: the author's case, then the findings, with a deeper look on the strongest model. */
export function DecisionFindings(props: { prRef: PrRef; headSha: string; prNumber: number; decisionId: string; opinion: DecisionOpinion | undefined; states: FindingStates }) {
  const { opinion, states } = props
  const [digging, setDigging] = useState(false)
  const findings = rankFindings(opinion?.findings ?? [], [props.prNumber])
  const dismissed = findings.filter((f) => states[f.id] === 'dismissed')
  return (
    <section aria-label="Claude's opinion" className="mb-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm text-dim">
        <span>{opinion?.deep ? 'Deeper look' : "Claude's opinion"}</span>
        {digging && !opinion?.deep ? (
          <Deeper {...props} />
        ) : (
          !opinion?.deep && (
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setDigging(true)}>
              Dig deeper
            </Button>
          )
        )}
      </div>
      {opinion && (
        <p className="text-muted-foreground">
          <span className="text-foreground">Author's case:</span> {opinion.authorCase}
        </p>
      )}
      {opinion && findings.length === 0 && opinion.checked && <p className="text-muted-foreground">{opinion.checked}</p>}
      {findings
        .filter((f) => states[f.id] !== 'dismissed')
        .map((f) => (
          <FindingCard key={f.id} {...props} finding={f} />
        ))}
      {dismissed.length > 0 && (
        <details className="text-sm text-dim">
          <summary className="cursor-pointer">{dismissed.length} dismissed</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {dismissed.map((f) => (
              <li key={f.id} className="flex items-center gap-1.5">
                <SeverityPill severity={f.severity} />
                <span className="min-w-0 truncate">{f.title}</span>
                <RestoreButton {...props} findingId={f.id} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function Deeper(props: { prRef: PrRef; headSha: string; decisionId: string }) {
  const atom = useAtoms().deeperAtom(props.prRef, props.headSha, props.decisionId)
  const result = useAtomValue(atom)
  const retry = useAtomRefresh(atom)
  if (AsyncResult.isFailure(result))
    return (
      <span className="ml-auto flex items-center gap-1.5 text-destructive">
        {String((failureOf(result) as { message?: string } | undefined)?.message ?? 'The deeper look failed')}
        <Button size="xs" variant="outline" onClick={retry}>
          Try again
        </Button>
      </span>
    )
  const e = AsyncResult.isSuccess(result) ? result.value : undefined
  return e?._tag === 'Done' ? null : <Working className="ml-auto" step={e?.step} startedAt={e?.startedAt} />
}

const useFindingState = (prRef: PrRef, headSha: string) => {
  const set = useAtomSet(useAtoms().findingStateAtom)
  return (findingId: string, state: 'posted' | 'dismissed' | null) => set({ ref: prRef, headSha, findingId, state })
}

function RestoreButton(props: { prRef: PrRef; headSha: string; findingId: string }) {
  const setState = useFindingState(props.prRef, props.headSha)
  return (
    <button type="button" className="ml-auto hover:text-foreground" onClick={() => setState(props.findingId, null)}>
      Restore
    </button>
  )
}

function FindingCard(props: { prRef: PrRef; headSha: string; finding: Finding; states: FindingStates }) {
  const f = props.finding
  const setState = useFindingState(props.prRef, props.headSha)
  const { add } = useDrafts(props.prRef)
  const post = () => {
    if (!f.anchor || !f.comment) return
    add({ path: f.anchor.path, line: f.anchor.line, side: 'RIGHT', body: f.comment })
    setState(f.id, 'posted')
  }
  return (
    <section aria-label={f.title} className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityPill severity={f.severity} />
        <span className="text-xs text-dim">
          {f.axis} · {f.kind}
        </span>
        {!f.verified && <Pill className="text-warn">not verified</Pill>}
        {f.handledIn !== null && <Pill>Handled in #{f.handledIn}</Pill>}
      </div>
      <h3 className="mt-1.5 font-medium">{f.title}</h3>
      <p className="mt-0.5 text-muted-foreground">{f.take}</p>
      {f.evidence.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1 text-sm">
          {f.evidence.map((e, i) =>
            e.ref === 'docs' ? (
              <li key={i} className="text-muted-foreground">{`${e.path}: ${e.quote}`}</li>
            ) : (
              <li key={i} className="flex min-w-0 flex-col">
                <code className="font-mono text-xs text-dim">{`${e.repo ? `${e.repo} ` : ''}${e.path}:${e.line}`}</code>
                <code className="truncate font-mono text-xs">{e.quote}</code>
              </li>
            ),
          )}
        </ul>
      )}
      {f.alternative && (
        <p className="mt-1.5 text-muted-foreground">
          <span className="text-foreground">Instead:</span> <span>{f.alternative}</span>
        </p>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        {props.states[f.id] === 'posted' ? (
          <span className="text-sm text-ok">In your review</span>
        ) : (
          <>
            {f.anchor && f.comment && (
              <Button size="xs" variant="outline" onClick={post}>
                Use as comment
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={() => setState(f.id, 'dismissed')}>
              Dismiss
            </Button>
          </>
        )}
      </div>
    </section>
  )
}
