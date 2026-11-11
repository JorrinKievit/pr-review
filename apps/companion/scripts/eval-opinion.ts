// Usage: [FAST_MODEL=sonnet] node scripts/eval-opinion.ts <host> <owner> <repo> <n> <reviewer> [head]
// Prepares the review of a real PR the way the review page does (Reviewer: sort and opinion in one session),
// prints each phase's duration and the account and model of each turn, and reports which of the reviewer's inline comments a finding matches.
// `head` pins an older head, e.g. the one the reviewer commented on once the PR is merged (its head is then on the base branch).
// FAST_MODEL sets every account's fastModel for this run only; the settings file is not touched.
import { NodeServices } from '@effect/platform-node'
import { type Finding, type Phase, type Severity } from '@pr-review/domain'
import { Clock, Effect, Fiber, Layer, Stream } from 'effect'
import { execFileSync } from 'node:child_process'
import { Acp } from '../src/Acp.ts'
import { Agent } from '../src/Agent.ts'
import { Config } from '../src/Config.ts'
import { Git } from '../src/Git.ts'
import { GitHub } from '../src/GitHub.ts'
import { Opiner } from '../src/Opiner.ts'
import { Reviewer } from '../src/Reviewer.ts'
import { Sorter } from '../src/Sorter.ts'
import { Store } from '../src/Store.ts'
import { Tickets } from '../src/Tickets.ts'

const [host, owner, repo, n, reviewer, head] = process.argv.slice(2)
if (!host || !owner || !repo || !n || !reviewer) throw new Error('usage: eval-opinion.ts <host> <owner> <repo> <n> <reviewer> [head]')
const fastModel = process.env.FAST_MODEL
const ref = { host, owner, repo, number: Number(n) }
const short = (s: string, max = 100) => {
  const flat = s.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
const t0 = Date.now()
const at = () => `+${Math.round((Date.now() - t0) / 1000)}s`.padStart(6)
const secs = (from?: string, to?: string) => (from && to ? `${Math.round((Date.parse(to) - Date.parse(from)) / 1000)}s` : '-')

/** The model each account's session is on now, as the agent names it. */
const models = new Map<string, string>()

const program = Effect.gen(function* () {
  const gh = yield* (yield* GitHub).forHost(host)
  const pr = yield* gh.getPr(owner, repo, ref.number)
  yield* (yield* Git).ensureClone(`${host}/${owner}/${repo}`)
  const headSha = head ?? pr.headSha
  const rv = yield* Reviewer

  const started = Date.now()
  yield* rv.prepare(ref, headSha)
  let last: ReadonlyArray<Phase> = []
  const seen = new Map<string, string>()
  const watch = yield* Effect.forkChild(
    Stream.runForEach(rv.progress(ref, headSha), (ps) =>
      Effect.sync(() => {
        last = ps
        for (const p of ps) {
          const line = `${p.state} ${p.label}`
          if (seen.get(p.id) !== line) console.log(`${at()} ${p.id}: ${line}`)
          seen.set(p.id, line)
        }
      }),
    ),
  )
  const review = yield* rv.result(ref, headSha)
  const wall = Math.round((Date.now() - started) / 1000)
  yield* Fiber.interrupt(watch)

  console.log(`\nphases (wall ${wall}s)`)
  for (const p of last) console.log(`  ${p.id.padEnd(8)} ${p.state.padEnd(7)} ${secs(p.startedAt, p.endedAt).padStart(5)}  ${p.label}  [${p.workers.map((w) => w.account).join(', ')}]`)
  if (review.opinionError) console.log(`opinion error: ${review.opinionError}`)

  const { sort, opinion } = review
  const filesOf = new Map(sort.decisions.map((d) => [d.id, new Set(d.files.map((f) => f.path))]))
  const findings = opinion?.decisions.flatMap((d) => d.findings) ?? []
  console.log(`\nhead ${sort.headSha}${sort.quick ? ', quick path' : ''}, ${sort.decisions.length} decisions, ${findings.length} findings`)
  for (const s of ['blocks', 'should', 'ask'] satisfies ReadonlyArray<Severity>) {
    const of = findings.filter((f) => f.severity === s)
    console.log(`\n${s} (${of.length})`)
    for (const f of of) console.log(`  ${f.id} [${f.kind}${f.verified ? '' : ', unverified'}] ${f.title} @ ${f.anchor ? `${f.anchor.path}:${f.anchor.line}` : '-'}\n      ${short(f.take, 160)}`)
  }

  const matches = (f: Finding, path: string, line: number | null) =>
    (f.anchor?.path === path && line !== null && Math.abs(f.anchor.line - line) <= 15) || (f.decisionId !== null && filesOf.get(f.decisionId)?.has(path) === true)
  const comments = (yield* gh.listThreads(owner, repo, ref.number)).filter((t) => t.author === reviewer && t.inReplyTo === null)
  console.log(`\nreviewer comments (${comments.length})`)
  let matched = 0
  for (const c of comments) {
    const hits = findings.filter((f) => matches(f, c.path, c.line))
    if (hits.length) matched++
    console.log(`  ${hits.length ? 'HIT ' : 'miss'} ${c.path}:${c.line ?? '-'} "${short(c.body, 90)}"${hits.length ? `\n      <- ${hits.map((f) => f.id).join(', ')}` : ''}`)
  }
  console.log(`\nmatched: ${matched}/${comments.length} reviewer comments`)
})

/** Records the model each session switches to, so turns can say what they ran on. */
const acpTraced = Layer.effect(
  Acp,
  Effect.gen(function* () {
    const acp = yield* Acp
    return Acp.of({
      open: (account, cwd, resume, o) =>
        Effect.map(acp.open(account, cwd, resume, o), (s) => {
          models.set(account.id, account.model ?? s.defaultModel ?? '?')
          return { ...s, setModel: (m) => Effect.tap(s.setModel(m), () => Effect.sync(() => void models.set(account.id, m))) }
        }),
    })
  }),
).pipe(Layer.provide(Acp.layer))

/** Prints each turn's kind, account, model and duration. */
const agentTraced = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const agent = yield* Agent
    return Agent.of({
      ...agent,
      ticket: (o) =>
        Effect.gen(function* () {
          const from = yield* Clock.currentTimeMillis
          const out = yield* agent.ticket(o)
          console.log(`${at()} ticket read (${o.model ?? 'main'}): ${Math.round(((yield* Clock.currentTimeMillis) - from) / 1000)}s`)
          return out
        }),
      session: (o, use) =>
        agent.session(o, (turns, account) =>
          use(
            {
              structured: (prompt, schema, model, kind) =>
                Effect.gen(function* () {
                  const from = yield* Clock.currentTimeMillis
                  const out = yield* turns.structured(prompt, schema, model, kind).pipe(
                    Effect.tapError((e) => Effect.sync(() => console.log(`${at()} turn ${kind ?? o.log.kind} on ${account.name} failed: ${e.message}`))),
                  )
                  const s = Math.round(((yield* Clock.currentTimeMillis) - from) / 1000)
                  console.log(`${at()} turn ${kind ?? o.log.kind} (${model ?? 'main'}) on ${account.name}, model ${models.get(account.id) ?? '?'}: ${s}s`)
                  return out
                }),
            },
            account,
          ),
        ),
    })
  }),
).pipe(Layer.provide(Agent.layer.pipe(Layer.provide(acpTraced))))

