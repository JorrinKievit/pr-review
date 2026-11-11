import { AgentError, AgentOpinion, type Decision, type DecisionOpinion, type Evidence, type FileStat, type GitError, type PrOpinion, type PrRef, repoSettings, type SortResult, type StackEntry } from '@pr-review/domain'
import { Context, Effect, Layer, type Stream } from 'effect'
import { PersistedCache } from 'effect/persistence'
import { readFileSync } from 'node:fs'
import { Agent } from './Agent.ts'
import { checkFinding } from './citations.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { GitHub } from './GitHub.ts'
import { type SortError, Sorter } from './Sorter.ts'
import { hunkLines, nearestLine } from './interdiff.ts'
import { citationReader, contentIds, describePr, guidanceSection, relatedSection, ticketSection } from './opinionContext.ts'
import { buildStack } from './stack.ts'
import { Tickets } from './Tickets.ts'
import { makeSteps } from './steps.ts'
import { cacheOptions, DeeperKey, OpinionKey, peek, poke, storeFailuresDie } from './Store.ts'

const bundledSkill = readFileSync(new URL('../prompts/review-skill/SKILL.md', import.meta.url), 'utf8')

type Heads = Record<string, string>
const headsOf = (prs: ReadonlyArray<StackEntry>): Heads => Object.fromEntries(prs.map((p) => [p.number, p.headSha]))
const sameHeads = (a: Heads, b: Heads) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([n, sha]) => b[n] === sha)

/**
 * Keeps what the sort and the stack can back up: the first answer per known decision, `handledIn` above this PR,
 * citations that hold, and anchors on a line of the PR's diff (`hunks`) so a drafted comment can be posted.
 */
const normalize = (
  answer: AgentOpinion,
  o: { number: number; decisions: ReadonlyArray<Decision>; deep: boolean; hunks: Hunks; above: ReadonlyArray<number>; read: (e: Evidence) => Effect.Effect<string | undefined> },
) => {
  const decisions = new Map(o.decisions.map((d) => [d.id, d]))
  const seen = new Set<string>()
  return Effect.forEach(
    answer.decisions.filter((a) => decisions.has(a.decisionId) && !seen.has(a.decisionId) && seen.add(a.decisionId)),
    (a) =>
      Effect.gen(function* () {
        const first = decisions.get(a.decisionId)!.files[0]
        const fallback = first?.ranges[0] && { path: first.path, line: first.ranges[0].start }
        const fallbackAnchor = fallback && anchorIn(o.hunks, fallback)?.line === fallback.line ? fallback : null
        const ids = contentIds(o.deep ? `${a.decisionId}:deep:` : `${a.decisionId}:`, a.findings.map((f) => `${f.title}\n${f.take}`))
        const findings = yield* Effect.forEach(a.findings, (f, i) =>
          Effect.map(checkFinding(f, o.read), (checked) => ({
            ...checked,
            id: ids[i]!,
            pr: o.number,
            decisionId: a.decisionId,
            anchor: anchorIn(o.hunks, checked.anchor) ?? fallbackAnchor,
            handledIn: checked.handledIn !== null && o.above.includes(checked.handledIn) ? checked.handledIn : null,
          })),
        )
        return { decisionId: a.decisionId, authorCase: a.authorCase, checked: a.checked, findings, deep: o.deep } satisfies DecisionOpinion
      }),
  )
}

type Hunks = ReturnType<typeof hunkLines>
type Anchor = { path: string; line: number }

/** The anchor moved to the nearest line of its file's diff, or null when its file has none. */
export const anchorIn = (hunks: Hunks, anchor: Anchor | null): Anchor | null => {
  const line = anchor ? nearestLine(hunks.get(anchor.path) ?? [], anchor.line) : undefined
  return line === undefined ? null : { path: anchor!.path, line }
}

/** New-side diff lines of the files the answer's anchors (or their fallbacks) sit in. */
export const anchorHunks = (git: Git['Service'], repoKey: string, mergeBase: string, head: string, files: ReadonlyArray<FileStat>, paths: ReadonlyArray<string>) => {
  const wanted = new Set(paths)
  const asked = files.filter((f) => wanted.has(f.path)).flatMap((f) => (f.previous ? [f.previous, f.path] : [f.path]))
  return asked.length ? Effect.map(git.diff(repoKey, mergeBase, head, asked), hunkLines) : Effect.succeed<Hunks>(new Map())
}

