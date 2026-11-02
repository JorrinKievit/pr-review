import { type DecisionState, type DecisionStates, type Draft, type PrRef, type Rereview, ReviewRpcs, type SortResult, type SortEvent, type StackEntry, type StackEntryStatus, type StackEvent, targetKey } from '@pr-review/domain'
import { Cause, Clock, Effect, Exit, Fiber, Layer, Option, Queue, Stream } from 'effect'
import { RpcMiddleware } from 'effect/rpc'
import { PersistedCache } from 'effect/persistence'
import { Asker } from './Asker.ts'
import { Agent } from './Agent.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { GitHub } from './GitHub.ts'
import { Overview } from './Overview.ts'
import { Sorter } from './Sorter.ts'
import { buildStack } from './stack.ts'
import { cacheOptions, type Chats, type OverviewEntry, PatchKey, Store, storeFailuresDie } from './Store.ts'

/** Set by the release bundle; 0.0.0 is a companion run from source. */
export const VERSION = process.env.PR_REVIEW_VERSION ?? '0.0.0'

const repoKeyOf = (ref: PrRef) => `${ref.host}/${ref.owner}/${ref.repo}`
const prKey = (ref: PrRef) => `${repoKeyOf(ref)}#${ref.number}`
const headKey = (ref: PrRef, headSha: string) => `${prKey(ref)}@${headSha}`

/** A sort answered from cache this fast skips the Running event, so a cached page shows no spinner flash. */
const CACHE_HIT_WINDOW = '50 millis'

/** Everything a reviewer can give a verdict on, under the ids the page saves them with (see itemId in the extension). */
const reviewables = (r: SortResult) => [
  ...r.decisions.map((d) => ({ id: d.id, paths: d.files.map((f) => f.path) })),
  ...r.skim.map((s) => ({ id: `skim:${s.area}`, paths: s.files })),
  ...r.trusted.map((t) => ({ id: `trusted:${t.group}`, paths: t.files })),
]

/** How long a call may run before the log says so. */
const SLOW = '15 seconds'

/** Writes calls that fail, or still run after SLOW, to the host log, named like `GetPr #3019`. */
export class Logged extends RpcMiddleware.Service<Logged>()('pr-review/Logged') {}

export const LoggedLive = Layer.succeed(Logged, (effect, { rpc, payload }) =>
  Effect.gen(function* () {
    const n = (payload as { ref?: { number?: number } } | undefined)?.ref?.number
    const what = n === undefined ? rpc._tag : `${rpc._tag} #${n}`
    const start = Date.now()
    const warn = yield* Effect.forkChild(Effect.delay(Effect.logWarning(`${what} still running after ${SLOW}`), SLOW))
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.andThen(
          Fiber.interrupt(warn),
          Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? Effect.logWarning(`${what} failed after ${Date.now() - start}ms: ${Cause.pretty(exit.cause)}`) : Effect.void,
        ),
      ),
    )
  }),
)

/** The procedures as the companion serves them: every call goes through Logged. */
export const CompanionRpcs = ReviewRpcs.middleware(Logged)

