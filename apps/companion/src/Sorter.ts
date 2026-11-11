import { AgentSort, type AgentError, type FileStat, type GitError, type GitHubError, type PrRef, type RepoNotConfigured, type SortResult } from '@pr-review/domain'
import { Context, Deferred, Effect, Exit, Fiber, Layer, type Stream } from 'effect'
import { PersistedCache } from 'effect/persistence'
import { readFileSync } from 'node:fs'
import { Agent } from './Agent.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { GitHub } from './GitHub.ts'
import { normalize } from './normalize.ts'
import { makeSteps } from './steps.ts'
import { cacheOptions, peek, poke, SortKey, storeFailuresDie } from './Store.ts'
import { buildTrusted } from './trusted.ts'

const instructions = readFileSync(new URL('../prompts/sort.md', import.meta.url), 'utf8')

export type SortError = AgentError | GitError | GitHubError | RepoNotConfigured

/** A sort ready to run: the prompt, and what makes the agent's answer a `SortResult`. */
export type SortPrompt = { prompt: string; cwd: string; files: ReadonlyArray<FileStat>; finish(answer: AgentSort): SortResult }

/** See `Sorter.claim`. */
export type SortClaim = { running: Effect.Effect<SortResult, SortError> } | { done(exit: Exit.Exit<SortResult, SortError>): Effect.Effect<void> }

export class Sorter extends Context.Service<
  Sorter,
  {
    sort(ref: PrRef, headSha: string): Effect.Effect<SortResult, SortError>
    /** The sort if one is cached, without running it. */
    cached(ref: PrRef, headSha: string): Effect.Effect<SortResult | undefined>
    /** What a running sort is doing: the current step, then each new one. Never ends; interrupt it when the sort is done. */
    steps(ref: PrRef, headSha: string): Stream.Stream<string>
    /** Everything a sort needs short of the agent turn, for runs that make the turn themselves. */
    prepare(ref: PrRef, headSha: string, report?: (step: string) => Effect.Effect<void>): Effect.Effect<SortPrompt, SortError>
    /**
     * One sort per head at a time: either the sort already running for this head, or the caller's claim to make it.
     * While claimed, `sort` waits for the claimant; `remember` or `done` settles it.
     */
    claim(ref: PrRef, headSha: string): Effect.Effect<SortClaim>
    /** Saves a sort made elsewhere, so `sort` and `cached` answer with it. */
    remember(ref: PrRef, headSha: string, result: SortResult): Effect.Effect<void>
  }