/** The one decision a quick sort is judged on: the change as a whole, over its Changes area. */
export const quickDecision = (sort: Pick<SortResult, 'skim'>): Decision => ({
  id: 'changes',
  title: 'The change as a whole',
  lens: 'quality',
  reason: 'convention',
  theme: 'Changes',
  note: '',
  existing: null,
  authorWhy: null,
  files: (sort.skim.find((s) => s.area === 'Changes')?.files ?? []).map((path) => ({ path, ranges: [] })),
})

/** What an opinion judges: the sort's decisions, or the quick decision on a quick sort. */
export const judged = (sort: SortResult): ReadonlyArray<Decision> => (sort.quick ? [quickDecision(sort)] : sort.decisions)

/** What opinion turns on one head share; see `Opiner.context`. */
export type OpinionContext = {
  cwd: string
  related: ReadonlyArray<string>
  prompt(decisions: ReadonlyArray<Decision>, o?: { deep?: boolean; continued?: boolean }): Effect.Effect<string>
  /** Normalizes an answer on `decisions` (see `normalize`) into the PR's opinion. */
  finish(answer: AgentOpinion, decisions: ReadonlyArray<Decision>, deep?: boolean): Effect.Effect<PrOpinion, GitError>
}

export class Opiner extends Context.Service<
  Opiner,
  {
    /** The opinion if one is cached, without running it. */
    cached(ref: PrRef, headSha: string): Effect.Effect<PrOpinion | undefined>
    /** Cached per head, until a PR above it in the stack has a new head. */
    opine(ref: PrRef, headSha: string): Effect.Effect<PrOpinion, SortError>
    /** As `Sorter.steps`. */
    steps(ref: PrRef, headSha: string, decisionId?: string): Stream.Stream<string>
    /** One decision re-run on the strongest model; replaces that decision in `cached`/`opine` results. Cached per head. */
    deeper(ref: PrRef, headSha: string, decisionId: string): Effect.Effect<DecisionOpinion, SortError>
    /** The prompt and normalizing for runs that make the opinion turns themselves. */
    context(ref: PrRef, headSha: string): Effect.Effect<OpinionContext, SortError>
    /** Saves an opinion made elsewhere, so `cached` and `opine` answer with it. */
    remember(ref: PrRef, headSha: string, opinion: PrOpinion): Effect.Effect<void>
  }
