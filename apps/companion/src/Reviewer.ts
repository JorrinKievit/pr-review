import { type AgentAccount, type AgentError, AgentOpinion, AgentSort, type Decision, impact, opinionsMode, type Phase, type PrOpinion, type PrRef, repoSettings, type SortResult } from '@pr-review/domain'
import { Clock, Context, Deferred, Effect, Fiber, Layer, Stream, SubscriptionRef } from 'effect'
import { Agent, type AgentTurns, type SessionOptions } from './Agent.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { GitHub } from './GitHub.ts'
import { type OpinionContext, Opiner } from './Opiner.ts'
import { type SortError, Sorter } from './Sorter.ts'
import { Store } from './Store.ts'

export type Review = { sort: SortResult; opinion: PrOpinion | null; opinionError?: string }

type Worker = Phase['workers'][number]
type Phases = SubscriptionRef.SubscriptionRef<ReadonlyArray<Phase>>

/** Phase updates that only set values, so a session `use` that reruns on another account repeats them harmlessly. */
const tracker = (phases: Phases) => {
  const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())
  const update = (id: Phase['id'], f: (p: Phase) => Phase) => SubscriptionRef.update(phases, (ps) => ps.map((p) => (p.id === id ? f(p) : p)))
  return {
    begin: (id: Phase['id'], label: string) =>
      Effect.flatMap(now, (startedAt) =>
        SubscriptionRef.update(phases, (ps) =>
          ps.some((p) => p.id === id) ? ps.map((p) => (p.id === id ? { ...p, label, state: 'running' as const } : p)) : [...ps, { id, label, state: 'running' as const, startedAt, workers: [] }],
        ),
      ),
    end: (id: Phase['id'], state: 'done' | 'failed') => Effect.flatMap(now, (endedAt) => update(id, (p) => ({ ...p, state, endedAt }))),
    failRunning: Effect.flatMap(now, (endedAt) => SubscriptionRef.update(phases, (ps) => ps.map((p) => (p.state === 'running' ? { ...p, state: 'failed' as const, endedAt } : p)))),
    worker: (id: Phase['id'], i: number, f: (w: Worker) => Worker) =>
      update(id, (p) => {
        const workers = [...p.workers]
        workers[i] = f(workers[i] ?? { account: '', recent: [] })
        return { ...p, workers }
      }),
  }
}
type Tracker = ReturnType<typeof tracker>

