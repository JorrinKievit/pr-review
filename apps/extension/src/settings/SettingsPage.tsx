import { type AccountStatus, type AgentAccount, agentPresets, defaultSettings, type RepoSettings, Settings } from '@pr-review/domain'
import { Effect, Schema } from 'effect'
import { type ReactNode, useEffect, useState } from 'react'
import { Input } from '../components/ui/input.tsx'
import { Textarea } from '../components/ui/textarea.tsx'
import { cn } from '../lib/utils.ts'
import { thisInstallLine } from '../Setup.tsx'
import { Button, Spinner } from '../ui/index.tsx'
import { companion, ext, loadSettings, saveSettings } from './store.ts'

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)
const envText = (env: Readonly<Record<string, string>>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
const envOf = (text: string) => Object.fromEntries(lines(text).flatMap((l) => (l.includes('=') ? [[l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]] : [])))

function Section(props: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-border py-5">
      <h2 className="font-medium">{props.title}</h2>
      {props.hint && <p className="mt-0.5 mb-3 text-sm text-muted-foreground">{props.hint}</p>}
      {props.children}
    </section>
  )
}

function Field(props: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1 text-sm', props.className)}>
      <span className="text-muted-foreground">{props.label}</span>
      {props.children}
      {props.hint && <span className="text-xs text-dim">{props.hint}</span>}
    </label>
  )
}

/** Lines in a textarea, kept as typed until it loses focus, so blank lines can be typed. */
function LinesField(props: { label: string; hint?: string; value: ReadonlyArray<string>; onChange: (v: string[]) => void; rows?: number }) {
  const [text, setText] = useState(props.value.join('\n'))
  return (
    <Field label={props.label} {...(props.hint ? { hint: props.hint } : {})}>
      <Textarea rows={props.rows ?? 4} className="font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => props.onChange(lines(text))} />
    </Field>
  )
}