>()('pr-review/Opiner') {
  static readonly layer = Layer.effect(
    Opiner,
    Effect.gen(function* () {
      const git = yield* Git
      const github = yield* GitHub
      const agent = yield* Agent
      const config = yield* Config
      const sorter = yield* Sorter
      const tickets = yield* Tickets
      const steps = yield* makeSteps
      const keyOf = (k: { host: string; owner: string; repo: string; number: number; headSha: string }) => `${k.host}/${k.owner}/${k.repo}#${k.number}@${k.headSha}`

      /** The open PRs stacked with this one, bottom first, and those built on top of it. */
      const stackOf = Effect.fnUntraced(function* (ref: PrRef) {
        const defaultBranch = yield* git.defaultBranch(`${ref.host}/${ref.owner}/${ref.repo}`)
        const gh = yield* github.forHost(ref.host)
        const stack = buildStack([...(yield* gh.listOpenPrs(ref.owner, ref.repo))], ref.number, defaultBranch)
        const i = stack.findIndex((e) => e.number === ref.number)
        // Depth first, so a PR's children come after it: one pass collects everything built on this PR.
        const heads = new Set(stack.slice(i, i + 1).map((e) => e.headRef))
        return { stack, above: stack.slice(i + 1).filter((e) => heads.has(e.baseRef) && heads.add(e.headRef)) }
      })

      /** What opinion turns on this head share: the PR, its stack, ticket and skill, fetched once. */
      const context = Effect.fn('Opiner.context')(function* (ref: PrRef, headSha: string, report: (step: string) => Effect.Effect<void> = () => Effect.void) {
        const { host, owner, repo, number } = ref
        const repoKey = `${host}/${owner}/${repo}`
        yield* report('Fetching the PR')
        const settings = yield* config.settings
        const { review } = settings
        const gh = yield* github.forHost(host)
        const pr = yield* gh.getPr(owner, repo, number)
        const { headSha: head, mergeBase } = yield* git.fetchPr(repoKey, number, pr.baseRef, headSha)
        const [files, { stack, above }, defaultBranch, ticket] = yield* Effect.all(
          [git.numstat(repoKey, mergeBase, head), stackOf(ref), git.defaultBranch(repoKey), tickets.summary(ref, pr)],
          { concurrency: 4 },
        )
        const master = `origin/${defaultBranch}`
        const { related, reviewSkill: skillPath } = repoSettings(settings, repoKey)
        const skill = skillPath
          ? yield* git.show(repoKey, master, skillPath).pipe(
              Effect.catchTag('GitError', (e) => Effect.as(Effect.logWarning(`Review skill ${skillPath} not readable at ${master}, using the bundled one: ${e.message}`), bundledSkill)),
            )
          : bundledSkill

        yield* report(`Reading the stack (${stack.length} PRs)`)
        // Sibling PRs are context only: a cached sort when there is one, else their changed paths; never a new sort.
        const describe = (e: StackEntry) =>
          Effect.gen(function* () {
            if (e.number === number) return `#${e.number} ${e.title} (head ${e.headSha}) <- this PR`
            const sorted = yield* sorter.cached({ ...ref, number: e.number }, e.headSha)
            const changed = sorted
              ? []
              : yield* git.fetchPr(repoKey, e.number, e.baseRef, e.headSha).pipe(
                  Effect.flatMap((s) => git.numstat(repoKey, s.mergeBase, s.headSha)),
                  Effect.orElseSucceed((): ReadonlyArray<FileStat> => []),
                )
            return describePr(e, sorted, changed)
          })
        const [guidance, stackText] = yield* Effect.all(
          [review.guidance.length ? git.lsTree(repoKey, master, review.guidance) : Effect.succeed([]), Effect.forEach(stack, describe, { concurrency: 4 })],
          { concurrency: 2 },
        )

        return {
          cwd: git.dir(repoKey),
          related: related.map((r) => r.repo),
          /** `continued`: the turn follows the sort in its session, which already has the diff. */
          prompt: (decisions, o = {}) =>
            Effect.gen(function* () {
              const inDecisions = new Set(decisions.flatMap((d) => d.files.map((f) => f.path)))
              const paths = files.filter((f) => inDecisions.has(f.path)).flatMap((f) => (f.previous ? [f.previous, f.path] : [f.path]))
              // A diff git can't make is left for the agent to read itself.
              const diff = o.continued || !paths.length ? '' : yield* git.diff(repoKey, mergeBase, head, paths).pipe(Effect.orElseSucceed(() => undefined))
              return [
                skill,
                `# Refs\nPR head: ${head}\nMerge base: ${mergeBase}\nDefault branch: ${master}`,
                guidanceSection(master, guidance),
                relatedSection(related),
                ticketSection(ticket, 'judge the Spec axis from the PR description alone and say so'),
                `# Stack (bottom first; compare a PR with the one below it using git diff <head below> <its head>)\n${stackText.join('\n\n') || '(not stacked)'}`,
                `# PR #${number}: ${pr.title} (by ${pr.author})\n\n${pr.body || '(no description)'}`,
                `# Decisions\n${JSON.stringify(decisions)}`,
                o.continued
                  ? `# Diff\nIn the sort above; read files again with git show ${head}:<path> where you need more.`
                  : diff === undefined || diff.length > review.maxDiffKb * 1000
                    ? `# Diff\nDiff too large; read files with git show ${head}:<path> and compare with git diff ${mergeBase} ${head} -- <path>`
                    : `# Diff\n${diff || '(no decision files)'}`,
                ...(o.deep ? ['# Depth\nTake your time on this one decision; read every file it touches in full.'] : []),
              ].join('\n\n')
            }),
          finish: (answer, decisions, deep = false) =>
            Effect.gen(function* () {
              const read = citationReader(git, github, repoKey, related, (e) => (e.ref === 'base' ? mergeBase : head))
              const anchorPaths = [...answer.decisions.flatMap((a) => a.findings.flatMap((f) => (f.anchor ? [f.anchor.path] : []))), ...decisions.flatMap((d) => d.files.slice(0, 1).map((f) => f.path))]
              const hunks = yield* anchorHunks(git, repoKey, mergeBase, head, files, anchorPaths)
              const normalized = yield* normalize(answer, { number, decisions, deep, hunks, above: above.map((e) => e.number), read })
              return { headSha: head, ticket: ticket.text, ticketNote: ticket.note, decisions: normalized, stackHeads: headsOf(above) } satisfies PrOpinion
            }),
        } satisfies OpinionContext
      })

      const analyse = Effect.fn('Opiner.run')(function* (key: { host: string; owner: string; repo: string; number: number; headSha: string }, only?: string) {
        const { host, owner, repo, number, headSha } = key
        const ref = { host, owner, repo, number }
        const report = steps.report(only ? `${keyOf(key)}/${only}` : keyOf(key))
        const [sort, c] = yield* Effect.all([sorter.sort(ref, headSha), context(ref, headSha, report)], { concurrency: 2 })
        const decisions = only ? judged(sort).filter((d) => d.id === only) : judged(sort)
        if (only && decisions.length === 0) return yield* new AgentError({ message: `This PR has no decision ${only} to dig into` })
        // Failures aren't cached, so an empty opinion never replaces a real one.
        if (decisions.length === 0) return yield* new AgentError({ message: 'Nothing to judge' })
        const answer = yield* agent.structured({
          prompt: yield* c.prompt(decisions, { deep: only !== undefined }),
          schema: AgentOpinion,
          cwd: c.cwd,
          related: c.related,
          ...(only ? { prefer: 'deep' as const } : {}),
          log: { kind: only ? 'deeper' : 'opinion', owner, repo, number, headSha },
          onStep: report,
        })
        yield* report('Checking the citations')
        return yield* c.finish(answer, decisions, only !== undefined)
      })

      const run = (key: OpinionKey) => analyse(key)
      const runDeeper = (key: DeeperKey) =>
        Effect.flatMap(analyse(key, key.decisionId), (o) => {
          const d = o.decisions.find((x) => x.decisionId === key.decisionId)
          return d ? Effect.succeed(d) : Effect.fail(new AgentError({ message: `The agent gave no opinion on decision ${key.decisionId}` }))
        })
      const cache = yield* PersistedCache.make(run, { storeId: 'opinion', ...cacheOptions })
      const deeperCache = yield* PersistedCache.make(runDeeper, { storeId: 'deeper', ...cacheOptions })
      const read = yield* peek('opinion')
      const readDeeper = yield* peek('deeper')
      const write = yield* poke('opinion')
      const withDeeper = (ref: PrRef, headSha: string, o: PrOpinion) =>
        Effect.map(
          Effect.forEach(o.decisions, (d) => Effect.map(readDeeper(new DeeperKey({ ...ref, headSha, decisionId: d.decisionId })), (hit) => hit ?? d)),
          (decisions): PrOpinion => ({ ...o, decisions }),
        )
      return Opiner.of({
        context: (ref, headSha) => context(ref, headSha),
        remember: (ref, headSha, opinion) => {
          const key = new OpinionKey({ ...ref, headSha })
          return Effect.andThen(Effect.orDie(cache.invalidate(key)), write(key, opinion))
        },
        cached: (ref, headSha) =>
          Effect.flatMap(read(new OpinionKey({ ...ref, headSha })), (hit) => (hit ? withDeeper(ref, headSha, hit) : Effect.undefined)),
        opine: (ref, headSha) =>
          Effect.gen(function* () {
            const key = new OpinionKey({ ...ref, headSha })
            const hit = yield* read(key)
            if (hit && !sameHeads(hit.stackHeads, headsOf((yield* stackOf(ref)).above))) yield* Effect.orDie(cache.invalidate(key))
            return yield* withDeeper(ref, headSha, yield* storeFailuresDie(cache.get(key)))
          }),
        deeper: (ref, headSha, decisionId) => storeFailuresDie(deeperCache.get(new DeeperKey({ ...ref, headSha, decisionId }))),
        steps: (ref, headSha, decisionId) => steps.follow(decisionId ? `${keyOf({ ...ref, headSha })}/${decisionId}` : keyOf({ ...ref, headSha })),
      })
    }),
  )
}
