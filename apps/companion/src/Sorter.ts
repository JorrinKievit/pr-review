import { AgentSort, AgentError, Decision, type FileStat, type GitError, type GitHubError, type PrRef, type RepoNotConfigured, ReviewStopped, type SortResult } from '@pr-review/domain'
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, type Stream } from 'effect'
import { readFileSync } from 'node:fs'
import { parse } from 'partial-json'
import { Agent } from './Agent.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { GitHub } from './GitHub.ts'
import { changedBetween, shiftRanges } from './carry.ts'
import { parseDiff } from './interdiff.ts'
import { normalize } from './normalize.ts'
import { guidanceSection } from './opinionContext.ts'
import { annotate, measure } from './Perf.ts'
import { makeSteps } from './steps.ts'
import { cacheOptions, measuredCache, peek, poke, SortKey, storeFailuresDie } from './Store.ts'
import { buildTrusted } from './trusted.ts'

const instructions = readFileSync(new URL('../prompts/sort.md', import.meta.url), 'utf8')

export type SortError = AgentError | GitError | GitHubError | RepoNotConfigured

const parsePartial = Option.liftThrowable(parse)
const decodeDecisions = Schema.decodeUnknownOption(Schema.Struct({ decisions: Schema.Array(Decision) }))

/** The decisions in a sort answer that are written out so far: the last one only once the answer has moved past them, as it may still be half written. */
export const writtenDecisions = (text: string): ReadonlyArray<Decision> => {
  const start = text.indexOf('{')
  if (start < 0) return []
  return parsePartial(text.slice(start)).pipe(
    Option.filter((sort) => typeof sort === 'object' && sort !== null && Array.isArray(sort.decisions)),
    Option.flatMap((sort) => {
      const past = ['skim', 'trusted', 'claims'].some((k) => k in sort)
      return decodeDecisions({ decisions: past ? sort.decisions : sort.decisions.slice(0, -1) })
    }),
    Option.match({ onNone: () => [], onSome: (s) => s.decisions }),
  )
}

/** A sort ready to run: the prompt, and what makes the agent's answer a `SortResult`. */
export type SortPrompt = { prompt: string; cwd: string; repo: string; files: ReadonlyArray<FileStat>; finish(answer: AgentSort): SortResult }

/** A push smaller than this, in interdiff lines, is sorted from the previous sort; a larger one from scratch. */
export const RESORT_LINES = 400

/**
 * The sort of an earlier head of the PR, the files whose change differs since, and its decisions on none of those files
 * (`kept`), their lines moved to the new head: see `Sorter.since`.
 */
export type PreviousSort = { headSha: string; sort: SortResult; changed: ReadonlyArray<string>; interdiff: string; kept: ReadonlyArray<Decision> }

const sortPaths = (s: SortResult) => [...s.decisions.flatMap((d) => d.files.map((f) => f.path)), ...s.skim.flatMap((a) => a.files), ...s.trusted.flatMap((g) => g.files)]

/** See `Sorter.claim`. */
export type SortClaim = { running: Effect.Effect<SortResult, SortError> } | { done(exit: Exit.Exit<SortResult, SortError>): Effect.Effect<void> }

