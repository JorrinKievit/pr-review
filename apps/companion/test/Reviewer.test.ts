import { assert, describe, it } from '@effect/vitest'
import { type AgentAccount, AgentError, type AgentFinding, type AgentQuick, type FileStat, type AgentOpinion, type AgentSort, type Decision, GitError, type Phase, type SortResult } from '@pr-review/domain'
import { Deferred, Effect, Fiber, Layer, Option, Stream } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { Opiner } from '../src/Opiner.ts'
import { Reviewer } from '../src/Reviewer.ts'
import { Sorter } from '../src/Sorter.ts'
import type { GitHubClient } from '../src/GitHub.ts'
import { Store } from '../src/Store.ts'
import { type TicketSummary, Tickets } from '../src/Tickets.ts'
import { type AgentCall, configLayer, fakeAccount, fakeAccount2, fakeAgent, fakeGit, fakeGitHub, pr, ref } from './fakes.ts'

const decision = (id: string, high: boolean): Decision => ({
  id,
  title: `Decision ${id}`,
  lens: high ? 'architecture' : 'quality',
  reason: high ? 'shared-layer' : 'convention',
  theme: 't',
  note: 'n',
  existing: null,
  authorWhy: null,
  files: [{ path: `src/${id}.ts`, ranges: [] }],
})
// Sort order mixes the groups, so the merge has to put them back.
const many = [decision('h1', true), decision('l1', false), decision('h2', true), decision('l2', false), decision('l3', false)]
const few = [decision('h1', true), decision('l1', false)]
const sortOf = (decisions: Decision[]): AgentSort => ({ decisions, skim: [], claims: [] })
const opinionOn = (prompt: string): AgentOpinion => ({
  decisions: [...prompt.matchAll(/"id":"(\w+)"/g)].map(([, id]) => ({ decisionId: id!, authorCase: `case ${id}`, checked: 'looked', findings: [] })),
})
const idsIn = (call: AgentCall) => [...call.prompt.split('# Decisions\n').at(-1)!.matchAll(/"id":"(\w+)"/g)].map(([, id]) => id)

const setup = (
  o: {
    stats?: FileStat[]
    decisions?: Decision[]
    pool?: ReadonlyArray<AgentAccount>
    opinion?: (call: AgentCall) => Effect.Effect<unknown, AgentError>
    sort?: (call: AgentCall) => Effect.Effect<unknown, AgentError>
    ticket?: Effect.Effect<TicketSummary>
    github?: Partial<GitHubClient>
    diff?: (from: string, to: string, paths: ReadonlyArray<string>) => string | GitError
  } = {},
) => {
  const agent = fakeAgent(
    (call) => (call.log.kind === 'opinion' || call.log.kind === 'deeper' ? (o.opinion?.(call) ?? Effect.succeed(opinionOn(call.prompt))) : (o.sort?.(call) ?? Effect.succeed(sortOf(o.decisions ?? many)))),
    undefined,
    o.pool,
  )
  const files = o.stats ?? (o.decisions ?? many).map((d) => ({ path: d.files[0]!.path, additions: 100, deletions: 1 }))
  const deps = Layer.mergeAll(agent.layer, fakeGit({ files, diff: o.diff ?? 'THE DIFF' }).layer, fakeGitHub(o.github), configLayer(), Layer.succeed(Tickets, Tickets.of({ summary: () => o.ticket ?? Effect.succeed({ text: null, note: 'none' }) })))
  const layer = Reviewer.layer.pipe(Layer.provideMerge(Opiner.layer), Layer.provideMerge(Sorter.layer), Layer.provideMerge(Store.layerWith(KeyValueStore.layerMemory)), Layer.provideMerge(deps))
  return { agent, layer }
}

const review = Effect.gen(function* () {
  return yield* (yield* Reviewer).result(ref, 'HEAD1')
})
/** Each opinion turn's decision ids, session and model, in call order. */
const opinionTurns = (calls: ReadonlyArray<AgentCall>) => calls.filter((c) => c.log.kind === 'opinion').map((c) => ({ ids: idsIn(c), session: c.session!, model: c.model, brief: c.prompt.startsWith('Now these decisions') }))
const modelFor = (id: string) => (id.startsWith('h') ? 'main' : 'fast')
/** Opinion answers that each wait until `n` sessions have asked, as real turns overlap; instant fake turns would let one session drain the queue. */
const overlapping = (n: number, answer: (call: AgentCall) => Effect.Effect<AgentOpinion, AgentError> = (call) => Effect.succeed(opinionOn(call.prompt))) => {
  const sessions = new Set<number>()
  const all = Deferred.makeUnsafe<void>()
  return (call: AgentCall) =>
    Effect.suspend(() => {
      sessions.add(call.session!)
      return Effect.andThen(sessions.size >= n ? Deferred.succeed(all, undefined) : Deferred.await(all), answer(call))
    })
}
const turns = (calls: ReadonlyArray<AgentCall>) => calls.map((c) => `${c.session}/${c.account}/${c.turn}/${c.model}/${c.log.kind}`)

