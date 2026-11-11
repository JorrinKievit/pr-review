import { AgentSort, type AgentError, type GitError, type GitHubError, type PrRef, type RepoNotConfigured, type SortResult } from '@pr-review/domain'
import { Context, Effect, Layer, PubSub, Stream } from 'effect'
import { PersistedCache } from 'effect/persistence'
import { readFileSync } from 'node:fs'
import { Agent } from './Agent.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { GitHub } from './GitHub.ts'
import { normalize } from './normalize.ts'
import { cacheOptions, SortKey, storeFailuresDie } from './Store.ts'
import { buildTrusted } from './trusted.ts'

const instructions = readFileSync(new URL('../prompts/sort.md', import.meta.url), 'utf8')

export type SortError = AgentError | GitError | GitHubError | RepoNotConfigured

export class Sorter extends Context.Service<
  Sorter,
  {
    sort(ref: PrRef, headSha: string): Effect.Effect<SortResult, SortError>
    /** What a running sort is doing: the current step, then each new one. Never ends; interrupt it when the sort is done. */
    steps(ref: PrRef, headSha: string): Stream.Stream<string>
  }
>()('pr-review/Sorter') {
  static readonly layer = Layer.effect(
    Sorter,
    Effect.gen(function* () {
      const git = yield* Git
      const github = yield* GitHub
      const agent = yield* Agent
      const config = yield* Config
      const published = yield* PubSub.unbounded<{ key: string; step: string }>()
      const latest = new Map<string, string>()
      const keyOf = (k: { host: string; owner: string; repo: string; number: number; headSha: string }) => `${k.host}/${k.owner}/${k.repo}#${k.number}@${k.headSha}`

      const run = Effect.fn('Sorter.run')(function* ({ host, owner, repo, number, headSha }: SortKey) {
        const repoKey = `${host}/${owner}/${repo}`
        const key = keyOf({ host, owner, repo, number, headSha })
        const report = (step: string) => Effect.andThen(Effect.sync(() => void latest.set(key, step)), PubSub.publish(published, { key, step }))
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
        const sorted = yield* agent.structured({
          prompt,
          schema: AgentSort,
          cwd: git.dir(repoKey),
          log: { kind: 'sort', owner, repo, number, headSha: head },
          onStep: report,
        })
        yield* report('Checking the answer')
        return normalize(sorted, files, groups, head, review.neverTrust, mergeBase)
      })

      const cache = yield* PersistedCache.make(run, { storeId: 'sort', ...cacheOptions })
      return Sorter.of({
        sort: (ref, headSha) => storeFailuresDie(cache.get(new SortKey({ ...ref, headSha }))),
        steps: (ref, headSha) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const key = keyOf({ ...ref, headSha })
              // Subscribe before reading the current step, so no step falls between the two.
              const sub = yield* PubSub.subscribe(published)
              const current = latest.get(key)
              return Stream.concat(
                Stream.fromIterable(current ? [current] : []),
                Stream.fromSubscription(sub).pipe(Stream.filter((e) => e.key === key), Stream.map((e) => e.step)),
              )
            }),
          ),
      })
    }),
  )
}
