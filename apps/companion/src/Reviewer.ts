import { type AgentAccount, type AgentDecisionOpinion, type AgentFinding, AgentOpinion, AgentQuick, AgentSort, type Decision, type DecisionOpinion, impact, opinionsMode, type Phase, type PrOpinion, type PrRef, repoSettings, smallPrLines, type SortResult } from '@pr-review/domain'
import { readFileSync } from 'node:fs'
import { type Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Stream, SubscriptionRef } from 'effect'
import { Agent, type AgentTurns, type SessionOptions } from './Agent.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { GitHub } from './GitHub.ts'
import { judged, type OpinionContext, Opiner, quickDecision } from './Opiner.ts'
import { annotate, measure } from './Perf.ts'
import { carryFindingStates } from './carry.ts'
import { type SortError, Sorter, writtenDecisions } from './Sorter.ts'
import { Store } from './Store.ts'
import { type TicketSummary, Tickets } from './Tickets.ts'
import { needsTicketAgent } from './ticketRefs.ts'
import { buildTrusted } from './trusted.ts'

const quickInstructions = readFileSync(new URL('../prompts/quick.md', import.meta.url), 'utf8')

export type Review = { sort: SortResult; opinion: PrOpinion | null; opinionError?: string }

type Worker = Phase['workers'][number]
type Phases = SubscriptionRef.SubscriptionRef<ReadonlyArray<Phase>>

