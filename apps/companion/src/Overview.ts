import { type AgentError, type GitError, type GitHubError, type PrRef, type RepoNotConfigured, StackOverview } from '@pr-review/domain'
import { Context, Effect, Layer } from 'effect'
import { PersistedCache } from 'effect/persistence'
import { readFileSync } from 'node:fs'
import { Agent } from './Agent.ts'
import { Git } from './Git.ts'
import { cacheOptions, type OverviewEntry, OverviewKey, storeFailuresDie } from './Store.ts'

const instructions = readFileSync(new URL('../prompts/overview.md', import.meta.url), 'utf8')

export class Overview extends Context.Service<
  Overview,
  { make(ref: PrRef, entries: ReadonlyArray<OverviewEntry>): Effect.Effect<StackOverview, AgentError | GitError | GitHubError | RepoNotConfigured> }
>()('pr-review/Overview') {
  static readonly layer = Layer.effect(
    Overview,
    Effect.gen(function* () {
      const git = yield* Git
      const agent = yield* Agent

      const run = Effect.fn('Overview.run')(function* ({ host, owner, repo, entries }: OverviewKey) {
        const decisions = entries.flatMap((e) =>
          e.sort.decisions.map((d) => `- #${e.number} [${d.lens}/${d.reason}] ${d.title}: ${d.note} (${d.files.map((f) => f.path).join(', ')})`),
        )
        const paths = [...new Set(entries.flatMap((e) => e.files.map((f) => f.path)))].sort()
        const prompt = [instructions, `# Decisions, bottom of the stack first\n${decisions.join('\n') || '(none)'}`, `# Files changed across the stack\n${paths.join('\n')}`].join('\n\n')
        return yield* agent.structured({
          prompt,
          schema: StackOverview,
          cwd: git.dir(`${host}/${owner}/${repo}`),
          log: { kind: 'overview', owner, repo, number: entries[0]?.number ?? 0, headSha: entries.at(-1)?.headSha ?? '' },
        })
      })

      const cache = yield* PersistedCache.make(run, { storeId: 'overview', ...cacheOptions })
      return Overview.of({ make: (ref, entries) => storeFailuresDie(cache.get(new OverviewKey({ host: ref.host, owner: ref.owner, repo: ref.repo, entries }))) })
    }),
  )
}