>()('pr-review/Sorter') {
  static readonly layer = Layer.effect(
    Sorter,
    Effect.gen(function* () {
      const git = yield* Git
      const github = yield* GitHub
      const agent = yield* Agent
      const config = yield* Config
      const steps = yield* makeSteps
      const keyOf = (k: { host: string; owner: string; repo: string; number: number; headSha: string }) => `${k.host}/${k.owner}/${k.repo}#${k.number}@${k.headSha}`

      const prepare = Effect.fn('Sorter.prepare')(function* ({ host, owner, repo, number }: PrRef, headSha: string, report: (step: string) => Effect.Effect<void> = () => Effect.void) {
        const repoKey = `${host}/${owner}/${repo}`
        yield* report('Fetching the PR')
        const { review } = yield* config.settings
        const gh = yield* github.forHost(host)
        const pr = yield* gh.getPr(owner, repo, number)
        const { headSha: head, mergeBase } = yield* git.fetchPr(repoKey, number, pr.baseRef, headSha)
        const [files, checks] = yield* Effect.all([git.numstat(repoKey, mergeBase, head), gh.getChecks(owner, repo, head)], { concurrency: 2 })
        const { groups, rest } = buildTrusted(files, checks, review.likelyTrusted, review.neverTrust)
        yield* report(`Reading the diff (${files.length} files)`)
        // A moved file needs its old path too, or the diff shows it as new.
        const paths = rest.flatMap((f) => (f.previous ? [f.previous, f.path] : [f.path]))
        const master = `origin/${yield* git.defaultBranch(repoKey)}`
        const [diff, guidance] = yield* Effect.all(
          [paths.length ? git.diff(repoKey, mergeBase, head, paths) : Effect.succeed(''), review.guidance.length ? git.lsTree(repoKey, master, review.guidance) : Effect.succeed([])],
          { concurrency: 2 },
        )
        const prompt = [
          instructions,
          `# Refs\nPR head: ${head}\nMerge base: ${mergeBase}\nDefault branch: ${master}`,
          `# Review guidance (the repo's own rules; read the ones that apply with git show ${master}:<path>)\n${guidance.join('\n') || '(none)'}`,
          `# PR #${number}: ${pr.title} (by ${pr.author})\n\n${pr.body || '(no description)'}`,
          `# Changed files\n${rest.map((f) => `${f.path}\t+${f.additions}\t-${f.deletions}`).join('\n')}`,
          `# Likely trusted (not in the diff below; read with git diff if unsure)\n${groups.map((g) => `## ${g.group}: ${g.why}\n${g.files.join('\n')}`).join('\n\n') || '(none)'}`,
          diff.length > review.maxDiffKb * 1000
            ? `# Diff\nDiff too large; read files with git show ${head}:<path> and compare with git diff ${mergeBase} ${head} -- <path>`
            : `# Diff\n${diff}`,
        ].join('\n\n')
        return { prompt, cwd: git.dir(repoKey), files, finish: (answer) => normalize(answer, files, groups, head, review.neverTrust, mergeBase) } satisfies SortPrompt
      })

      const run = Effect.fn('Sorter.run')(function* (key: SortKey) {
        const { owner, repo, number, headSha } = key
        const report = steps.report(keyOf(key))
        const p = yield* prepare(key, headSha, report)
        const sorted = yield* agent.structured({ prompt: p.prompt, schema: AgentSort, cwd: p.cwd, log: { kind: 'sort', owner, repo, number, headSha }, onStep: report })
        yield* report('Checking the answer')
        return p.finish(sorted)
      })

      const cache = yield* PersistedCache.make(run, { storeId: 'sort', ...cacheOptions })
      const read = yield* peek('sort')
      const write = yield* poke('sort')
      const scope = yield* Effect.scope
      const inflight = new Map<string, Deferred.Deferred<SortResult, SortError>>()
      const settle = (key: string, exit: Exit.Exit<SortResult, SortError>) =>
        Effect.suspend(() => {
          const d = inflight.get(key)
          inflight.delete(key)
          return d ? Effect.asVoid(Deferred.done(d, exit)) : Effect.void
        })
      const claim = (ref: PrRef, headSha: string) =>
        Effect.sync((): SortClaim => {
          const key = keyOf({ ...ref, headSha })
          const running = inflight.get(key)
          if (running) return { running: Deferred.await(running) }
          const d = Deferred.makeUnsafe<SortResult, SortError>()
          inflight.set(key, d)
          return { done: (exit) => (inflight.get(key) === d ? settle(key, exit) : Effect.void) }
        })
      return Sorter.of({
        prepare,
        claim,
        remember: (ref, headSha, result) => {
          const key = new SortKey({ ...ref, headSha })
          return Effect.andThen(Effect.orDie(cache.invalidate(key)), write(key, result)).pipe(Effect.andThen(settle(keyOf(key), Exit.succeed(result))))
        },
        sort: (ref, headSha) =>
          Effect.flatMap(claim(ref, headSha), (c) =>
            'running' in c
              ? c.running
              : // In the layer's scope, so a closed page never interrupts a sort someone else is waiting on.
                Effect.flatMap(Effect.forkIn(storeFailuresDie(cache.get(new SortKey({ ...ref, headSha }))).pipe(Effect.onExit(c.done)), scope), Fiber.join),
          ),
        cached: (ref, headSha) => read(new SortKey({ ...ref, headSha })),
        steps: (ref, headSha) => steps.follow(keyOf({ ...ref, headSha })),
      })
    }),
  )
}
