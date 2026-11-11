import { assert, describe, it } from '@effect/vitest'
import { type AgentAccount, AgentError, type AgentQuick, type FileStat, type AgentOpinion, type AgentSort, type Decision, type Phase } from '@pr-review/domain'
import { Deferred, Effect, Fiber, Layer, Option, Stream } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { Opiner } from '../src/Opiner.ts'
import { Reviewer } from '../src/Reviewer.ts'
import { Sorter } from '../src/Sorter.ts'
import { Store } from '../src/Store.ts'
import { type TicketSummary, Tickets } from '../src/Tickets.ts'
import { type AgentCall, configLayer, fakeAccount, fakeAccount2, fakeAgent, fakeGit, fakeGitHub, ref } from './fakes.ts'

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
  } = {},
) => {
  const agent = fakeAgent(
    (call) => (call.log.kind === 'opinion' ? (o.opinion?.(call) ?? Effect.succeed(opinionOn(call.prompt))) : (o.sort?.(call) ?? Effect.succeed(sortOf(o.decisions ?? many)))),
    undefined,
    o.pool,
  )
  const files = o.stats ?? (o.decisions ?? many).map((d) => ({ path: d.files[0]!.path, additions: 100, deletions: 1 }))
  const deps = Layer.mergeAll(agent.layer, fakeGit({ files, diff: 'THE DIFF' }).layer, fakeGitHub(), configLayer(), Layer.succeed(Tickets, Tickets.of({ summary: () => o.ticket ?? Effect.succeed({ text: null, note: 'none' }) })))
  const layer = Reviewer.layer.pipe(Layer.provideMerge(Opiner.layer), Layer.provideMerge(Sorter.layer), Layer.provideMerge(Store.layerWith(KeyValueStore.layerMemory)), Layer.provideMerge(deps))
  return { agent, layer }
}

const review = Effect.gen(function* () {
  return yield* (yield* Reviewer).result(ref, 'HEAD1')
})
const turns = (calls: ReadonlyArray<AgentCall>) => calls.map((c) => `${c.session}/${c.account}/${c.turn}/${c.model}/${c.log.kind}`)

const stat = (path: string, additions: number, deletions = 0): FileStat => ({ path, additions, deletions })
const quickAnswer = (call: AgentCall): AgentQuick => ({ summary: 'Adds a thing.', authorCase: `case for ${call.log.number}`, checked: 'looked', findings: [] })
const quickSetup = (stats: FileStat[]) => setup({ stats, sort: (call) => (call.prompt.includes('This PR is small') ? Effect.succeed(quickAnswer(call)) : Effect.succeed(sortOf(few))) })

describe('Reviewer', () => {
  it.effect('a 120-line PR takes the quick path in one turn', () =>
    Effect.gen(function* () {
      const { agent, layer } = quickSetup([stat('src/a.ts', 100, 5), stat('src/b.ts', 15)])
      const r = yield* review.pipe(Effect.provide(layer))
      assert.deepStrictEqual(turns(agent.calls), ['1/fake/0/main/sort'])
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

  it.effect('sort and high-impact opinion run in one session, low-impact on an idle second account', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup({ pool: [fakeAccount, fakeAccount2] })
      const { r, sorted, opined, last } = yield* Effect.gen(function* () {
        const r = yield* review
        // Cached for the old RPCs, and kept to carry to later heads.
        return { r, sorted: yield* (yield* Sorter).cached(ref, 'HEAD1'), opined: yield* (yield* Opiner).cached(ref, 'HEAD1'), last: yield* (yield* Store).lastOpinion.get('h/o/r#7') }
      }).pipe(Effect.provide(layer))
      assert.deepStrictEqual(turns(agent.calls), ['1/fake/0/main/sort', '1/fake/1/main/opinion', '2/fake2/0/fast/opinion'])
      assert.deepStrictEqual(idsIn(agent.calls[1]!), ['h1', 'h2'])
      assert.deepStrictEqual(idsIn(agent.calls[2]!), ['l1', 'l2', 'l3'])
      // The second turn has the diff from the sort; the fresh session gets its own.
      assert.notMatch(agent.calls[1]!.prompt, /THE DIFF/)
      assert.match(agent.calls[2]!.prompt, /THE DIFF/)
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

  it.effect('with one account all turns share the session, low after high', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup()
      const r = yield* review.pipe(Effect.provide(layer))
      assert.deepStrictEqual(turns(agent.calls), ['1/fake/0/main/sort', '1/fake/1/main/opinion', '1/fake/2/fast/opinion'])
      assert.deepStrictEqual(idsIn(agent.calls[1]!), ['h1', 'h2'])
      assert.deepStrictEqual(idsIn(agent.calls[2]!), ['l1', 'l2', 'l3'])
      assert.deepStrictEqual(r.opinion?.decisions.map((d) => d.decisionId), ['h1', 'l1', 'h2', 'l2', 'l3'])
    }))

  it.effect('4 decisions or fewer stay in one session even with an idle account', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup({ decisions: few, pool: [fakeAccount, fakeAccount2] })
      yield* review.pipe(Effect.provide(layer))
      assert.deepStrictEqual(turns(agent.calls), ['1/fake/0/main/sort', '1/fake/1/main/opinion', '1/fake/2/fast/opinion'])
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

  it.effect('Judging lines become "Judging i of k: title"', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { layer } = setup({
        opinion: (call) =>
          call.turn === 1 ? Effect.andThen(call.onText!('**Judging:** `h2`'), Effect.as(Deferred.await(gate), opinionOn(call.prompt))) : Effect.succeed(opinionOn(call.prompt)),
      })
      yield* Effect.gen(function* () {
        const reviewer = yield* Reviewer
        yield* reviewer.prepare(ref, 'HEAD1')
        const seen = yield* reviewer.progress(ref, 'HEAD1').pipe(
          Stream.map((ps) => ps.find((p) => p.id === 'opinion')),
          Stream.filter((p): p is Phase => p?.workers[0]?.current !== undefined),
          Stream.runHead,
        )
        const phase = Option.getOrThrow(seen)
        assert.strictEqual(phase.label, 'Judging 5 decisions')
        assert.deepInclude(phase.workers[0], { account: 'Fake', current: 'Judging 2 of 5: Decision h2', step: 'Searching for "x"' })
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
})