function AccountCard(props: { account: AgentAccount; status: AccountStatus | undefined; onChange: (a: AgentAccount) => void; onRemove: () => void }) {
  const a = props.account
  const preset = agentPresets.find((p) => p.agent === a.agent)
  const [env, setEnv] = useState(envText(a.env))
  const set = (patch: Partial<AgentAccount>) => props.onChange({ ...a, ...patch })
  /** Empty clears an optional field. */
  const setOptional = (key: 'mode' | 'model', value: string) => {
    const { [key]: _, ...rest } = a
    props.onChange(value ? { ...rest, [key]: value } : rest)
  }
  return (
    <div className={cn('rounded-lg border border-border bg-card p-3', !a.enabled && 'opacity-60')}>
      <div className="mb-3 flex items-center gap-2">
        <Input aria-label="Account name" className="h-8 max-w-64 font-medium" value={a.name} onChange={(e) => set({ name: e.target.value })} />
        <span className="text-sm text-dim">{preset?.name ?? 'Custom agent'}</span>
        <StatusLine status={props.status} />
        <label className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground">
          <input type="checkbox" checked={a.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> In the pool
        </label>
        <Button size="xs" variant="ghost" onClick={props.onRemove}>
          Remove
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Command" hint="Starts the agent's ACP server." className="sm:col-span-2">
          <Input className="font-mono text-sm" value={a.command} onChange={(e) => set({ command: e.target.value })} />
        </Field>
        <Field label="Environment" hint={preset?.loginEnv ? `One per line. A separate ${preset.loginEnv} is a separate login.` : 'One KEY=value per line.'}>
          <Textarea rows={2} className="font-mono text-sm" value={env} placeholder={preset?.loginEnv ? `${preset.loginEnv}=~/.my-other-login` : ''} onChange={(e) => setEnv(e.target.value)} onBlur={() => set({ env: envOf(env) })} />
        </Field>
        <div className="flex gap-4 text-sm text-muted-foreground sm:col-span-2">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={a.tickets ?? false} onChange={(e) => set({ tickets: e.target.checked })} /> Can read tickets
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={a.deep ?? false} onChange={(e) => set({ deep: e.target.checked })} /> Use for Dig deeper
          </label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Mode" hint="Read-only mode">
            <Input className="font-mono text-sm" value={a.mode ?? ''} placeholder="auto" onChange={(e) => setOptional('mode', e.target.value)} />
          </Field>
          <Field label="Model" hint="Agent default if empty">
            <Input className="font-mono text-sm" value={a.model ?? ''} onChange={(e) => setOptional('model', e.target.value)} />
          </Field>
          <Field label="At once">
            <Input type="number" min={1} max={8} value={a.concurrency} onChange={(e) => set({ concurrency: Math.max(1, Number(e.target.value) || 1) })} />
          </Field>
        </div>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings>()
  const [status, setStatus] = useState<{ tone: 'ok' | 'error' | 'busy'; text: string }>()
  const [connection, setConnection] = useState<string>('Checking the companion…')
  const [pool, setPool] = useState<ReadonlyArray<AccountStatus>>([])

  useEffect(() => {
    void Effect.runPromise(loadSettings).then(setSettings)
    void Effect.runPromise(
      companion((c) => c.Health()).pipe(
        Effect.timeout('10 seconds'),
        Effect.match({
          onSuccess: ({ version }) => `Connected to companion ${version}.`,
          onFailure: (e) =>
            e._tag === 'CompanionUnavailable' && e.reason === 'not-installed'
              ? `The companion is not installed. Run this in a terminal, then reload: ${thisInstallLine()}`
              : e._tag === 'CompanionUnavailable' && e.reason === 'mismatch'
                ? `The companion is from a different release than this extension. Run this to update it, then reload: ${thisInstallLine()}`
                : 'The companion did not answer.',
        }),
      ),
    ).then(setConnection)
    const poll = () => void Effect.runPromise(companion((c) => c.PoolStatus()).pipe(Effect.orElseSucceed(() => []))).then(setPool)
    poll()
    const timer = setInterval(poll, 5000)
    return () => clearInterval(timer)
  }, [])

  if (!settings)
    return (
      <main className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Spinner /> Loading settings…
      </main>
    )

  const review = settings.review
  const setReview = (patch: Partial<Settings['review']>) => setSettings({ ...settings, review: { ...review, ...patch } })
  const setAccount = (i: number, a: AgentAccount) => setSettings({ ...settings, accounts: settings.accounts.map((x, j) => (j === i ? a : x)) })
  const addAccount = (agent: string) => {
    const p = agentPresets.find((x) => x.agent === agent)
    const account: AgentAccount = {
      id: crypto.randomUUID(),
      name: p?.name ?? 'Custom agent',
      agent: p?.agent ?? 'custom',
      command: p?.command ?? '',
      env: {},
      ...(p?.mode ? { mode: p.mode } : {}),
      concurrency: 2,
      enabled: true,
    }
    setSettings({ ...settings, accounts: [...settings.accounts, account] })
  }

  const save = async () => {
    const decoded = Schema.decodeUnknownExit(Settings)(settings)
    if (decoded._tag === 'Failure') return setStatus({ tone: 'error', text: 'Some settings are not valid.' })
    setStatus({ tone: 'busy', text: 'Saving…' })
    // Hosts other than github.com need the browser's permission to open their PR pages here.
    const origins = settings.hosts.filter((h) => h !== 'github.com').map((h) => `https://${h}/*`)
    const granted = origins.length === 0 || (await ext().permissions.request({ origins }).catch(() => false))
    await Effect.runPromise(Effect.result(saveSettings(settings))).then((r) =>
      setStatus(
        r._tag === 'Failure'
          ? { tone: 'error', text: 'Saved in the browser, but the companion did not take them. It gets them the next time it starts.' }
          : granted
            ? { tone: 'ok', text: 'Saved.' }
            : { tone: 'error', text: 'Saved, but without permission for the extra hosts their PR pages will not open here.' },
      ),
    )
  }

  return (
    <main className="mx-auto max-w-[52rem] px-6 py-8">
      <h1 className="text-lg font-medium">PR Review settings</h1>
      <p className="mb-5 text-sm text-muted-foreground">{connection}</p>

      <Section title="GitHub hosts" hint="PR pages on these hosts open in the review. The companion uses your gh login: run gh auth login --hostname <host> for each.">
        <LinesField label="Hosts" rows={3} value={settings.hosts} onChange={(hosts) => setSettings({ ...settings, hosts })} />
      </Section>

      <Section
        title="AI accounts"
        hint="Sorts and questions go to the least busy account in the pool. One that hits its usage limit sits out until it resets and the work moves to another. Agents run in a read-only mode and may only read the repo through git."
      >
        <div className="flex flex-col gap-3">
          {settings.accounts.map((a, i) => (
            <AccountCard key={a.id} account={a} status={pool.find((p) => p.id === a.id)} onChange={(next) => setAccount(i, next)} onRemove={() => setSettings({ ...settings, accounts: settings.accounts.filter((_, j) => j !== i) })} />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Add</span>
          {[...agentPresets, { agent: 'custom', name: 'Custom' }].map((p) => (
            <Button key={p.agent} size="xs" variant="outline" onClick={() => addAccount(p.agent)}>
              {p.name}
            </Button>
          ))}
        </div>
      </Section>

      <Section title="Review" hint="How PRs are sorted.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <LinesField label="Guidance files" hint="Repo files or folders with review rules, read from the default branch." value={review.guidance} onChange={(guidance) => setReview({ guidance })} />
          <LinesField label="Never trusted" hint="Globs that always need a human." value={review.neverTrust} onChange={(neverTrust) => setReview({ neverTrust })} />
          <TrustRules value={review.likelyTrusted} onChange={(likelyTrusted) => setReview({ likelyTrusted })} />
          <div className="flex flex-col gap-4">
            <Field label="Largest diff sent along (KB)" hint="Above this the agent reads the files itself.">
              <Input type="number" min={10} value={review.maxDiffKb} onChange={(e) => setReview({ maxDiffKb: Number(e.target.value) || defaultSettings.review.maxDiffKb })} />
            </Field>
            <Field label="Time limit per run (minutes)">
              <Input type="number" min={1} value={review.timeoutMinutes} onChange={(e) => setReview({ timeoutMinutes: Number(e.target.value) || defaultSettings.review.timeoutMinutes })} />
            </Field>
          </div>
        </div>
      </Section>

      <Section title="Repos" hint="Per-repo review settings, keyed host/owner/repo. Related repos go one per line as host/owner/repo: what it is, and are read at their default branch.">
        <ReposEditor value={settings.repos ?? {}} onChange={(repos) => setSettings({ ...settings, repos })} />
      </Section>

      <div className="sticky bottom-0 flex items-center gap-3 border-t border-border bg-background/95 py-3 backdrop-blur">
        <Button onClick={() => void save()}>Save</Button>
        <Button variant="ghost" onClick={() => setSettings(defaultSettings)}>
          Reset to defaults
        </Button>
        {status && <span className={cn('text-sm', status.tone === 'error' ? 'text-destructive' : status.tone === 'ok' ? 'text-ok' : 'text-muted-foreground')}>{status.text}</span>}
      </div>
    </main>
  )
}

function StatusLine(props: { status: AccountStatus | undefined }) {
  const s = props.status
  if (!s) return null
  const out = s.until > Date.now()
  const text = out ? `Sitting out until ${new Date(s.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : s.busy > 0 ? `${s.busy} running` : 'Ready'
  return (
    <span className={cn('text-xs', out ? 'text-destructive' : 'text-muted-foreground')} title={out ? (s.error ?? undefined) : undefined}>
      {text}
    </span>
  )
}

/** `group: glob, glob` per line. */
function TrustRules(props: { value: Settings['review']['likelyTrusted']; onChange: (v: Settings['review']['likelyTrusted']) => void }) {
  const [text, setText] = useState(props.value.map((r) => `${r.group}: ${r.patterns.join(', ')}`).join('\n'))
  const parse = (t: string) =>
    lines(t).flatMap((l) => {
      const at = l.indexOf(':')
      return at > 0 ? [{ group: l.slice(0, at).trim(), patterns: l.slice(at + 1).split(',').map((p) => p.trim()).filter(Boolean) }] : []
    })
  return (
    <Field label="Probably trusted" hint="group: glob, glob. The agent confirms or moves them; trusted piles start accepted.">
      <Textarea rows={6} className="font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => props.onChange(parse(text))} />
    </Field>
  )
}

const relatedText = (r: RepoSettings['related']) => r.map((x) => `${x.repo}: ${x.note}`)
const relatedOf = (ls: ReadonlyArray<string>) =>
  ls.flatMap((l) => {
    const at = l.indexOf(':')
    const repo = (at < 0 ? l : l.slice(0, at)).trim()
    return repo ? [{ repo, note: at < 0 ? '' : l.slice(at + 1).trim() }] : []
  })

/** Rows are kept locally so a repo with no name yet can be typed; only named ones are saved. */
function ReposEditor(props: { value: Readonly<Record<string, RepoSettings>>; onChange: (v: Record<string, RepoSettings>) => void }) {
  const [rows, setRows] = useState(() => Object.entries(props.value).map(([key, repo]) => ({ id: crypto.randomUUID(), key, repo })))
  const update = (next: typeof rows) => {
    setRows(next)
    props.onChange(Object.fromEntries(next.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.repo])))
  }
  const patch = (id: string, p: Partial<(typeof rows)[number]>) => update(rows.map((r) => (r.id === id ? { ...r, ...p } : r)))
  return (
    <>
      <div className="flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border border-border bg-card p-3">
            <div className="mb-3 flex items-end gap-2">
              <Field label="Repo" className="flex-1">
                <Input className="font-mono text-sm" placeholder="host/owner/repo" value={r.key} onChange={(e) => patch(r.id, { key: e.target.value })} />
              </Field>
              <Button size="xs" variant="ghost" onClick={() => update(rows.filter((x) => x.id !== r.id))}>
                Remove
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <LinesField label="Related repos" value={relatedText(r.repo.related)} onChange={(ls) => patch(r.id, { repo: { ...r.repo, related: relatedOf(ls) } })} />
              <Field label="Review skill">
                <Input
                  className="font-mono text-sm"
                  placeholder="Path in this repo, read at its default branch"
                  value={r.repo.reviewSkill ?? ''}
                  onChange={(e) => {
                    const { reviewSkill: _, ...rest } = r.repo
                    patch(r.id, { repo: e.target.value ? { ...rest, reviewSkill: e.target.value } : rest })
                  }}
                />
              </Field>
            </div>
          </div>
        ))}
      </div>
      <Button className="mt-3" size="xs" variant="outline" onClick={() => update([...rows, { id: crypto.randomUUID(), key: '', repo: { related: [] } }])}>
        Add repo
      </Button>
    </>
  )
}