export class Sorter extends Context.Service<
  Sorter,
  {
    sort(ref: PrRef, headSha: string): Effect.Effect<SortResult, SortError>
    /** Interrupts the sorts `sort` runs for this PR (any head); whoever waits on one fails with the stopped message. */
    cancel(ref: PrRef): Effect.Effect<void>
    /** The sort if one is cached, without running it. */
    cached(ref: PrRef, headSha: string): Effect.Effect<SortResult | undefined>
    /** What a running sort is doing: the current step, then each new one. Never ends; interrupt it when the sort is done. */
    steps(ref: PrRef, headSha: string): Stream.Stream<string>
    /** Everything a sort needs short of the agent turn, for runs that make the turn themselves. */
    prepare(ref: PrRef, headSha: string, report?: (step: string) => Effect.Effect<void>, previous?: PreviousSort): Effect.Effect<SortPrompt, SortError>
    /**
     * The cached sort of `before`, an earlier head of the PR, with the files whose change differs at `headSha`; undefined
     * when there is none, or when the interdiff reaches `RESORT_LINES`. Never fails.
     */
    since(ref: PrRef, headSha: string, before: { headSha: string; mergeBase?: string | undefined }): Effect.Effect<PreviousSort | undefined>
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

      const prepare = Effect.fn('Sorter.prepare')(function* (
        { host, owner, repo, number }: PrRef,
        headSha: string,
        report: (step: string) => Effect.Effect<void> = () => Effect.void,
        previous?: PreviousSort,
      ) {
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
        const keptIds = new Set(previous?.kept.map((d) => d.id))
        const [diff, guidance] = yield* Effect.all(
          [paths.length && !previous ? git.diff(repoKey, mergeBase, head, paths) : Effect.succeed(''), review.guidance.length ? git.lsTree(repoKey, master, review.guidance) : Effect.succeed([])],
          { concurrency: 2 },
        )
        const prompt = [
          instructions,
          `# Refs\nPR head: ${head}\nMerge base: ${mergeBase}\nDefault branch: ${master}`,
          guidanceSection(master, guidance),
          `# PR #${number}: ${pr.title} (by ${pr.author})\n\n${pr.body || '(no description)'}`,
          `# Changed files\n${rest.map((f) => `${f.path}\t+${f.additions}\t-${f.deletions}`).join('\n')}`,
          `# Likely trusted (not in the diff below; read with git diff if unsure)\n${groups.map((g) => `## ${g.group}: ${g.why}\n${g.files.join('\n')}`).join('\n\n') || '(none)'}`,
          ...(previous
            ? [
                `# Previous sort (head ${previous.headSha})\n${JSON.stringify({ summary: previous.sort.summary ?? '', skim: previous.sort.skim, trusted: previous.sort.trusted, claims: previous.sort.claims })}`,
                `# Kept decisions\nTheir files change as they did at ${previous.headSha}, so they stay as they are and are not yours to return:\n${
                  previous.kept.map((d) => `${d.id}: ${d.title} (${d.files.map((f) => f.path).join(', ')})`).join('\n') || '(none)'
                }`,
                `# Decisions to revise\n${JSON.stringify(previous.sort.decisions.filter((d) => !keptIds.has(d.id)))}`,
                `# Changed since then\nOnly these files change differently than at ${previous.headSha}:\n${previous.changed.join('\n')}\n\n${
                  previous.interdiff.length > review.maxDiffKb * 1000
                    ? `Interdiff too large; read it with git diff ${previous.headSha} ${head} -- <path>`
                    : `Interdiff (git diff ${previous.headSha} ${head}):\n${previous.interdiff}`
                }`,
                `# This sort\nThe PR was sorted at ${previous.headSha} and pushed to since. Return decisions for the changed code only: revise, split, merge or drop the decisions to revise, add decisions where the changed code needs them, and place every file under "Changed since then" that is still in the PR. Give new decisions ids no kept decision has. Return skim, trusted, claims and summary for the whole PR at ${head}; a claim may name kept decisions. The full diff is git diff ${mergeBase} ${head}; read from it where the interdiff is not enough.`,
              ]
            : [
                diff.length > review.maxDiffKb * 1000
                  ? `# Diff\nDiff too large; read files with git show ${head}:<path> and compare with git diff ${mergeBase} ${head} -- <path>`
                  : `# Diff\n${diff}`,
              ]),
        ].join('\n\n')
        yield* annotate({
          files: files.length,
          additions: files.reduce((n, f) => n + f.additions, 0),
          deletions: files.reduce((n, f) => n + f.deletions, 0),
          trustedFiles: files.length - rest.length,
          diffBytes: Buffer.byteLength(diff),
          diffInlined: diff.length <= review.maxDiffKb * 1000,
          guidanceFiles: guidance.length,
          promptBytes: Buffer.byteLength(prompt),
          ...(previous ? { since: true, changedFiles: previous.changed.length } : {}),
        })
        // Kept decisions come first, as the agent never writes them.
        const finish = (answer: AgentSort) =>
          normalize({ ...answer, decisions: [...(previous?.kept ?? []), ...answer.decisions.filter((d) => !keptIds.has(d.id))] }, files, groups, head, review.neverTrust, mergeBase)
        return { prompt, cwd: git.dir(repoKey), repo: repoKey, files, finish } satisfies SortPrompt
      }, measure('context.prepare'))

      const run = Effect.fn('Sorter.run')(function* (key: SortKey) {
        const { owner, repo, number, headSha } = key
        const report = steps.report(keyOf(key))
        const p = yield* prepare(key, headSha, report)
        const sorted = yield* agent.structured({ prompt: p.prompt, schema: AgentSort, cwd: p.cwd, repo: p.repo, log: { kind: 'sort', owner, repo, number, headSha }, onStep: report })
        yield* report('Checking the answer')
        return p.finish(sorted)
      }, (effect, key) => measure('operation', { kind: 'sort', owner: key.owner, repo: key.repo, prNumber: key.number, headSha: key.headSha })(effect))

      const cache = yield* measuredCache(run, { storeId: 'sort', ...cacheOptions })
      const read = yield* peek('sort')
      const write = yield* poke('sort')
      const scope = yield* Effect.scope

      const since = (ref: PrRef, headSha: string, before: { headSha: string; mergeBase?: string | undefined }) =>
        Effect.gen(function* () {
          if (before.headSha === headSha || !before.mergeBase) return undefined
          const sort = yield* read(new SortKey({ ...ref, headSha: before.headSha }))
          if (!sort || sort.quick) return undefined
          const repoKey = `${ref.host}/${ref.owner}/${ref.repo}`
          const pr = yield* (yield* github.forHost(ref.host)).getPr(ref.owner, ref.repo, ref.number)
          const { headSha: head, mergeBase } = yield* git.fetchPr(repoKey, ref.number, pr.baseRef, headSha)
          const files = yield* git.numstat(repoKey, mergeBase, head)
          const paths = [...new Set([...files.flatMap((f) => (f.previous ? [f.previous, f.path] : [f.path])), ...sortPaths(sort)])]
          const { changed: differ, was, now } = yield* changedBetween(git, repoKey, before, { headSha: head, mergeBase }, paths)
          const changed = [...differ]
          const kept = sort.decisions
            .filter((d) => d.files.every((f) => !differ.has(f.path)))
            .map((d) => ({ ...d, files: d.files.map((f) => ({ ...f, ranges: shiftRanges(was.get(f.path), now.get(f.path), f.ranges) })) }))
          const interdiff = changed.length ? yield* git.diff(repoKey, before.headSha, head, changed) : ''
          const lines = parseDiff(interdiff).flatMap((f) => f.hunks.flatMap((h) => h.lines)).filter((l) => l[0] === '+' || l[0] === '-').length
          yield* annotate({ interdiffLines: lines, changedFiles: changed.length })
          return lines >= RESORT_LINES ? undefined : ({ headSha: before.headSha, sort, changed, interdiff, kept } satisfies PreviousSort)
        }).pipe(
          // The old head may be gone from the clone; then the sort starts over.
          Effect.orElseSucceed(() => undefined),
          measure('sort.since'),
        )

      const inflight = new Map<string, Deferred.Deferred<SortResult, SortError>>()
      /** The sorts `sort` forked, by key, so `cancel` can reach them. */
      const forked = new Map<string, Fiber.Fiber<SortResult, SortError>>()
      // A sort only ends by interruption when its PR was stopped: the ones waiting on it get a reason they can show.
      const stoppedError = () => new AgentError({ message: new ReviewStopped().message })
      const settle = (key: string, exit: Exit.Exit<SortResult, SortError>) =>
        Effect.suspend(() => {
          const d = inflight.get(key)
          inflight.delete(key)
          const told = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Exit.fail(stoppedError()) : exit
          return d ? Effect.asVoid(Deferred.done(d, told)) : Effect.void
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
        since,
        claim,
        remember: (ref, headSha, result) => {
          const key = new SortKey({ ...ref, headSha })
          return Effect.andThen(Effect.orDie(cache.invalidate(key)), write(key, result)).pipe(Effect.andThen(settle(keyOf(key), Exit.succeed(result))))
        },
        sort: (ref, headSha) =>
          Effect.flatMap(claim(ref, headSha), (c) =>
            'running' in c
              ? c.running.pipe(measure('sort.join'))
              : // In the layer's scope, so a closed page never interrupts a sort someone else is waiting on.
                Effect.gen(function* () {
                  const key = keyOf({ ...ref, headSha })
                  const fiber = yield* Effect.forkIn(
                    storeFailuresDie(cache.get(new SortKey({ ...ref, headSha }))).pipe(Effect.onExit((exit) => Effect.andThen(Effect.sync(() => void forked.delete(key)), c.done(exit)))),
                    scope,
                  )
                  forked.set(key, fiber)
                  return yield* Effect.catchCause(Fiber.join(fiber), (cause): Effect.Effect<never, SortError> => (Cause.hasInterruptsOnly(cause) ? Effect.fail(stoppedError()) : Effect.failCause(cause)))
                }),
          ),
        cancel: (ref) =>
          Effect.suspend(() => {
            const prefix = `${keyOf({ ...ref, headSha: '' })}`
            return Fiber.interruptAll([...forked].filter(([key]) => key.startsWith(prefix)).map(([, f]) => f))
          }),
        cached: (ref, headSha) => read(new SortKey({ ...ref, headSha })),
        steps: (ref, headSha) => steps.follow(keyOf({ ...ref, headSha })),
      })
    }),
  )
}