export const HandlersLive = ReviewRpcs.toLayer(
  Effect.gen(function* () {
    const config = yield* Config
    const git = yield* Git
    const github = yield* GitHub
    const store = yield* Store
    const sorter = yield* Sorter
    const asker = yield* Asker
    const overview = yield* Overview
    const agent = yield* Agent
    // Sorts run in the companion's scope, so a closed or reloaded tab doesn't throw away a paid run.
    const scope = yield* Effect.scope

    const patches = yield* PersistedCache.make(
      ({ repoKey, mergeBase, headSha, path, previous }: PatchKey) => git.diff(repoKey, mergeBase, headSha, previous ? [previous, path] : [path]),
      { storeId: 'patch', ...cacheOptions },
    )

    const statesFor = (ref: PrRef, headSha: string) =>
      store.state.get(headKey(ref, headSha)).pipe(Effect.map(Option.getOrElse((): DecisionStates => ({}))), Effect.orDie)

    const draftsFor = (ref: PrRef) => store.drafts.get(prKey(ref)).pipe(Effect.map(Option.getOrElse((): ReadonlyArray<Draft> => [])), Effect.orDie)
    const chatsFor = (key: string) => store.chats.get(key).pipe(Effect.map(Option.getOrElse((): typeof Chats.Type => ({}))), Effect.orDie)

    const keepLast = (ref: PrRef, headSha: string, result: SortResult, states: DecisionStates) =>
      store.lastVerdicts
        .set(prKey(ref), { headSha, decisions: reviewables(result).flatMap((r) => (states[r.id] ? [{ ...r, state: states[r.id]! }] : [])) })
        .pipe(Effect.orDie)

    const samePaths = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((p) => b.includes(p))

    /**
     * The verdicts for a head. A head opened for the first time takes the verdicts of the head last worked on, for each
     * decision with the same id or the same files where none of those files changed in between. Those whose files did
     * change come back as `rereview`. Trusted piles start out accepted.
     */
    const verdictsFor = Effect.fnUntraced(function* (ref: PrRef, headSha: string, result: SortResult) {
      const key = headKey(ref, headSha)
      const stored = yield* Effect.orDie(store.state.get(key))
      const marks = Option.getOrElse(yield* Effect.orDie(store.rereview.get(key)), (): Rereview => ({}))
      if (Option.isSome(stored)) return { state: stored.value, rereview: marks }
      const last = Option.getOrUndefined(yield* Effect.orDie(store.lastVerdicts.get(prKey(ref))))
      const carried: Record<string, DecisionState> = {}
      const rereview: Record<string, Rereview[string]> = {}
      if (last && last.headSha !== headSha)
        for (const { id, paths } of reviewables(result)) {
          const before = last.decisions.find((e) => e.id === id || samePaths(e.paths, paths))
          if (!before) continue
          const unchanged = yield* git.diff(repoKeyOf(ref), last.headSha, headSha, [...new Set([...paths, ...before.paths])]).pipe(
            Effect.map((diff) => diff === ''),
            // The old head may be gone from the clone; then nothing is carried.
            Effect.orElseSucceed(() => false),
          )
          if (unchanged) carried[id] = before.state
          else rereview[id] = { since: last.headSha, was: before.state }
        }
      const fromLast = Object.keys(carried).length > 0
      for (const g of result.trusted) {
        const id = `trusted:${g.group}`
        delete rereview[id]
        carried[id] ??= 'accepted'
      }
      if (Object.keys(rereview).length) yield* Effect.orDie(store.rereview.set(key, rereview))
      // Saved even when empty: the head has been seen, so a verdict cleared later stays cleared.
      yield* Effect.orDie(store.state.set(key, carried))
      if (fromLast) yield* keepLast(ref, headSha, result, carried)
      return { state: carried, rereview }
    })

    /** Open PRs as last seen per repo, for loads that can take them slightly stale. */
    const lastOpen = new Map<string, ReadonlyArray<StackEntry>>()
    const openStack = Effect.fnUntraced(function* (ref: PrRef, stale = false) {
      const key = repoKeyOf(ref)
      yield* config.repo(key)
      const defaultBranch = yield* git.defaultBranch(key)
      const gh = yield* github.forHost(ref.host)
      const fresh = gh.listOpenPrs(ref.owner, ref.repo).pipe(Effect.tap((prs) => Effect.sync(() => lastOpen.set(key, prs))))
      const seen = stale ? lastOpen.get(key) : undefined
      const prs = seen ? yield* Effect.as(Effect.forkDetach(Effect.ignore(fresh)), seen) : yield* fresh
      return { gh, defaultBranch, stack: buildStack([...prs], ref.number, defaultBranch) }
    })

    return {
      Health: () => Effect.succeed({ version: VERSION }),

      Configure: ({ settings }) => config.configure(settings),

      GetSettings: () => config.saved,

      PoolStatus: () => agent.status,

      GetPr: Effect.fnUntraced(function* ({ ref }) {
        const repoKey = repoKeyOf(ref)
        const gh = yield* github.forHost(ref.host)
        // The stack bar only needs the open PRs roughly; the PR itself is read fresh.
        const [{ defaultBranch, stack }, rest] = yield* Effect.all(
          [
            openStack(ref, true),
            Effect.gen(function* () {
              const meta = yield* gh.getPr(ref.owner, ref.repo, ref.number)
              const shas = yield* git.fetchPr(repoKey, ref.number, meta.baseRef, meta.headSha)
              const [files, threads, checks, viewer] = yield* Effect.all(
                [git.numstat(repoKey, shas.mergeBase, shas.headSha), gh.listThreads(ref.owner, ref.repo, ref.number), gh.getChecks(ref.owner, ref.repo, shas.headSha), gh.viewer()],
                { concurrency: 4 },
              )
              return { ...meta, ...shas, files, threads, checks, viewer }
            }),
          ],
          { concurrency: 2 },
        )
        return { ...rest, host: ref.host, owner: ref.owner, repo: ref.repo, defaultBranch, stack }
      }),

      GetFilePatch: ({ ref, mergeBase, headSha, path, previous }) =>
        Effect.andThen(config.repo(repoKeyOf(ref)), storeFailuresDie(patches.get(new PatchKey({ repoKey: repoKeyOf(ref), mergeBase, headSha, path, previous })))),

      Sort: ({ ref, headSha }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const sort = yield* Effect.forkIn(sorter.sort(ref, headSha), scope)
            const cached = yield* Effect.raceFirst(Effect.as(Fiber.await(sort), true), Effect.as(Effect.sleep(CACHE_HIT_WINDOW), false))
            const done = Effect.gen(function* () {
              const result = yield* Fiber.join(sort)
              return { _tag: 'Done', result, ...(yield* verdictsFor(ref, headSha, result)) } satisfies SortEvent
            })
            if (cached) return Stream.fromEffect(done)
            const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
            const steps = sorter.steps(ref, headSha).pipe(
              Stream.map((step): SortEvent => ({ _tag: 'Running', startedAt, step })),
              Stream.interruptWhen(Fiber.await(sort)),
            )
            return Stream.succeed<SortEvent>({ _tag: 'Running', startedAt }).pipe(Stream.concat(steps), Stream.concat(Stream.fromEffect(done)))
          }),
        ),

      SetState: ({ ref, headSha, decisionId, state }) =>
        Effect.gen(function* () {
          const key = headKey(ref, headSha)
          const { [decisionId]: _, ...rest } = yield* statesFor(ref, headSha)
          const next = state ? { ...rest, [decisionId]: state } : rest
          yield* Effect.orDie(store.state.set(key, next))
          // The sort is cached by now; without it there is nothing to carry over later.
          yield* sorter.sort(ref, headSha).pipe(Effect.flatMap((result) => keepLast(ref, headSha, result, next)), Effect.ignore)
        }),

      Ask: ({ ref, headSha, target, question, followUp }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const key = headKey(ref, headSha)
            const tk = targetKey(target)
            const prior = followUp ? (yield* chatsFor(key))[tk] : undefined
            let answer = ''
            return asker.ask(ref, headSha, target, question, prior?.sessionId).pipe(
              Stream.tap((e) => {
                if (e._tag === 'Text') return Effect.sync(() => void (answer += e.delta))
                // Re-read at the end: another target's answer may have landed while this one streamed.
                return Effect.flatMap(chatsFor(key), (all) =>
                  store.chats.set(key, { ...all, [tk]: { target, sessionId: e.sessionId, turns: [...(prior?.turns ?? []), { question, answer }] } }),
                ).pipe(Effect.orDie)
              }),
            )
          }),
        ),

      GetDescription: ({ ref }) =>
        Effect.andThen(config.repo(repoKeyOf(ref)), Effect.flatMap(github.forHost(ref.host), (gh) => gh.description(ref.owner, ref.repo, ref.number))),

      GetChats: ({ ref, headSha }) => Effect.map(chatsFor(headKey(ref, headSha)), (all) => Object.values(all).map(({ target, turns }) => ({ target, turns }))),

      Stack: ({ ref }) =>
        Stream.callback<StackEvent, Effect.Error<ReturnType<typeof openStack>>>((queue) =>
          Effect.gen(function* () {
            const { stack } = yield* openStack(ref)
            const entries: StackEntryStatus[] = stack.map((pr) => ({ pr, status: 'queued', result: null, error: null, state: {} }))
            let overviewResult: StackEvent['overview'] = null
            let overviewError: string | undefined
            const emit = () => Queue.offer(queue, { entries: [...entries], overview: overviewResult, ...(overviewError ? { overviewError } : {}) })
            yield* emit()

            const sorted: OverviewEntry[] = []
            // Bottom first: the Agent's two permits are taken in stack order.
            yield* Effect.forEach(
              entries,
              (entry, i) =>
                Effect.gen(function* () {
                  entries[i] = { ...entry, status: 'running' }
                  yield* emit()
                  const entryRef = { ...ref, number: entry.pr.number }
                  const steps = yield* Effect.forkChild(
                    Stream.runForEach(sorter.steps(entryRef, entry.pr.headSha), (step) =>
                      Effect.suspend(() => (entries[i]!.status === 'running' ? ((entries[i] = { ...entries[i]!, step }), emit()) : Effect.void)),
                    ),
                  )
                  const outcome = yield* Effect.gen(function* () {
                    const result = yield* sorter.sort(entryRef, entry.pr.headSha)
                    const shas = yield* git.fetchPr(repoKeyOf(ref), entry.pr.number, entry.pr.baseRef, entry.pr.headSha)
                    return { result, files: yield* git.numstat(repoKeyOf(ref), shas.mergeBase, shas.headSha) }
                  }).pipe(Effect.result, Effect.ensuring(Fiber.interrupt(steps)))
                  if (outcome._tag === 'Success') {
                    entries[i] = { ...entry, status: 'done', result: outcome.success.result, ...(yield* verdictsFor(entryRef, entry.pr.headSha, outcome.success.result)) }
                    sorted[i] = { number: entry.pr.number, headSha: entry.pr.headSha, sort: outcome.success.result, files: outcome.success.files }
                  } else {
                    entries[i] = { ...entry, status: 'failed', error: outcome.failure.message }
                  }
                  yield* emit()
                }),
              { concurrency: 2 },
            )

            const done = sorted.filter(Boolean)
            if (done.length) {
              const made = yield* overview.make(ref, done).pipe(Effect.result)
              if (made._tag === 'Success') overviewResult = made.success
              else {
                overviewError = made.failure.message
                yield* Effect.logWarning(`Overview #${ref.number} failed: ${overviewError}`)
              }
              yield* emit()
            }
            yield* Queue.end(queue)
          }),
        ),

      Recall: ({ key }) => store.remembered.get(key).pipe(Effect.map(Option.getOrNull), Effect.orDie),

      Remember: ({ key, value }) => Effect.orDie(store.remembered.set(key, value)),

      GetDrafts: ({ ref }) => draftsFor(ref),

      SetDrafts: ({ ref, drafts }) => Effect.orDie(store.drafts.set(prKey(ref), drafts)),

      SubmitReview: ({ ref, event, body, commitId }) =>
        Effect.gen(function* () {
          const gh = yield* github.forHost(ref.host)
          yield* gh.submitReview(ref.owner, ref.repo, ref.number, { event, body, commitId, comments: yield* draftsFor(ref) })
          yield* Effect.orDie(store.drafts.set(prKey(ref), []))
        }),
    }
  }),
)