/** Phase updates that only set values, so a session `use` that reruns on another account repeats them harmlessly. */
const tracker = (phases: Phases, partial: SubscriptionRef.SubscriptionRef<Review | undefined>) => {
  const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())
  const update = (id: Phase['id'], f: (p: Phase) => Phase) => SubscriptionRef.update(phases, (ps) => ps.map((p) => (p.id === id ? f(p) : p)))
  return {
    /** The review so far, while the opinion is still being judged. */
    partial: (r: Review) => SubscriptionRef.set(partial, r),
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

/** Where a session's steps go. */
type Slot = { phase: Phase['id']; worker: number }

/** A finding as the agent gave it, so a carried one is checked and anchored again at the new head. */
const asAgentFinding = ({ severity, axis, kind, title, take, evidence, alternative, comment, anchor, handledIn }: AgentFinding): AgentFinding => ({ severity, axis, kind, title, take, evidence, alternative, comment, anchor, handledIn })

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export class Reviewer extends Context.Service<
  Reviewer,
  {
    /** Starts preparing the review of this head, or joins the run already going. Runs in the companion's scope. */
    prepare(ref: PrRef, headSha: string): Effect.Effect<void>
    /** The running preparation's phases: the current ones, then each change. Never ends; empty when nothing runs. */
    progress(ref: PrRef, headSha: string): Stream.Stream<ReadonlyArray<Phase>>
    /** The prepared review, starting a preparation when none runs. A failed opinion still returns the sort. */
    result(ref: PrRef, headSha: string): Effect.Effect<Review, SortError>
    /** The running preparation's review so far: from the sort on, then after each decision judged. Never ends; empty when nothing runs. */
    partial(ref: PrRef, headSha: string): Stream.Stream<Review>
    /** Marks the PR stopped, so `prepare` leaves it alone, then interrupts its runs (any head) and waits for them to end. */
    stop(ref: PrRef): Effect.Effect<void>
    /** Clears the mark `stop` set. */
    resume(ref: PrRef): Effect.Effect<void>
    isStopped(ref: PrRef): Effect.Effect<boolean>
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
      const tickets = yield* Tickets
      const scope = yield* Effect.scope
      const prKey = (ref: PrRef) => `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`
      const keyOf = (ref: PrRef, headSha: string) => `${prKey(ref)}@${headSha}`
      type Run = { phases: Phases; partial: SubscriptionRef.SubscriptionRef<Review | undefined>; done: Deferred.Deferred<Review, SortError>; fiber?: Fiber.Fiber<Review, SortError> }
      const runs = new Map<string, Run>()
      const isStopped = (ref: PrRef) => store.stopped.has(prKey(ref)).pipe(Effect.orDie)

      /** Small PRs get one turn on the whole change instead of piles. Undefined means sort as usual. */
      const quick = Effect.fnUntraced(function* (ref: PrRef, headSha: string, t: Tracker, ticket: Fiber.Fiber<TicketSummary>) {
        const repoKey = `${ref.host}/${ref.owner}/${ref.repo}`
        const settings = yield* config.settings
        const gh = yield* github.forHost(ref.host)
        const pr = yield* gh.getPr(ref.owner, ref.repo, ref.number)
        const { headSha: head, mergeBase } = yield* git.fetchPr(repoKey, ref.number, pr.baseRef, headSha)
        const [files, checks] = yield* Effect.all([git.numstat(repoKey, mergeBase, head), gh.getChecks(ref.owner, ref.repo, head)], { concurrency: 2 })
        const { groups, rest } = buildTrusted(files, checks, settings.review.likelyTrusted, settings.review.neverTrust)
        const lines = rest.reduce((n, f) => n + f.additions + f.deletions, 0)
        yield* annotate({
          files: files.length,
          additions: files.reduce((n, f) => n + f.additions, 0),
          deletions: files.reduce((n, f) => n + f.deletions, 0),
          reviewLines: lines,
          quick: lines < smallPrLines(settings),
        })
        if (lines >= smallPrLines(settings)) return undefined

        const contextFiber = yield* Effect.forkChild(opiner.context(ref, headSha))
        yield* t.end('fetch', 'done')
        yield* t.begin('quick', `Reading the change: ${lines} lines in ${plural(rest.length, 'file')}`)
        if (!ticket.pollUnsafe()) yield* t.worker('quick', 0, (w) => ({ ...w, step: 'Reading the ticket' }))
        yield* Fiber.join(ticket).pipe(measure('context.wait', { on: 'ticket' }))
        const c = yield* Fiber.join(contextFiber).pipe(
          measure('context.wait', { on: 'context' }),
          Effect.onError(() => t.end('quick', 'failed')),
        )
        const changes = quickDecision({ skim: [{ area: 'Changes', summary: '', files: rest.map((f) => f.path) }] })
        const prompt = `${yield* c.prompt([changes])}\n\n${quickInstructions}`
        const options: SessionOptions = {
          cwd: c.cwd,
          repo: c.repo,
          related: c.related,
          log: { kind: 'sort', owner: ref.owner, repo: ref.repo, number: ref.number, headSha },
          onStep: (s) => Effect.suspend(() => t.worker('quick', 0, (w) => ({ ...w, step: s, recent: w.step ? [...w.recent, w.step].slice(-4) : w.recent }))),
        }
        const answer = yield* agent
          .session(options, (turns, account) =>
            Effect.andThen(
              t.worker('quick', 0, (w) => ({ ...w, account: account.name })),
              turns.structured(prompt, AgentQuick, 'fast', 'sort'),
            ),
          )
          .pipe(Effect.onError(() => t.end('quick', 'failed')))

        const sort: SortResult = {
          headSha: head,
          mergeBase,
          summary: answer.summary,
          decisions: [],
          skim: [{ area: 'Changes', summary: answer.summary, files: rest.map((f) => f.path) }],
          trusted: groups,
          claims: [],
          unclaimedDecisionIds: [],
          lines: { decision: 0, skim: lines, trusted: files.reduce((n, f) => n + f.additions + f.deletions, 0) - lines },
          quick: true,
        }
        yield* sorter.remember(ref, headSha, sort)
        const made = yield* Effect.result(c.finish({ decisions: [{ decisionId: 'changes', authorCase: answer.authorCase, checked: answer.checked, findings: answer.findings }] }, [changes]))
        let opinion: PrOpinion | undefined
        let opinionError: string | undefined
        if (made._tag === 'Failure') opinionError = made.failure.message
        else {
          opinion = made.success
          yield* opiner.remember(ref, headSha, opinion)
          yield* Effect.orDie(store.lastOpinion.set(`${repoKey}#${ref.number}`, { headSha, mergeBase, opinion }))
        }
        yield* t.end('quick', 'done')
        return { sort, opinion: opinion ?? null, ...(opinionError ? { opinionError } : {}) } satisfies Review
      })

      const work = Effect.fnUntraced(function* (ref: PrRef, headSha: string, t: Tracker) {
        const automatic = opinionsMode(yield* config.settings) === 'automatic'
        const [cachedSort, cachedOpinion] = yield* Effect.all([sorter.cached(ref, headSha), opiner.cached(ref, headSha)])
        yield* annotate({ automatic, sortCached: cachedSort !== undefined, opinionCached: cachedOpinion !== undefined })
        if (cachedSort && (cachedOpinion || !automatic)) return { sort: cachedSort, opinion: cachedOpinion ?? null } satisfies Review
        if (cachedSort) return yield* prepared(ref, headSha, t, cachedSort, cachedOpinion)
        // A sort started elsewhere (the stack page, say) is joined, so one head never has two sorts with different decision ids.
        const claim = yield* sorter.claim(ref, headSha)
        yield* annotate({ sortJoined: 'running' in claim })
        if ('running' in claim) return yield* prepared(ref, headSha, t, undefined, cachedOpinion, claim.running)
        return yield* prepared(ref, headSha, t, undefined, cachedOpinion).pipe(Effect.onExit((exit) => claim.done(Exit.map(exit, (r) => r.sort))))
      })

      const prepared = Effect.fnUntraced(function* (
        ref: PrRef,
        headSha: string,
        t: Tracker,
        sortedEarlier: SortResult | undefined,
        cachedOpinion: PrOpinion | undefined,
        running?: Effect.Effect<SortResult, SortError>,
      ) {
        const repoKey = `${ref.host}/${ref.owner}/${ref.repo}`
        const settings = yield* config.settings
        const automatic = opinionsMode(settings) === 'automatic'
        yield* t.begin('fetch', `Fetching #${ref.number}`)
        const gh = yield* github.forHost(ref.host)
        const pr = yield* gh.getPr(ref.owner, ref.repo, ref.number)
        yield* t.begin('fetch', `Fetching #${ref.number}: ${pr.title}`)
        // Started now so the turn that needs it waits least; `opiner.context` joins the same lookup.
        const ticket = yield* Effect.forkChild(tickets.summary(ref, pr))
        let cachedSort = sortedEarlier
        if (running) {
          yield* t.end('fetch', 'done')
          yield* t.begin('sort', `Sorting #${ref.number}: joining the sort already running`)
          cachedSort = yield* running.pipe(measure('sort.join'))
          yield* t.end('sort', 'done')
          if (cachedOpinion || !automatic) {
            yield* Fiber.interrupt(ticket)
            return { sort: cachedSort, opinion: cachedOpinion ?? null } satisfies Review
          }
        } else if (!cachedSort) {
          const q = yield* quick(ref, headSha, t, ticket)
          if (q) return q
        }
        const wantOpinion = automatic && !cachedOpinion
        if (!wantOpinion) yield* Fiber.interrupt(ticket)
        // Fetched while the sort runs.
        const contextFiber = wantOpinion ? yield* Effect.forkChild(opiner.context(ref, headSha)) : undefined
        // A push to a PR reviewed before is sorted from that sort and the interdiff, and decisions whose change is the
        // same keep their opinion; a push of `RESORT_LINES` or more starts over.
        const last = cachedSort ? undefined : Option.getOrUndefined(yield* Effect.orDie(store.lastOpinion.get(`${repoKey}#${ref.number}`)))
        const previous = last ? yield* sorter.since(ref, headSha, last) : undefined
        const sortPrompt = cachedSort ? undefined : yield* sorter.prepare(ref, headSha, undefined, previous)
        yield* t.end('fetch', 'done')
        if (sortedEarlier) {
          yield* t.begin('sort', 'Sorted earlier')
          yield* t.end('sort', 'done')
        }

        // Kept outside the sessions, so a rerun on another account skips what already finished.
        let sort = cachedSort
        let context: OpinionContext | undefined
        let opinionError: string | undefined
        // A ticket only an agent can read is checked in a turn of its own, so judging doesn't wait for it.
        const slowTicket = wantOpinion && needsTicketAgent(pr, ref.host)
        const answers = new Map<string, AgentDecisionOpinion>()
        const specAnswers = new Map<string, AgentDecisionOpinion>()
        let specDone = !slowTicket
        let specReady = false
        let specTaken = false
        const decided = new Map<string, DecisionOpinion>()
        /** Decisions the sort keeps from the previous head (see `Sorter.since`), with the opinion they had there. */
        const carried = new Map<string, { decision: Decision; opinion: DecisionOpinion }>()
        for (const d of previous?.kept ?? []) {
          const opinion = last?.opinion.decisions.find((o) => o.decisionId === d.id)
          if (opinion) carried.set(d.id, { decision: d, opinion })
        }
        /** What is left for the agent to judge. */
        const toJudge = (s: SortResult) => judged(s).filter((d) => !carried.has(d.id))
        // Each decision once, taken from the sort as it writes them, then the rest of the finished sort; then the spec turn.
        const queue = yield* Queue.unbounded<Decision | 'spec', Cause.Done>()
        const queued: Decision[] = []
        const taken = new Set<string>()
        const found = yield* Deferred.make<void>()
        const sorted = yield* Deferred.make<void>()
        let streamed = 0
        // Opinion workers are numbered as they join, so sessions that start during the sort come first.
        let workers = 0

        const enqueue = (ds: ReadonlyArray<Decision>) =>
          Effect.gen(function* () {
            const fresh = ds.filter((d) => !queued.some((q) => q.id === d.id) && !carried.has(d.id))
            if (!fresh.length) return
            queued.push(...fresh)
            yield* Queue.offerAll(queue, fresh)
            yield* t.begin('opinion', `Judging ${plural(queued.length, 'decision')}`)
            yield* Deferred.succeed(found, undefined)
          })
        const known = new Set(sortPrompt?.files.map((f) => f.path))
        let sortText = ''
        /** Decisions the sort has finished writing, kept as `normalize` keeps them. */
        const fromSort = (delta: string) =>
          Effect.suspend(() => {
            sortText += delta
            const ds = writtenDecisions(sortText).flatMap((d) => {
              const files = d.files.filter((f) => known.has(f.path))
              return files.length ? [{ ...d, files }] : []
            })
            return enqueue(ds)
          })

        /** The review so far, for the page to show while the rest is judged. */
        const publish = Effect.suspend(() => {
          if (!sort) return Effect.void
          const s = sort
          if (!context) return t.partial({ sort: s, opinion: null })
          return Effect.flatMap(context.opinion(judged(s).flatMap((d) => decided.get(d.id) ?? []), true), (opinion) => t.partial({ sort: s, opinion }))
        })
        /** Carried opinions, checked and anchored at this head, marked with the head they were judged on. */
        const settleCarried = (c: OpinionContext) =>
          Effect.forEach(
            [...carried].filter(([id]) => !decided.has(id)),
            ([id, { decision, opinion }]) =>
              c.decide({ decisionId: id, authorCase: opinion.authorCase, checked: opinion.checked, findings: opinion.findings.map(asAgentFinding) }, decision, opinion.deep).pipe(
                Effect.orElseSucceed(() => undefined),
                Effect.flatMap((made) => {
                  if (made) return Effect.sync(() => void decided.set(id, { ...made, carriedFrom: opinion.carriedFrom ?? previous!.headSha }))
                  // Judged afresh: by a session while the queue is open, else by the last retry.
                  carried.delete(id)
                  return enqueue([decision])
                }),
              ),
            { discard: true },
          ).pipe(Effect.andThen(publish))
        /** A decision's answers so far, with its Spec findings once they are in, made the decision's opinion. */
        const settle = (c: OpinionContext, id: string) =>
          Effect.gen(function* () {
            const a = answers.get(id)
            const d = (sort ? judged(sort) : queued).find((x) => x.id === id)
            if (!a || !d) return
            const made = yield* c.decide({ ...a, findings: [...a.findings, ...(specAnswers.get(id)?.findings ?? [])] }, d)
            if (made) decided.set(id, made)
            yield* publish
          }).pipe(Effect.catch((e) => Effect.sync(() => void (opinionError ??= e.message))))

        const step = (w: Worker, s: string): Worker => ({ ...w, step: s, recent: w.step ? [...w.recent, w.step].slice(-4) : w.recent })
        const options = (slot: Slot): SessionOptions => ({
          cwd: git.dir(repoKey),
          repo: repoKey,
          ...(wantOpinion ? { related: repoSettings(settings, repoKey).related.map((r) => r.repo) } : {}),
          log: { kind: 'sort', owner: ref.owner, repo: ref.repo, number: ref.number, headSha },
          onStep: (s) => Effect.suspend(() => t.worker(slot.phase, slot.worker, (w) => step(w, s))),
        })
        const named = (slot: Slot, a: AgentAccount) => t.worker(slot.phase, slot.worker, (w) => ({ ...w, account: a.name }))

        const judgeTurn = (turns: AgentTurns, c: OpinionContext, ds: ReadonlyArray<Decision>, o: { continued: boolean; brief: boolean }) =>
          Effect.gen(function* () {
            const prompt = yield* c.prompt(ds, { ...o, ...(slowTicket ? { spec: 'skip' as const } : {}) })
            const model = sort?.quick || ds.some((d) => impact(d) === 'high') ? 'main' : 'fast'
            const answer = yield* turns.structured(prompt, AgentOpinion, model, 'opinion')
            for (const a of answer.decisions) answers.set(a.decisionId, a)
            yield* Effect.forEach(answer.decisions, (a) => settle(c, a.decisionId), { discard: true })
          })
        const specTurn = (turns: AgentTurns, c: OpinionContext, continued: boolean) =>
          Effect.gen(function* () {
            const prompt = yield* c.prompt(toJudge(sort!), { continued, spec: 'only' })
            const answer = yield* turns.structured(prompt, AgentOpinion, 'main', 'opinion')
            for (const a of answer.decisions) specAnswers.set(a.decisionId, a)
            specDone = true
            yield* Effect.forEach(answer.decisions, (a) => settle(c, a.decisionId), { discard: true })
          })

        /**
         * Takes from the queue one turn at a time until it is drained. The first turn in a session gets the whole
         * context, later ones only their decision and diff; `continued` means the sort ran in this session.
         */
        const judge = (turns: AgentTurns, slot: Slot, continued: boolean) =>
          Effect.gen(function* () {
            yield* turns.ready
            if (!contextFiber!.pollUnsafe())
              yield* t.worker('opinion', slot.worker, (w) => step(w, slowTicket || ticket.pollUnsafe() ? 'Reading the stack and review guidance' : 'Reading the ticket'))
            const got = yield* Effect.result(Fiber.join(contextFiber!).pipe(measure('context.wait', { on: 'context' })))
            if (got._tag === 'Failure') return void (opinionError = got.failure.message)
            const c = (context = got.success)
            yield* settleCarried(c)
            let first = true
            for (;;) {
              // The spec turn goes first once it can run, so it doesn't trail the last decision.
              const item = specReady && !specTaken ? 'spec' : yield* Queue.take(queue).pipe(Effect.orElseSucceed(() => undefined))
              if (!item) return
              if (item === 'spec') {
                if (specTaken) continue
                specTaken = true
                yield* t.worker('opinion', slot.worker, (w) => ({ ...w, current: 'Checking the ticket' }))
                yield* specTurn(turns, c, continued)
              } else {
                taken.add(item.id)
                // The finished sort may have dropped a decision it was writing.
                if (sort && !judged(sort).some((x) => x.id === item.id)) continue
                yield* t.worker('opinion', slot.worker, (w) => ({ ...w, current: `Judging ${queued.indexOf(item) + 1} of ${queued.length}: ${item.title}` }))
                yield* judgeTurn(turns, c, [item], { continued, brief: !first })
              }
              first = false
            }
          })

        // Never waits for a slot; the sort's session and the others drain the queue without it.
        const side = Effect.suspend(() => {
          const slot: Slot = { phase: 'opinion', worker: 0 }
          return agent.session({ ...options(slot), noWait: true }, (turns, account) =>
            Effect.andThen(
              Effect.suspend(() => ((slot.worker = workers++), named(slot, account))),
              judge(turns, slot, false),
            ),
          )
        })
        /** Ends the queue once the sort is done; first, when the ticket is read, the spec turn goes in ahead of what is left. */
        const specGate = Effect.gen(function* () {
          yield* Deferred.await(sorted)
          if (sort && !specDone && toJudge(sort).length) {
            yield* Fiber.await(ticket)
            specReady = true
            // Queued too, to wake a session waiting on the queue.
            yield* Queue.offer(queue, 'spec')
          }
          yield* Queue.end(queue)
        })
        let started = 0
        /** A session on every free slot, while there is still something to take. */
        const launch = Effect.gen(function* () {
          if (sort && queued.every((d) => answers.has(d.id) || taken.has(d.id)) && (specDone || specTaken)) return
          const free = yield* agent.freeSlots()
          started += free
          return Array.from({ length: free }, () => Effect.ignore(side))
        })
        /** Sessions once there is something to judge and the context is ready, and more when the ticket read gives its slot back. */
        const sides = Effect.gen(function* () {
          yield* Deferred.await(found)
          if (!contextFiber || !queued.length) return
          yield* Fiber.await(contextFiber)
          const first = yield* launch
          const later = Effect.andThen(Fiber.await(ticket), Effect.flatMap(launch, (more) => Effect.all(more ?? [], { concurrency: 'unbounded', discard: true })))
          yield* Effect.all([...(first ?? []), later], { concurrency: 'unbounded', discard: true })
          yield* annotate({ sideSessions: started })
        })

        const main: Slot = { phase: 'sort', worker: 0 }
        // Begun before the session takes an account, so a wait for one shows on it.
        if (!sort) yield* t.begin('sort', `Sorting ${plural(sortPrompt!.files.length, 'file')}`)
        else if (!judged(sort).length) opinionError = 'Nothing to judge'
        else yield* t.begin('opinion', `Judging ${plural(judged(sort).length, 'decision')}`)
        const session = agent.session({ ...options(main), ...(contextFiber && !sort ? { onDelta: (d: string) => (main.phase === 'sort' ? fromSort(d) : Effect.void) } : {}) }, (turns, account) =>
          Effect.gen(function* () {
            let continued = false
            if (!sort) {
              main.phase = 'sort'
              sortText = ''
              yield* t.begin('sort', `Sorting ${plural(sortPrompt!.files.length, 'file')}`)
              yield* named(main, account)
              sort = sortPrompt!.finish(yield* turns.structured(sortPrompt!.prompt, AgentSort, 'main', 'sort'))
              yield* sorter.remember(ref, headSha, sort)
              yield* t.end('sort', 'done')
              streamed = queued.length
              continued = true
            }
            if (!contextFiber) return
            yield* publish
            yield* enqueue(judged(sort))
            yield* Deferred.succeed(sorted, undefined)
            if (!judged(sort).length) return void (opinionError = 'Nothing to judge')
            yield* t.begin('opinion', `Judging ${plural(judged(sort).length, 'decision')}`)
            if (main.phase === 'sort') main.worker = workers++
            main.phase = 'opinion'
            yield* named(main, account)
            yield* judge(turns, main, continued)
          }),
        )
        // Nothing for a session to do: the sort is known and there is no opinion to make.
        const outcome =
          sort && (!contextFiber || opinionError)
            ? undefined
            : (yield* Effect.all(
                [
                  // A failed session never sorted, or can't judge: nothing more goes in the queue.
                  Effect.result(session).pipe(Effect.ensuring(Effect.all([Deferred.succeed(sorted, undefined), Deferred.succeed(found, undefined)]))),
                  sides,
                  specGate,
                ],
                { concurrency: 'unbounded' },
              ))[0]
        if (outcome?._tag === 'Failure') {
          if (!sort) return yield* outcome.failure
          opinionError ??= outcome.failure.message
        }
        if (!sort) return yield* Effect.die('the session ended without a sort')

        // A turn that failed in another session left its work; one more try in a session of its own.
        if (context) yield* settleCarried(context)
        const left = context && !opinionError ? toJudge(sort).filter((d) => !answers.has(d.id)) : []
        const specLeft = context !== undefined && !opinionError && !specDone && toJudge(sort).length > 0
        if (left.length || specLeft) {
          const c = context!
          const retried = yield* Effect.result(
            agent.session(options(main), (turns) =>
              Effect.andThen(left.length ? judgeTurn(turns, c, left, { continued: false, brief: false }) : Effect.void, specLeft ? specTurn(turns, c, false) : Effect.void),
            ),
          )
          if (retried._tag === 'Failure') opinionError = retried.failure.message
        }
        if (contextFiber && judged(sort).length) {
          const decisions = judged(sort)
          yield* annotate({ decisions: decisions.length, highDecisions: decisions.filter((d) => impact(d) === 'high').length, streamed, retried: left.length, slowTicket, specRetried: specLeft, since: previous !== undefined, carried: carried.size })
        }

        let opinion: PrOpinion | undefined
        if (context && !opinionError) {
          opinion = yield* context.opinion(judged(sort).flatMap((d) => decided.get(d.id) ?? []))
          yield* opiner.remember(ref, headSha, opinion)
          yield* Effect.orDie(store.lastOpinion.set(`${repoKey}#${ref.number}`, { headSha, ...(sort.mergeBase ? { mergeBase: sort.mergeBase } : {}), opinion }))
          // What the reviewer did with a carried finding (posted, dismissed) carries with it; a finding keeps its id, as its decision does.
          const ids = new Set(opinion.decisions.filter((d) => d.carriedFrom !== undefined).flatMap((d) => d.findings.map((f) => f.id)))
          if (last) yield* carryFindingStates(store, `${repoKey}#${ref.number}@${last.headSha}`, `${repoKey}#${ref.number}@${headSha}`, ids)
        }
        if (wantOpinion) yield* t.end('opinion', opinionError ? 'failed' : 'done')
        return { sort, opinion: opinion ?? cachedOpinion ?? null, ...(opinionError ? { opinionError } : {}) } satisfies Review
      })

      const ensure = Effect.fnUntraced(function* (ref: PrRef, headSha: string) {
        const key = keyOf(ref, headSha)
        const running = runs.get(key)
        if (running) return running
        const phases = yield* SubscriptionRef.make<ReadonlyArray<Phase>>([])
        const partial = yield* SubscriptionRef.make<Review | undefined>(undefined)
        const done = yield* Deferred.make<Review, SortError>()
        // Another caller may have started one while these were made.
        const raced = runs.get(key)
        if (raced) return raced
        const run: Run = { phases, partial, done }
        runs.set(key, run)
        const t = tracker(phases, partial)
        run.fiber = yield* Effect.forkIn(
          work(ref, headSha, t).pipe(
            measure('operation', { kind: 'review', owner: ref.owner, repo: ref.repo, prNumber: ref.number, headSha }),
            Effect.onError(() => t.failRunning),
            Effect.onExit((exit) => Effect.andThen(Deferred.done(done, exit), Effect.sync(() => void runs.delete(key)))),
          ),
          scope,
        )
        return run
      })

      return Reviewer.of({
        prepare: (ref, headSha) => Effect.flatMap(isStopped(ref), (stopped) => (stopped ? Effect.void : Effect.asVoid(ensure(ref, headSha)))),
        progress: (ref, headSha) =>
          Stream.unwrap(
            Effect.sync(() => {
              const run = runs.get(keyOf(ref, headSha))
              return run ? SubscriptionRef.changes(run.phases) : Stream.empty
            }),
          ),
        result: (ref, headSha) => Effect.flatMap(ensure(ref, headSha), (run) => Deferred.await(run.done)),
        partial: (ref, headSha) =>
          Stream.unwrap(
            Effect.sync(() => {
              const run = runs.get(keyOf(ref, headSha))
              return run ? SubscriptionRef.changes(run.partial).pipe(Stream.filter((r): r is Review => r !== undefined)) : Stream.empty
            }),
          ),
        stop: (ref) =>
          Effect.gen(function* () {
            yield* Effect.orDie(store.stopped.set(prKey(ref), true))
            const mine = [...runs].filter(([key]) => key.startsWith(`${prKey(ref)}@`)).flatMap(([, run]) => (run.fiber ? [run.fiber] : []))
            yield* Fiber.interruptAll(mine)
            yield* sorter.cancel(ref)
          }),
        resume: (ref) => Effect.orDie(store.stopped.remove(prKey(ref))),
        isStopped,
      })
    }),
  )
}