/** Where a session's steps and `Judging:` lines go, and the decisions it judges in order. */
type Slot = { phase: Phase['id']; worker: number; judging: ReadonlyArray<Decision> }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// Tolerates markdown around the line, like **Judging:** `d1`.
const JUDGING = /^\W*Judging:[\s*_`]*([\w.:-]+)/

export class Reviewer extends Context.Service<
  Reviewer,
  {
    /** Starts preparing the review of this head, or joins the run already going. Runs in the companion's scope. */
    prepare(ref: PrRef, headSha: string): Effect.Effect<void>
    /** The running preparation's phases: the current ones, then each change. Never ends; empty when nothing runs. */
    progress(ref: PrRef, headSha: string): Stream.Stream<ReadonlyArray<Phase>>
    /** The prepared review, starting a preparation when none runs. A failed opinion still returns the sort. */
    result(ref: PrRef, headSha: string): Effect.Effect<Review, SortError>
  }
>()('pr-review/Reviewer') {
  static readonly layer = Layer.effect(
    Reviewer,
    Effect.gen(function* () {
      const agent = yield* Agent
      const config = yield* Config
      const git = yield* Git
      const github = yield* GitHub
      const sorter = yield* Sorter
      const opiner = yield* Opiner
      const store = yield* Store
      const scope = yield* Effect.scope
      const keyOf = (ref: PrRef, headSha: string) => `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}@${headSha}`
      const runs = new Map<string, { phases: Phases; done: Deferred.Deferred<Review, SortError> }>()

      /** Task 4: small PRs get one quick read. Undefined means sort as usual. */
      const quick = (_ref: PrRef, _headSha: string, _t: Tracker): Effect.Effect<Review | undefined, SortError> => Effect.undefined

      const work = Effect.fnUntraced(function* (ref: PrRef, headSha: string, t: Tracker) {
        const repoKey = `${ref.host}/${ref.owner}/${ref.repo}`
        const settings = yield* config.settings
        const automatic = opinionsMode(settings) === 'automatic'
        const [cachedSort, cachedOpinion] = yield* Effect.all([sorter.cached(ref, headSha), opiner.cached(ref, headSha)])
        if (cachedSort && (cachedOpinion || !automatic)) return { sort: cachedSort, opinion: cachedOpinion ?? null } satisfies Review

        yield* t.begin('fetch', `Fetching #${ref.number}`)
        const gh = yield* github.forHost(ref.host)
        const pr = yield* gh.getPr(ref.owner, ref.repo, ref.number)
        yield* t.begin('fetch', `Fetching #${ref.number}: ${pr.title}`)
        if (!cachedSort) {
          const q = yield* quick(ref, headSha, t)
          if (q) return q
        }
        const wantOpinion = automatic && !cachedOpinion
        // Fetched while the sort runs.
        const contextFiber = wantOpinion ? yield* Effect.forkChild(opiner.context(ref, headSha)) : undefined
        const sortPrompt = cachedSort ? undefined : yield* sorter.prepare(ref, headSha)
        yield* t.end('fetch', 'done')
        if (cachedSort) {
          yield* t.begin('sort', 'Sorted earlier')
          yield* t.end('sort', 'done')
        }

        // Kept outside the session, so a rerun on another account skips what already finished.
        let sort = cachedSort
        let context: OpinionContext | undefined
        let opinionError: string | undefined
        let high: AgentOpinion | undefined
        let low: AgentOpinion | undefined

        const step = (w: Worker, s: string): Worker => ({ ...w, step: s, recent: w.step ? [...w.recent, w.step].slice(-4) : w.recent })
        const options = (slot: Slot): SessionOptions => ({
          cwd: git.dir(repoKey),
          ...(wantOpinion ? { related: repoSettings(settings, repoKey).related.map((r) => r.repo) } : {}),
          log: { kind: 'sort', owner: ref.owner, repo: ref.repo, number: ref.number, headSha },
          onStep: (s) => Effect.suspend(() => t.worker(slot.phase, slot.worker, (w) => step(w, s))),
          onText: (line) =>
            Effect.suspend(() => {
              const id = JUDGING.exec(line)?.[1]
              const i = slot.judging.findIndex((d) => d.id === id)
              if (i < 0) return Effect.void
              return t.worker(slot.phase, slot.worker, (w) => ({ ...w, current: `Judging ${i + 1} of ${slot.judging.length}: ${slot.judging[i]!.title}` }))
            }),
        })
        const named = (slot: Slot, a: AgentAccount) => t.worker(slot.phase, slot.worker, (w) => ({ ...w, account: a.name }))
        const ask = (turns: AgentTurns, c: OpinionContext, group: ReadonlyArray<Decision>, model: 'fast' | 'main', continued: boolean) =>
          Effect.flatMap(c.prompt(group, { continued }), (prompt) => turns.structured(prompt, AgentOpinion, model, 'opinion'))

        const main: Slot = { phase: 'sort', worker: 0, judging: [] }
        const session = agent.session(options(main), (turns, account) =>
          Effect.gen(function* () {
            let continued = false
            if (!sort) {
              main.phase = 'sort'
              yield* t.begin('sort', `Sorting ${plural(sortPrompt!.files.length, 'file')}`)
              yield* named(main, account)
              sort = sortPrompt!.finish(yield* turns.structured(sortPrompt!.prompt, AgentSort, 'fast', 'sort'))
              yield* sorter.remember(ref, headSha, sort)
              yield* t.end('sort', 'done')
              continued = true
            }
            if (!contextFiber) return
            const got = yield* Effect.result(Fiber.join(contextFiber))
            if (got._tag === 'Failure') return void (opinionError = got.failure.message)
            const c = (context = got.success)
            const decisions = sort.decisions
            if (!decisions.length) return
            const hi = decisions.filter((d) => impact(d) === 'high')
            const lo = decisions.filter((d) => impact(d) === 'low')
            yield* t.begin('opinion', `Judging ${plural(decisions.length, 'decision')}`)
            const other = decisions.length > 4 && hi.length && lo.length ? (yield* agent.idle()).find((a) => a.id !== account.id) : undefined
            Object.assign(main, { phase: 'opinion', judging: other ? hi : [...hi, ...lo] })
            yield* named(main, account)

            const side: Slot = { phase: 'opinion', worker: 1, judging: lo }
            const elsewhere: Effect.Effect<AgentOpinion | undefined, AgentError> =
              other && !low
                ? agent.session({ ...options(side), avoid: new Set([account.id]) }, (turns2, account2) =>
                    Effect.andThen(named(side, account2), ask(turns2, c, lo, 'fast', false)),
                  )
                : Effect.undefined
            const [, away] = yield* Effect.all(
              [high || !hi.length ? Effect.void : Effect.map(ask(turns, c, hi, 'main', continued), (a) => void (high = a)), Effect.result(elsewhere)],
              { concurrency: 2 },
            )
            if (away._tag === 'Success' && away.success) low = away.success
            if (!low && lo.length) {
              main.judging = [...hi, ...lo]
              low = yield* ask(turns, c, lo, 'fast', continued)
            }
          }),
        )
        const outcome = yield* Effect.result(session)
        if (outcome._tag === 'Failure') {
          if (!sort) return yield* outcome.failure
          opinionError ??= outcome.failure.message
        }
        if (!sort) return yield* Effect.die('the session ended without a sort')

        let opinion: PrOpinion | undefined
        if (context && !opinionError) {
          const order = new Map(sort.decisions.map((d, i) => [d.id, i]))
          const answers = [...(high?.decisions ?? []), ...(low?.decisions ?? [])].filter((a) => order.has(a.decisionId))
          const made = yield* Effect.result(context.finish({ decisions: answers.sort((a, b) => order.get(a.decisionId)! - order.get(b.decisionId)!) }, sort.decisions))
          if (made._tag === 'Failure') opinionError = made.failure.message
          else {
            opinion = made.success
            yield* opiner.remember(ref, headSha, opinion)
            yield* Effect.orDie(store.lastOpinion.set(`${repoKey}#${ref.number}`, { headSha, ...(sort.mergeBase ? { mergeBase: sort.mergeBase } : {}), opinion }))
          }
        }
        if (wantOpinion) yield* t.end('opinion', opinionError ? 'failed' : 'done')
        return { sort, opinion: opinion ?? cachedOpinion ?? null, ...(opinionError ? { opinionError } : {}) } satisfies Review
      })

      const ensure = Effect.fnUntraced(function* (ref: PrRef, headSha: string) {
        const key = keyOf(ref, headSha)
        const running = runs.get(key)
        if (running) return running
        const phases = yield* SubscriptionRef.make<ReadonlyArray<Phase>>([])
        const done = yield* Deferred.make<Review, SortError>()
        // Another caller may have started one while these were made.
        const raced = runs.get(key)
        if (raced) return raced
        const run = { phases, done }
        runs.set(key, run)
        const t = tracker(phases)
        yield* Effect.forkIn(
          work(ref, headSha, t).pipe(
            Effect.onError(() => t.failRunning),
            Effect.onExit((exit) => Effect.andThen(Deferred.done(done, exit), Effect.sync(() => void runs.delete(key)))),
          ),
          scope,
        )
        return run
      })

      return Reviewer.of({
        prepare: (ref, headSha) => Effect.asVoid(ensure(ref, headSha)),
        progress: (ref, headSha) =>
          Stream.unwrap(
            Effect.sync(() => {
              const run = runs.get(keyOf(ref, headSha))
              return run ? SubscriptionRef.changes(run.phases) : Stream.empty
            }),
          ),
        result: (ref, headSha) => Effect.flatMap(ensure(ref, headSha), (run) => Deferred.await(run.done)),
      })
    }),
  )
}
