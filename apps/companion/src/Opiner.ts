import { AgentOpinion, type DecisionOpinion, type Evidence, type FileStat, type PrOpinion, type PrRef, repoSettings, type SortResult, type StackEntry } from '@pr-review/domain'
import { Context, Effect, Layer, type Stream } from 'effect'
import { PersistedCache } from 'effect/persistence'
import { readFileSync } from 'node:fs'
import { Agent } from './Agent.ts'
import { checkFinding } from './citations.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { GitHub } from './GitHub.ts'
import { type SortError, Sorter } from './Sorter.ts'
import { buildStack } from './stack.ts'
import { makeSteps } from './steps.ts'
import { cacheOptions, OpinionKey, peek, storeFailuresDie } from './Store.ts'

const bundledSkill = readFileSync(new URL('../prompts/review-skill/SKILL.md', import.meta.url), 'utf8')

type Heads = Record<string, string>
const headsOf = (prs: ReadonlyArray<StackEntry>): Heads => Object.fromEntries(prs.map((p) => [p.number, p.headSha]))
const sameHeads = (a: Heads, b: Heads) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([n, sha]) => b[n] === sha)

/** Keeps what the sort and the stack can back up: known decisions, PR anchors, `handledIn` above this PR, citations that hold. */
const normalize = (
  answer: AgentOpinion,
  o: { number: number; sort: SortResult; files: ReadonlyArray<FileStat>; above: ReadonlyArray<number>; read: (e: Evidence) => Effect.Effect<string | undefined> },
) => {
  const decisions = new Map(o.sort.decisions.map((d) => [d.id, d]))
  const prPaths = new Set(o.files.map((f) => f.path))
  return Effect.forEach(
    answer.decisions.filter((a) => decisions.has(a.decisionId)),
    (a) =>
      Effect.gen(function* () {
        const first = decisions.get(a.decisionId)!.files[0]
        const fallback = first ? { path: first.path, line: first.ranges[0]?.start ?? 1 } : null
        const findings = yield* Effect.forEach(a.findings, (f, i) =>
          Effect.map(checkFinding(f, o.read), (checked) => ({
            ...checked,
            id: `${a.decisionId}:${i}`,
            pr: o.number,
            decisionId: a.decisionId,
            anchor: checked.anchor && prPaths.has(checked.anchor.path) ? checked.anchor : fallback,
            handledIn: checked.handledIn !== null && o.above.includes(checked.handledIn) ? checked.handledIn : null,
          })),
        )
        return { decisionId: a.decisionId, authorCase: a.authorCase, checked: a.checked, findings, deep: false } satisfies DecisionOpinion
      }),
  )
}