const stat = (path: string, additions: number, deletions = 0): FileStat => ({ path, additions, deletions })
const quickAnswer = (call: AgentCall): AgentQuick => ({ summary: 'Adds a thing.', authorCase: `case for ${call.log.number}`, checked: 'looked', findings: [] })
const quickSetup = (stats: FileStat[]) => setup({ stats, sort: (call) => (call.prompt.includes('This PR is small') ? Effect.succeed(quickAnswer(call)) : Effect.succeed(sortOf(few))) })

describe('Reviewer', () => {
  it.effect('a 120-line PR takes the quick path in one turn, on the fast model', () =>
    Effect.gen(function* () {
      const { agent, layer } = quickSetup([stat('src/a.ts', 100, 5), stat('src/b.ts', 15)])
      const r = yield* review.pipe(Effect.provide(layer))
      assert.deepStrictEqual(turns(agent.calls), ['1/fake/0/fast/sort'])
      assert.isTrue(r.sort.quick)
      assert.match(agent.calls[0]!.prompt, /THE DIFF/)
    }))

  it.effect('the quick path shows "Reading the ticket" while it waits', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { layer } = setup({
        stats: [stat('src/a.ts', 30)],
        sort: (call) => Effect.succeed(quickAnswer(call)),
        ticket: Effect.as(Deferred.await(gate), { text: 'CORE-1: do it', note: 'read' }),
      })
      yield* Effect.gen(function* () {
        const reviewer = yield* Reviewer
        yield* reviewer.prepare(ref, 'HEAD1')
        const step = yield* reviewer.progress(ref, 'HEAD1').pipe(
          Stream.map((ps) => ps.find((p) => p.id === 'quick')?.workers[0]?.step),
          Stream.filter((s) => s !== undefined),
          Stream.runHead,
        )
        assert.strictEqual(Option.getOrThrow(step), 'Reading the ticket')
        yield* Deferred.succeed(gate, undefined)
        const r = yield* reviewer.result(ref, 'HEAD1')
        assert.strictEqual(r.opinion?.ticket, 'CORE-1: do it')
      }).pipe(Effect.provide(layer))
    }))

  it.effect("test and lockfile lines don't count", () =>
    Effect.gen(function* () {
      const { agent, layer } = quickSetup([stat('src/a.test.ts', 500), stat('pnpm-lock.yaml', 300), stat('src/a.ts', 50)])
      const r = yield* review.pipe(Effect.provide(layer))
      assert.strictEqual(agent.calls.length, 1)
      assert.isTrue(r.sort.quick)
      assert.deepStrictEqual(r.sort.skim[0]?.files, ['src/a.ts'])
      assert.isAbove(r.sort.trusted.length, 0)
    }))

  it.effect('a 300-line PR sorts', () =>
    Effect.gen(function* () {
      const { agent, layer } = quickSetup([stat('src/h1.ts', 300)])
      const r = yield* review.pipe(Effect.provide(layer))
      assert.isUndefined(r.sort.quick)
      assert.strictEqual(agent.calls[0]!.log.kind, 'sort')
      assert.notMatch(agent.calls[0]!.prompt, /This PR is small/)
    }))

  it.effect('quick result has a Changes area and an opinion on it, in the caches', () =>
    Effect.gen(function* () {
      const { layer } = quickSetup([stat('src/a.ts', 30)])
      const { r, sorted, opined } = yield* Effect.gen(function* () {
        const r = yield* review
        return { r, sorted: yield* (yield* Sorter).cached(ref, 'HEAD1'), opined: yield* (yield* Opiner).cached(ref, 'HEAD1') }
      }).pipe(Effect.provide(layer))
      assert.deepInclude(r.sort.skim[0], { area: 'Changes', summary: 'Adds a thing.', files: ['src/a.ts'] })
      assert.deepStrictEqual(r.sort.decisions, [])
      assert.deepStrictEqual(r.opinion?.decisions.map((d) => [d.decisionId, d.authorCase]), [['changes', 'case for 7']])
      assert.isTrue(sorted?.quick)
      assert.strictEqual(opined?.decisions.length, 1)
    }))

  it.effect('Dig deeper works on a quick PR', () =>
    Effect.gen(function* () {
      const { agent, layer } = quickSetup([stat('src/a.ts', 30)])
      const deeper = yield* Effect.gen(function* () {
        yield* review
        return yield* (yield* Opiner).deeper(ref, 'HEAD1', 'changes')
      }).pipe(Effect.provide(layer))
      assert.deepInclude(deeper, { decisionId: 'changes', authorCase: 'case changes', deep: true })
      assert.deepStrictEqual(idsIn(agent.calls.at(-1)!), ['changes'])
    }))

  it.effect('Run again on a quick PR keeps a real opinion', () =>
    Effect.gen(function* () {
      let above = 'sha8'
      const entry = (number: number, baseRef: string, headRef: string, headSha: string) => ({ number, title: `#${number}`, baseRef, headRef, headSha })
      const { agent, layer } = setup({
        stats: [stat('src/a.ts', 30)],
        sort: (call) => Effect.succeed(quickAnswer(call)),
        github: { listOpenPrs: () => Effect.sync(() => [entry(7, 'master', 'feat', 'HEAD1'), entry(8, 'feat', 'feat2', above)]) },
      })
      const again = yield* Effect.gen(function* () {
        yield* review
        above = 'sha8-new'
        return yield* (yield* Opiner).opine(ref, 'HEAD1')
      }).pipe(Effect.provide(layer))
      assert.strictEqual(agent.calls.filter((c) => c.log.kind === 'opinion').length, 1)
      assert.deepStrictEqual(again.decisions.map((d) => [d.decisionId, d.authorCase]), [['changes', 'case changes']])
    }))

  it.effect('a quick sort cached without its opinion judges the change as a whole again', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup({ stats: [stat('src/a.ts', 30)] })
      const quickSort: SortResult = {
        headSha: 'HEAD1',
        mergeBase: 'MB1',
        summary: 'Adds a thing.',
        decisions: [],
        skim: [{ area: 'Changes', summary: 'Adds a thing.', files: ['src/a.ts'] }],
        trusted: [],
        claims: [],
        unclaimedDecisionIds: [],
        lines: { decision: 0, skim: 30, trusted: 0 },
        quick: true,
      }
      const r = yield* Effect.gen(function* () {
        yield* (yield* Sorter).remember(ref, 'HEAD1', quickSort)
        return yield* review
      }).pipe(Effect.provide(layer))
      assert.deepStrictEqual(turns(agent.calls), ['1/fake/0/main/opinion'])
      assert.deepStrictEqual(idsIn(agent.calls[0]!), ['changes'])
      assert.isUndefined(r.opinionError)
      assert.deepStrictEqual(r.opinion?.decisions.map((d) => d.decisionId), ['changes'])
    }))

  it.effect('a sort with no decisions says there is nothing to judge, and caches no opinion', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup({ decisions: [], stats: [stat('src/a.ts', 300)] })
      const { r, opined } = yield* Effect.gen(function* () {
        const r = yield* review
        return { r, opined: yield* (yield* Opiner).cached(ref, 'HEAD1') }
      }).pipe(Effect.provide(layer))
      assert.strictEqual(r.opinionError, 'Nothing to judge')
      assert.isNull(r.opinion)
      assert.isUndefined(opined)
      assert.deepStrictEqual(turns(agent.calls), ['1/fake/0/main/sort'])
    }))

  it.effect('the sort session and a session on the free slot judge one decision a turn, each once', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup({ pool: [fakeAccount, fakeAccount2], opinion: overlapping(2) })
      const { r, sorted, opined, last } = yield* Effect.gen(function* () {
        const r = yield* review
        // Cached for the old RPCs, and kept to carry to later heads.
        return { r, sorted: yield* (yield* Sorter).cached(ref, 'HEAD1'), opined: yield* (yield* Opiner).cached(ref, 'HEAD1'), last: yield* (yield* Store).lastOpinion.get('h/o/r#7') }
      }).pipe(Effect.provide(layer))
      const ops = opinionTurns(agent.calls)
      assert.deepStrictEqual(ops.flatMap((o) => o.ids).sort(), ['h1', 'h2', 'l1', 'l2', 'l3'])
      for (const o of ops) assert.deepStrictEqual([o.ids.length, o.model], [1, modelFor(o.ids[0]!)])
      assert.deepStrictEqual([...new Set(ops.map((o) => o.session))].sort(), [1, 2])
      assert.strictEqual(agent.calls.find((c) => c.session === 2)?.account, 'fake2')
      // The sort session already has the diff; the other session's first turn gets it, with the whole context.
      const first = (session: number) => agent.calls.find((c) => c.session === session && c.log.kind === 'opinion')!
      assert.notMatch(first(1).prompt, /THE DIFF/)
      assert.match(first(2).prompt, /THE DIFF/)
      assert.match(first(2).prompt, /# PR #7/)
      assert.deepStrictEqual(r.opinion?.decisions.map((d) => d.decisionId), ['h1', 'l1', 'h2', 'l2', 'l3'])
      assert.isUndefined(r.opinionError)
      assert.deepStrictEqual(sorted?.decisions.map((d) => d.id), many.map((d) => d.id))
      assert.strictEqual(opined?.decisions.length, 5)
      assert.isTrue(Option.isSome(last))
    }))

  it.effect('sort turn uses main', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup({ pool: [{ ...fakeAccount, fastModel: 'quick-model' }] })
      yield* review.pipe(Effect.provide(layer))
      assert.deepInclude(agent.calls[0], { model: 'main', log: { ...agent.calls[0]!.log, kind: 'sort' } })
    }))

  it.effect('ticket fetch runs in parallel with the sort', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const sorted = yield* Deferred.make<void>()
      const { agent, layer } = setup({
        // Each waits on the other, so this only finishes when both run at once.
        sort: () => Effect.as(Effect.andThen(Deferred.await(started), Deferred.succeed(sorted, undefined)), sortOf(many)),
        ticket: Effect.as(Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(sorted)), { text: 'CORE-1: do it', note: 'read' }),
      })
      const r = yield* review.pipe(Effect.provide(layer))
      assert.strictEqual(r.opinion?.ticket, 'CORE-1: do it')
      assert.match(agent.calls[1]!.prompt, /CORE-1: do it/)
    }))

  it.effect('with one account the sort session judges every decision in sort order, later turns brief', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup()
      const r = yield* review.pipe(Effect.provide(layer))
      assert.deepStrictEqual(turns(agent.calls), ['1/fake/0/main/sort', '1/fake/1/main/opinion', '1/fake/2/fast/opinion', '1/fake/3/main/opinion', '1/fake/4/fast/opinion', '1/fake/5/fast/opinion'])
      assert.deepStrictEqual(opinionTurns(agent.calls).map((o) => [o.ids[0], o.brief]), [['h1', false], ['l1', true], ['h2', true], ['l2', true], ['l3', true]])
      // The sort above has the whole diff.
      assert.isTrue(agent.calls.slice(1).every((c) => !c.prompt.includes('THE DIFF')))
      assert.deepStrictEqual(r.opinion?.decisions.map((d) => d.decisionId), ['h1', 'l1', 'h2', 'l2', 'l3'])
    }))

  it.effect('decisions are judged while the sort is still writing them', () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>()
      const { agent, layer } = setup({
        pool: [fakeAccount, fakeAccount2],
        // Writes the first decision and starts the next, then only finishes once the first has been judged.
        sort: (call) => Effect.as(Effect.andThen(call.onDelta!(`{"summary": "s", "decisions": [${JSON.stringify(many[0])}, {"id": "l`), Deferred.await(first)), sortOf(many)),
        opinion: (call) => Effect.as(idsIn(call).includes('h1') ? Deferred.succeed(first, undefined) : Effect.void, opinionOn(call.prompt)),
      })
      const r = yield* review.pipe(Effect.provide(layer))
      assert.deepInclude(opinionTurns(agent.calls)[0], { ids: ['h1'], session: 2 })
      assert.deepStrictEqual(r.opinion?.decisions.map((d) => d.decisionId), ['h1', 'l1', 'h2', 'l2', 'l3'])
    }))

  it.effect('every free slot gets a session', () =>
    Effect.gen(function* () {
      const fakeAccount3 = { ...fakeAccount, id: 'fake3', name: 'Fake 3' }
      const { agent, layer } = setup({ pool: [fakeAccount, { ...fakeAccount2, concurrency: 2 }, fakeAccount3], opinion: overlapping(4) })
      const r = yield* review.pipe(Effect.provide(layer))
      const ops = opinionTurns(agent.calls)
      assert.strictEqual(new Set(agent.calls.map((c) => c.session)).size, 4)
      assert.deepStrictEqual(ops.flatMap((o) => o.ids).sort(), ['h1', 'h2', 'l1', 'l2', 'l3'])
      assert.deepStrictEqual(r.opinion?.decisions.map((d) => d.decisionId), ['h1', 'l1', 'h2', 'l2', 'l3'])
    }))

  it.effect('a cached sort runs only the opinion', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup({ decisions: few })
      yield* Effect.gen(function* () {
        yield* (yield* Sorter).sort(ref, 'HEAD1')
        agent.calls.length = 0
        const reviewer = yield* Reviewer
        yield* reviewer.prepare(ref, 'HEAD1')
        const phases = yield* reviewer.progress(ref, 'HEAD1').pipe(
          Stream.filter((ps) => ps.some((p) => p.id === 'opinion')),
          Stream.runHead,
        )
        assert.deepInclude(Option.getOrThrow(phases).find((p) => p.id === 'sort'), { label: 'Sorted earlier', state: 'done' })
        const r = yield* reviewer.result(ref, 'HEAD1')
        assert.strictEqual(r.opinion?.decisions.length, 2)
      }).pipe(Effect.provide(layer))
      assert.deepStrictEqual(turns(agent.calls), ['1/fake/0/main/opinion', '1/fake/1/fast/opinion'])
      // A fresh session: the first opinion turn brings the diff.
      assert.match(agent.calls[0]!.prompt, /THE DIFF/)
    }))

  it.effect('the worker shows which decision it is judging', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { layer } = setup({ opinion: (call) => (call.turn === 2 ? Effect.as(Deferred.await(gate), opinionOn(call.prompt)) : Effect.succeed(opinionOn(call.prompt))) })
      yield* Effect.gen(function* () {
        const reviewer = yield* Reviewer
        yield* reviewer.prepare(ref, 'HEAD1')
        const seen = yield* reviewer.progress(ref, 'HEAD1').pipe(
          Stream.map((ps) => ps.find((p) => p.id === 'opinion')),
          Stream.filter((p): p is Phase => p?.workers[0]?.current?.includes('2 of') === true),
          Stream.runHead,
        )
        const phase = Option.getOrThrow(seen)
        assert.strictEqual(phase.label, 'Judging 5 decisions')
        assert.deepInclude(phase.workers[0], { account: 'Fake', current: 'Judging 2 of 5: Decision l1' })
        yield* Deferred.succeed(gate, undefined)
        yield* reviewer.result(ref, 'HEAD1')
      }).pipe(Effect.provide(layer))
    }))

  it.effect('two prepares for one head share one run', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { agent, layer } = setup({ decisions: few, sort: () => Effect.as(Deferred.await(gate), sortOf(few)) })
      yield* Effect.gen(function* () {
        const reviewer = yield* Reviewer
        yield* reviewer.prepare(ref, 'HEAD1')
        yield* reviewer.prepare(ref, 'HEAD1')
        const label = yield* reviewer.progress(ref, 'HEAD1').pipe(
          Stream.map((ps) => ps.find((p) => p.id === 'sort')?.label),
          Stream.filter((l) => l !== undefined),
          Stream.runHead,
        )
        assert.strictEqual(Option.getOrThrow(label), 'Sorting 2 files')
        yield* Deferred.succeed(gate, undefined)
        yield* reviewer.result(ref, 'HEAD1')
      }).pipe(Effect.provide(layer))
      assert.strictEqual(agent.calls.filter((c) => c.log.kind === 'sort').length, 1)
      assert.strictEqual(new Set(agent.calls.map((c) => c.session)).size, 1)
    }))

  it.effect('a review joins the sort the stack page already started for the head', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      let sorts = 0
      // Each sort names its decisions apart, so two sorts would leave the opinion on ids the cached sort lacks.
      const { agent, layer } = setup({
        sort: () => {
          const n = ++sorts
          return Effect.andThen(Deferred.succeed(started, undefined), Effect.as(Deferred.await(gate), sortOf(many.map((d) => ({ ...d, id: `${d.id}x${n}` })))))
        },
      })
      const { r, cached } = yield* Effect.gen(function* () {
        const stack = yield* Effect.forkChild((yield* Sorter).sort(ref, 'HEAD1'))
        yield* Deferred.await(started)
        const reviewer = yield* Reviewer
        yield* reviewer.prepare(ref, 'HEAD1')
        const label = yield* reviewer.progress(ref, 'HEAD1').pipe(
          Stream.map((ps) => ps.find((p) => p.id === 'sort')?.label),
          Stream.filter((l) => l !== undefined),
          Stream.runHead,
        )
        assert.strictEqual(Option.getOrThrow(label), 'Sorting #7: joining the sort already running')
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(stack)
        return { r: yield* reviewer.result(ref, 'HEAD1'), cached: yield* (yield* Sorter).cached(ref, 'HEAD1') }
      }).pipe(Effect.provide(layer))
      assert.strictEqual(agent.calls.filter((c) => c.log.kind === 'sort').length, 1)
      const ids = r.sort.decisions.map((d) => d.id)
      assert.deepStrictEqual(cached?.decisions.map((d) => d.id), ids)
      assert.deepStrictEqual(r.opinion?.decisions.map((d) => d.decisionId), ids)
    }))

  it.effect('a benched account reruns the opinion on another, keeping the sort', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup({
        decisions: few,
        pool: [fakeAccount, fakeAccount2],
        opinion: (call) => (call.account === 'fake' ? Effect.fail(new AgentError({ message: "You've hit your usage limit" })) : Effect.succeed(opinionOn(call.prompt))),
      })
      const r = yield* review.pipe(Effect.provide(layer))
      assert.strictEqual(agent.calls.filter((c) => c.log.kind === 'sort').length, 1)
      assert.deepStrictEqual(r.opinion?.decisions.map((d) => d.decisionId), ['h1', 'l1'])
      assert.isUndefined(r.opinionError)
    }))

  it.effect('a decision whose turn failed in another session gets one more try', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup({
        pool: [fakeAccount, fakeAccount2],
        opinion: overlapping(2, (call) => (call.session === 2 ? Effect.fail(new AgentError({ message: 'Claude fell over' })) : Effect.succeed(opinionOn(call.prompt)))),
      })
      const r = yield* review.pipe(Effect.provide(layer))
      const failed = agent.calls.find((c) => c.session === 2 && c.log.kind === 'opinion')!
      const retry = agent.calls.at(-1)!
      assert.deepStrictEqual(idsIn(retry), idsIn(failed))
      assert.isAbove(retry.session!, 2)
      assert.isUndefined(r.opinionError)
      assert.deepStrictEqual(r.opinion?.decisions.map((d) => d.decisionId), ['h1', 'l1', 'h2', 'l2', 'l3'])
    }))

  it.live('a benched turn keeps what other sessions already answered', () =>
    Effect.gen(function* () {
      const fakeAccount3 = { ...fakeAccount, id: 'fake3', name: 'Fake 3' }
      const { agent, layer } = setup({
        pool: [fakeAccount, fakeAccount2, fakeAccount3],
        opinion: (call) =>
          call.account === 'fake' ? Effect.andThen(Effect.sleep('50 millis'), Effect.fail(new AgentError({ message: "You've hit your usage limit" }))) : Effect.succeed(opinionOn(call.prompt)),
      })
      const r = yield* review.pipe(Effect.provide(layer))
      const answeredBy = agent.calls.filter((c) => c.log.kind === 'opinion' && c.account !== 'fake').flatMap(idsIn)
      assert.deepStrictEqual([...new Set(answeredBy)].sort(), ['h1', 'h2', 'l1', 'l2', 'l3'])
      assert.isUndefined(r.opinionError)
      assert.deepStrictEqual(r.opinion?.decisions.map((d) => d.decisionId), ['h1', 'l1', 'h2', 'l2', 'l3'])
    }))

  it.effect('a Jira ticket is checked in a turn of its own, without holding up judging', () =>
    Effect.gen(function* () {
      const judgedOne = yield* Deferred.make<void>()
      const spec: AgentFinding = {
        severity: 'should',
        axis: 'spec',
        kind: 'spec',
        title: 'Missing export',
        take: 'The ticket asks for an export.',
        evidence: [{ ref: 'docs', path: 'ticket', line: 0, quote: 'export' }],
        alternative: null,
        comment: null,
        anchor: null,
        handledIn: null,
      }
      const { agent, layer } = setup({
        github: { getPr: () => Effect.succeed({ ...pr, title: 'CORE-1 Add a thing' }) },
        // The ticket only arrives once a decision has been judged.
        ticket: Effect.as(Deferred.await(judgedOne), { text: 'CORE-1: add an export', note: 'read' }),
        opinion: (call) =>
          call.prompt.includes('Only the Spec axis')
            ? Effect.succeed({ decisions: [{ decisionId: 'h2', authorCase: 'c', checked: null, findings: [spec] }] })
            : Effect.as(Deferred.succeed(judgedOne, undefined), opinionOn(call.prompt)),
      })
      const r = yield* review.pipe(Effect.provide(layer))
      const turnsOf = agent.calls.filter((c) => c.log.kind === 'opinion')
      const specTurns = turnsOf.filter((c) => c.prompt.includes('Only the Spec axis'))
      assert.strictEqual(specTurns.length, 1)
      assert.match(specTurns[0]!.prompt, /CORE-1: add an export/)
      assert.deepStrictEqual(idsIn(specTurns[0]!), ['h1', 'l1', 'h2', 'l2', 'l3'])
      // Decision turns are told to leave the Spec axis alone.
      assert.isTrue(turnsOf.filter((c) => !specTurns.includes(c) && !c.prompt.startsWith('Now these decisions')).every((c) => c.prompt.includes('skip the Spec axis')))
      assert.deepStrictEqual(
        r.opinion?.decisions.map((d) => [d.decisionId, d.findings.map((f) => f.title)]),
        [['h1', []], ['l1', []], ['h2', ['Missing export']], ['l2', []], ['l3', []]],
      )
      assert.strictEqual(r.opinion?.ticket, 'CORE-1: add an export')
    }))

  it.effect('the review shows from the sort on, and grows with each decision judged', () =>
    Effect.gen(function* () {
      const { layer } = setup()
      const seen = yield* Effect.gen(function* () {
        const reviewer = yield* Reviewer
        yield* reviewer.prepare(ref, 'HEAD1')
        const fiber = yield* Effect.forkChild(Stream.runCollect(reviewer.partial(ref, 'HEAD1').pipe(Stream.takeUntil((p) => p.opinion?.decisions.length === 5))))
        yield* reviewer.result(ref, 'HEAD1')
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(layer))
      const counts = seen.map((p) => p.opinion?.decisions.length ?? -1)
      assert.strictEqual(counts[0], -1)
      assert.deepStrictEqual(counts.slice(-5), [1, 2, 3, 4, 5])
      assert.deepStrictEqual(seen[0]!.sort.decisions.map((d) => d.id), many.map((d) => d.id))
    }))

  it.effect('the opinion phase shows "Reading the ticket" while the ticket holds it up', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { layer } = setup({ decisions: few, ticket: Effect.as(Deferred.await(gate), { text: 'CORE-1: do it', note: 'read' }) })
      yield* Effect.gen(function* () {
        yield* (yield* Sorter).sort(ref, 'HEAD1')
        const reviewer = yield* Reviewer
        yield* reviewer.prepare(ref, 'HEAD1')
        const phase = yield* reviewer.progress(ref, 'HEAD1').pipe(
          Stream.map((ps) => ps.find((p) => p.id === 'opinion')),
          Stream.filter((p): p is Phase => p?.workers[0]?.step !== undefined),
          Stream.runHead,
        )
        assert.deepInclude(Option.getOrThrow(phase), { label: 'Judging 2 decisions' })
        assert.deepInclude(Option.getOrThrow(phase).workers[0], { account: 'Fake', step: 'Reading the ticket' })
        yield* Deferred.succeed(gate, undefined)
        yield* reviewer.result(ref, 'HEAD1')
      }).pipe(Effect.provide(layer))
    }))

  it.effect('a cached sort with nothing to judge takes no account', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup({ decisions: [], stats: [stat('src/a.ts', 300)] })
      const r = yield* Effect.gen(function* () {
        yield* (yield* Sorter).sort(ref, 'HEAD1')
        return yield* review
      }).pipe(Effect.provide(layer))
      assert.strictEqual(agent.sessions(), 0)
      assert.strictEqual(r.opinionError, 'Nothing to judge')
    }))

  it.effect('opinion failure still returns the sort with opinionError', () =>
    Effect.gen(function* () {
      const { layer } = setup({ opinion: () => Effect.fail(new AgentError({ message: 'Claude fell over' })) })
      const r = yield* review.pipe(Effect.provide(layer))
      assert.strictEqual(r.sort.decisions.length, 5)
      assert.isNull(r.opinion)
      assert.strictEqual(r.opinionError, 'Claude fell over')
    }))

  it.effect('a failed sort fails the review and marks the phase failed', () =>
    Effect.gen(function* () {
      const { layer } = setup({ sort: () => Effect.fail(new AgentError({ message: 'no' })) })
      const e = yield* Effect.flip(review.pipe(Effect.provide(layer)))
      assert.strictEqual(e.message, 'no')
    }))

  describe('after a push', () => {
    const patch = (path: string, line: string, at = 1) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +${at} @@\n-old\n+${line}\n`
    /** h1 changes the same way at both heads, two lines lower at HEAD2; l1 changes differently, by an interdiff of `lines` lines. */
    const pushed = (lines: number) => (from: string, to: string, paths: ReadonlyArray<string>) => {
      if (from === 'HEAD1' && to === 'HEAD2') return `diff --git a/src/l1.ts b/src/l1.ts\n--- a/src/l1.ts\n+++ b/src/l1.ts\n@@ -0,0 +1,${lines} @@\n${'+x\n'.repeat(lines)}`
      if (from !== 'MB1') return 'THE DIFF'
      if (paths.length > 2) return 'THE DIFF'
      const at2 = to === 'HEAD2'
      return [...(paths.includes('src/h1.ts') ? [patch('src/h1.ts', 'one', at2 ? 3 : 1)] : []), ...(paths.includes('src/l1.ts') ? [patch('src/l1.ts', at2 ? 'two' : 'one')] : [])].join('')
    }
    const atLine = (d: Decision): Decision => ({ ...d, files: d.files.map((f) => ({ ...f, ranges: [{ start: 1, end: 1 }] })) })
    const finding = { severity: 'should', axis: 'standards', kind: 'design', title: 'T', take: 'x', evidence: [], alternative: null, comment: null, anchor: null, handledIn: null } as const
    // At HEAD2 the agent returns only what changed; h1 is kept by the sort itself.
    const sort = (call: AgentCall) => Effect.succeed(sortOf(call.prompt.includes('# Kept decisions') ? [atLine(few[1]!)] : few.map(atLine)))
    const opinion = (call: AgentCall) => Effect.succeed({ decisions: opinionOn(call.prompt).decisions.map((d) => (d.decisionId === 'h1' ? { ...d, findings: [finding] } : d)) })
    const twice = Effect.gen(function* () {
      const reviewer = yield* Reviewer
      const store = yield* Store
      const first = yield* reviewer.result(ref, 'HEAD1')
      const id = first.opinion!.decisions.find((d) => d.decisionId === 'h1')!.findings[0]!.id
      yield* Effect.orDie(store.findings.set('h/o/r#7@HEAD1', { [id]: 'posted' }))
      return { r: yield* reviewer.result(ref, 'HEAD2'), id, states: yield* Effect.orDie(store.findings.get('h/o/r#7@HEAD2')) }
    })

    it.effect('a small push sorts from the previous sort and judges only decisions whose change differs', () =>
      Effect.gen(function* () {
        const { agent, layer } = setup({ decisions: few, diff: pushed(3), sort, opinion })
        const { r, id, states } = yield* twice.pipe(Effect.provide(layer))
        const second = agent.calls.filter((c) => c.log.headSha === 'HEAD2')
        const prompt = second.find((c) => c.log.kind === 'sort')!.prompt
        assert.include(prompt, '# Previous sort (head HEAD1)')
        assert.include(prompt, '# Kept decisions\nTheir files change as they did at HEAD1, so they stay as they are and are not yours to return:\nh1: Decision h1 (src/h1.ts)')
        assert.match(prompt, /# Decisions to revise\n\[\{"id":"l1"/)
        assert.match(prompt, /# Changed since then\n.*\nsrc\/l1\.ts\n/)
        assert.notInclude(prompt, 'THE DIFF')
        // h1 is in the sort though the agent left it out, at the lines its change moved to.
        assert.deepStrictEqual(r.sort.decisions.find((d) => d.id === 'h1')?.files[0]?.ranges, [{ start: 3, end: 3 }])
        assert.deepStrictEqual(opinionTurns(second).flatMap((c) => c.ids), ['l1'])
        const byId = new Map(r.opinion!.decisions.map((d) => [d.decisionId, d]))
        assert.strictEqual(byId.get('h1')?.carriedFrom, 'HEAD1')
        assert.strictEqual(byId.get('h1')?.authorCase, 'case h1')
        assert.isUndefined(byId.get('l1')?.carriedFrom)
        // Its finding keeps its id, and with it what the reviewer did with it.
        assert.strictEqual(byId.get('h1')?.findings[0]?.id, id)
        assert.deepStrictEqual(Option.getOrUndefined(states), { [id]: 'posted' })
      }))

    it.effect('a kept decision whose opinion fails to carry is judged again', () =>
      Effect.gen(function* () {
        let failed = false
        const diff = pushed(3)
        const { agent, layer } = setup({
          decisions: few,
          sort,
          opinion,
          // Anchoring h1's carried findings at HEAD2 fails once.
          diff: (from, to, paths) => (to === 'HEAD2' && from === 'MB1' && paths.join() === 'src/h1.ts' && !failed ? ((failed = true), new GitError({ message: 'gone' })) : diff(from, to, paths)),
        })
        const { r } = yield* twice.pipe(Effect.provide(layer))
        assert.isTrue(failed)
        assert.sameMembers(opinionTurns(agent.calls.filter((c) => c.log.headSha === 'HEAD2')).flatMap((c) => c.ids), ['h1', 'l1'])
        assert.isUndefined(r.opinion!.decisions.find((d) => d.decisionId === 'h1')?.carriedFrom)
      }))

    it.effect('a push of 400 lines or more sorts and judges from scratch', () =>
      Effect.gen(function* () {
        const { agent, layer } = setup({ decisions: few, diff: pushed(400), opinion })
        const { r } = yield* twice.pipe(Effect.provide(layer))
        const second = agent.calls.filter((c) => c.log.headSha === 'HEAD2')
        assert.notInclude(second.find((c) => c.log.kind === 'sort')!.prompt, '# Previous sort')
        assert.sameMembers(opinionTurns(second).flatMap((c) => c.ids), ['h1', 'l1'])
        assert.isTrue(r.opinion!.decisions.every((d) => d.carriedFrom === undefined))
      }))
  })

  it.live('stop interrupts the running review and marks the PR', () =>
    Effect.gen(function* () {
      let interrupted = false
      const { agent, layer } = setup({ sort: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))) })
      yield* Effect.gen(function* () {
        const reviewer = yield* Reviewer
        yield* reviewer.prepare(ref, 'HEAD1')
        while (agent.calls.length === 0) yield* Effect.sleep('5 millis')
        yield* reviewer.stop(ref)
        assert.isTrue(interrupted)
        assert.isTrue(Option.isNone(yield* Stream.runHead(reviewer.progress(ref, 'HEAD1'))))
        assert.isTrue(yield* reviewer.isStopped(ref))
      }).pipe(Effect.provide(layer))
    }))

  it.live('a stopped PR is not prepared, and resume lets it run', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup()
      yield* Effect.gen(function* () {
        const reviewer = yield* Reviewer
        yield* reviewer.stop(ref)
        yield* reviewer.stop(ref)
        yield* reviewer.prepare(ref, 'HEAD1')
        yield* Effect.sleep('20 millis')
        assert.strictEqual(agent.calls.length, 0)
        yield* reviewer.resume(ref)
        assert.isFalse(yield* reviewer.isStopped(ref))
        yield* reviewer.result(ref, 'HEAD1')
        assert.isAbove(agent.calls.length, 0)
      }).pipe(Effect.provide(layer))
    }))
})