const config = fastModel
  ? Layer.effect(
      Config,
      Effect.gen(function* () {
        const c = yield* Config
        return Config.of({ ...c, settings: Effect.map(c.settings, (s) => ({ ...s, accounts: s.accounts.map((a) => ({ ...a, fastModel })) })) })
      }),
    ).pipe(Layer.provide(Config.layer))
  : Config.layer

// Git.fetchPr always resolves the PR's current head; a pinned head gets its own merge base with the base branch.
const pinned = Layer.effect(
  Git,
  Effect.gen(function* () {
    const git = yield* Git
    return Git.of({
      ...git,
      fetchPr: (key, number, baseRef, wanted) =>
        number === ref.number && head
          ? Effect.map(git.fetchPr(key, number, baseRef, wanted), (s) => {
              const run = (...args: string[]) => execFileSync('git', args, { cwd: git.dir(key), encoding: 'utf8' }).trim()
              const onBase = run('merge-base', s.baseSha, head)
              // A merge commit put the head on the base branch: diff against the base as it was just before that merge.
              const merge = onBase === head ? run('rev-list', '--ancestry-path', '--merges', '--reverse', `${head}..${s.baseSha}`).split('\n')[0] : undefined
              return { ...s, headSha: head, mergeBase: merge ? run('merge-base', `${merge}^1`, head) : onBase }
            })
          : git.fetchPr(key, number, baseRef, wanted),
    })
  }),
).pipe(Layer.provide(Git.layer))
const gitLayer = head ? pinned : Git.layer

const layer = Reviewer.layer.pipe(
  Layer.provideMerge(Opiner.layer),
  Layer.provideMerge(Layer.mergeAll(Sorter.layer, Tickets.layer)),
  Layer.provideMerge(Layer.mergeAll(gitLayer, GitHub.layer, Store.layer)),
  Layer.provideMerge(agentTraced),
  Layer.provideMerge(gitLayer),
  Layer.provide(config),
  Layer.provide(NodeServices.layer),
)
await Effect.runPromise(program.pipe(Effect.provide(layer)))