export class Opiner extends Context.Service<
  Opiner,
  {
    /** The opinion if one is cached, without running it. */
    cached(ref: PrRef, headSha: string): Effect.Effect<PrOpinion | undefined>
    /** Cached per head, until a PR above it in the stack has a new head. */
    opine(ref: PrRef, headSha: string): Effect.Effect<PrOpinion, SortError>
    /** As `Sorter.steps`. */
    steps(ref: PrRef, headSha: string): Stream.Stream<string>
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

      const run = Effect.fn('Opiner.run')(function* ({ host, owner, repo, number, headSha }: OpinionKey) {
        const ref = { host, owner, repo, number }
        const repoKey = `${host}/${owner}/${repo}`
        const report = steps.report(keyOf({ ...ref, headSha }))
        yield* report('Fetching the PR')
        const settings = yield* config.settings
        const { review } = settings
        const gh = yield* github.forHost(host)
        const pr = yield* gh.getPr(owner, repo, number)
        const { headSha: head, mergeBase } = yield* git.fetchPr(repoKey, number, pr.baseRef, headSha)
        const [sort, files, { stack, above }, defaultBranch] = yield* Effect.all(
          [sorter.sort(ref, headSha), git.numstat(repoKey, mergeBase, head), stackOf(ref), git.defaultBranch(repoKey)],
          { concurrency: 4 },
        )
        const master = `origin/${defaultBranch}`
        const skillPath = repoSettings(settings, repoKey).reviewSkill
        const skill = skillPath
          ? yield* git.show(repoKey, master, skillPath).pipe(
              Effect.catchTag('GitError', (e) => Effect.as(Effect.logWarning(`Review skill ${skillPath} not readable at ${master}, using the bundled one: ${e.message}`), bundledSkill)),
            )
          : bundledSkill

        yield* report(`Reading the stack (${stack.length} PRs)`)
        // Sibling PRs are context only: a cached sort when there is one, else their changed paths; never a new sort.
        const describe = (e: StackEntry) =>
          Effect.gen(function* () {
            const title = `#${e.number} ${e.title} (head ${e.headSha})`
            if (e.number === number) return `${title} <- this PR`
            const sorted = yield* sorter.cached({ ...ref, number: e.number }, e.headSha)
            if (sorted) return [title, ...(sorted.summary ? [sorted.summary] : []), ...sorted.decisions.map((d) => `- [${d.lens}/${d.reason}] ${d.title}`)].join('\n')
            const changed = yield* git.fetchPr(repoKey, e.number, e.baseRef, e.headSha).pipe(
              Effect.flatMap((s) => git.numstat(repoKey, s.mergeBase, s.headSha)),
              Effect.orElseSucceed((): ReadonlyArray<FileStat> => []),
            )
            return [title, ...changed.map((f) => `  ${f.path}`)].join('\n')
          })
        const inDecisions = new Set(sort.decisions.flatMap((d) => d.files.map((f) => f.path)))
        const paths = files.filter((f) => inDecisions.has(f.path)).flatMap((f) => (f.previous ? [f.previous, f.path] : [f.path]))
        const [diff, guidance, stackText] = yield* Effect.all(
          [
            paths.length ? git.diff(repoKey, mergeBase, head, paths) : Effect.succeed(''),
            review.guidance.length ? git.lsTree(repoKey, master, review.guidance) : Effect.succeed([]),
            Effect.forEach(stack, describe, { concurrency: 4 }),
          ],
          { concurrency: 3 },
        )

        const prompt = [
          skill,
          `# Refs\nPR head: ${head}\nMerge base: ${mergeBase}\nDefault branch: ${master}`,
          `# Review guidance (the repo's own rules; read the ones that apply with git show ${master}:<path>)\n${guidance.join('\n') || '(none)'}`,
          '# Related repos\n(none)',
          '# Ticket\n(none)',
          `# Stack (bottom first; compare a PR with the one below it using git diff <head below> <its head>)\n${stackText.join('\n\n') || '(not stacked)'}`,
          `# PR #${number}: ${pr.title} (by ${pr.author})\n\n${pr.body || '(no description)'}`,
          `# Decisions\n${JSON.stringify(sort.decisions)}`,
          diff.length > review.maxDiffKb * 1000
            ? `# Diff\nDiff too large; read files with git show ${head}:<path> and compare with git diff ${mergeBase} ${head} -- <path>`
            : `# Diff\n${diff || '(no decision files)'}`,
        ].join('\n\n')

        const answer = yield* agent.structured({
          prompt,
          schema: AgentOpinion,
          cwd: git.dir(repoKey),
          log: { kind: 'opinion', owner, repo, number, headSha: head },
          onStep: report,
        })
        yield* report('Checking the citations')
        const read = (e: Evidence) =>
          e.ref === 'base' || e.ref === 'head' ? git.show(repoKey, e.ref === 'base' ? mergeBase : head, e.path).pipe(Effect.orElseSucceed(() => undefined)) : Effect.undefined
        const decisions = yield* normalize(answer, { number, sort, files, above: above.map((e) => e.number), read })
        return { headSha: head, ticket: null, ticketNote: 'No ticket lookup yet', decisions, stackHeads: headsOf(above) } satisfies PrOpinion
      })

      const cache = yield* PersistedCache.make(run, { storeId: 'opinion', ...cacheOptions })
      const read = yield* peek('opinion')
      return Opiner.of({
        cached: (ref, headSha) => read(new OpinionKey({ ...ref, headSha })),
        opine: (ref, headSha) =>
          Effect.gen(function* () {
            const key = new OpinionKey({ ...ref, headSha })
            const hit = yield* read(key)
            if (hit && !sameHeads(hit.stackHeads, headsOf((yield* stackOf(ref)).above))) yield* Effect.orDie(cache.invalidate(key))
            return yield* storeFailuresDie(cache.get(key))
          }),
        steps: (ref, headSha) => steps.follow(keyOf({ ...ref, headSha })),
      })
    }),
  )
}
