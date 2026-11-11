import { assert, describe, it } from '@effect/vitest'
import { type AgentFinding, type AgentStackOpinion, defaultSettings, type Decision, type PrOpinion, type SortResult, type StackEntry } from '@pr-review/domain'
import { Effect, Layer, Stream } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { Config } from '../src/Config.ts'
import { Opiner } from '../src/Opiner.ts'
import { Overview } from '../src/Overview.ts'
import { Sorter } from '../src/Sorter.ts'
import { StackOpiner } from '../src/StackOpiner.ts'
import { Store } from '../src/Store.ts'
import { Tickets } from '../src/Tickets.ts'
import { contentIds } from '../src/opinionContext.ts'
import { fakeAgent, fakeGit, fakeGitHub, overviewReply, ref } from './fakes.ts'

const entry = (number: number, baseRef: string, headRef: string, headSha = `sha${number}`): StackEntry => ({ number, title: `PR ${number}`, baseRef, headRef, headSha })
const stack = [entry(6, 'master', 'f6'), entry(7, 'f6', 'f7'), entry(8, 'f7', 'f8')]

const decision = (id: string): Decision => ({ id, title: `Decision ${id}`, lens: 'architecture', reason: 'shared-layer', theme: 't', note: 'n', existing: null, authorWhy: null, files: [{ path: 'src/a.ts', ranges: [{ start: 1, end: 2 }] }] })
const sortOf = (id: string, summary: string): SortResult => ({
  headSha: 'HEAD1',
  mergeBase: 'MB1',
  summary,
  decisions: [decision(id)],
  skim: [],
  trusted: [],
  claims: [],
  unclaimedDecisionIds: [],
  lines: { decision: 0, skim: 0, trusted: 0 },
})
// 6 and 7 are sorted, 8 is not.
const sorts: Record<number, SortResult> = { 6: sortOf('model', 'Adds the model.'), 7: sortOf('api', 'Adds the API.') }

/** Any sort or PR opinion would be a paid run per PR and fails the test. */
const fakeSorter = Layer.succeed(Sorter, Sorter.of({ sort: (r) => Effect.die(`sorted #${r.number}`), cached: (r) => Effect.succeed(sorts[r.number]), steps: () => Stream.never, prepare: () => Effect.die('prepared'), claim: () => Effect.die('claimed'), remember: () => Effect.void }))

const prOpinion = (title: string): PrOpinion => ({
  headSha: 'sha6',
  ticket: null,
  ticketNote: 'n',
  stackHeads: {},
  decisions: [{ decisionId: 'model', authorCase: 'c', checked: null, deep: false, findings: [{ ...finding(), id: 'model:0', pr: 6, decisionId: 'model', verified: true, title }] }],
})
const fakeOpiner = Layer.succeed(
  Opiner,
  Opiner.of({
    cached: (r, headSha) => Effect.succeed(r.number === 6 && headSha === 'sha6' ? prOpinion('Model in the wrong layer') : undefined),
    opine: (r) => Effect.die(`opinion on #${r.number}`),
    deeper: () => Effect.die('deeper'),
    steps: () => Stream.never,
    context: () => Effect.die('context'),
    remember: () => Effect.void,
  }),
)

function finding(o: Partial<AgentFinding> = {}): AgentFinding {
  return {
    severity: 'should',
    axis: 'standards',
    kind: 'design',
    title: 'f',
    take: 't',
    evidence: [{ ref: 'docs', path: 'react', line: 0, quote: 'effects' }],
    alternative: null,
    comment: null,
    anchor: { path: 'src/a.ts', line: 4 },
    handledIn: null,
    ...o,
  }
}

const setup = (o: { reply?: AgentStackOpinion; prs?: () => StackEntry[]; show?: Record<string, string> } = {}) => {
  const agent = fakeAgent((call) => Effect.succeed(call.log.kind === 'overview' ? overviewReply : (o.reply ?? { findings: [] })))
  const git = fakeGit({ files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }], diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n+x', rules: ['AGENTS.md'], show: o.show ?? {} })
  const config = Config.layerTest({ cacheRoot: '/cache', settings: { ...defaultSettings, hosts: [ref.host], repos: { 'h/o/r': { related: [{ repo: 'h/o/svc', note: 'permissions' }] } } } })
  const layer = Layer.mergeAll(StackOpiner.layer, Overview.layer).pipe(
    Layer.provide([
      agent.layer,
      git.layer,
      fakeGitHub({ listOpenPrs: () => Effect.sync(() => (o.prs ? o.prs() : stack)) }),
      config,
      fakeSorter,
      fakeOpiner,
      Layer.succeed(Tickets, Tickets.of({ summary: (r) => Effect.succeed({ text: `ticket of #${r.number}`, note: 'Fetched' }) })),
    ]),
    Layer.provide(Store.layerWith(KeyValueStore.layerMemory)),
  )
  const opine = Effect.gen(function* () {
    return yield* (yield* StackOpiner).opine(ref)
  })
  return { agent, git, layer, opine }
}

const stackCalls = <C extends { log: { kind: string } }>(calls: ReadonlyArray<C>) => calls.filter((c) => c.log.kind === 'stack-opinion')

describe('StackOpiner', () => {
  it.effect('runs one agent call for the whole stack and never sorts', () =>
    Effect.gen(function* () {
      const { agent, layer, opine } = setup()
      yield* Effect.gen(function* () {
        const entries = [6, 7].map((n) => ({ number: n, headSha: `sha${n}`, sort: sorts[n]!, files: [] }))
        yield* (yield* Overview).make(ref, entries)
        yield* opine
      }).pipe(Effect.provide(layer))
      const calls = stackCalls(agent.calls)
      assert.strictEqual(calls.length, 1)
      const p = calls[0]!.prompt
      assert.match(p, /untrusted input/)
      const order = ['# Refs', '# Review guidance', '# Related repos', '# Ticket', '# Stack overview', '# PRs', '# Existing PR opinions'].map((s) => p.indexOf(s))
      assert.deepStrictEqual(order, [...order].sort((a, b) => a - b))
      assert.notInclude(order, -1)
      assert.match(p, /Default branch: origin\/master\n#6 head sha6, merge base MB1\n#7 head sha7, merge base MB1\n#8 head sha8, merge base MB1/)
      assert.match(p, /h\/o\/svc: permissions/)
      assert.match(p, /ticket of #8/)
      assert.match(p, /# Stack overview[^\n]*\ns\n/)
      assert.match(p, /#6 PR 6 \(head sha6\)\nAdds the model\.\n- \[architecture\/shared-layer\] Decision model/)
      assert.match(p, /#7 PR 7 \(head sha7\)\nAdds the API\./)
      assert.match(p, /# Existing PR opinions[^\n]*\n#6\n- \[should\] Model in the wrong layer/)
      assert.deepStrictEqual(calls[0]!.related, ['h/o/svc'])
    }))

  it.effect('prompt lists unsorted PRs by title and paths', () =>
    Effect.gen(function* () {
      const { agent, layer, opine } = setup()
      yield* opine.pipe(Effect.provide(layer))
      const p = stackCalls(agent.calls)[0]!.prompt
      assert.match(p, /#8 PR 8 \(head sha8\)\n {2}src\/a\.ts/)
      assert.match(p, /# Stack overview\n\(none\)/)
    }))

  it.effect('drops findings for PRs outside the stack', () =>
    Effect.gen(function* () {
      const reply: AgentStackOpinion = {
        findings: [
          { ...finding({ title: 'gone', handledIn: 8 }), pr: 99 },
          { ...finding({ title: 'drift', handledIn: 6, evidence: [{ ref: 'head', path: 'src/a.ts', line: 1, quote: 'const x', pr: 8 }] }), pr: 7 },
          { ...finding({ title: 'scaffold', handledIn: 8, anchor: { path: 'src/nowhere.ts', line: 1 }, evidence: [{ ref: 'head', path: 'src/a.ts', line: 1, quote: 'const x' }] }), pr: 6 },
        ],
      }
      const { layer, opine } = setup({ reply, show: { 'sha8:src/a.ts': 'const x = 1\n' } })
      const o = yield* opine.pipe(Effect.provide(layer))
      assert.deepStrictEqual(o.heads, { 6: 'sha6', 7: 'sha7', 8: 'sha8' })
      assert.deepStrictEqual(o.findings.map((f) => [f.title, f.pr, f.decisionId]), [['drift', 7, null], ['scaffold', 6, null]])
      assert.deepStrictEqual(o.findings.map((f) => f.id), contentIds('stack:', ['7\ndrift\nt', '6\nscaffold\nt']))
      const [drift, scaffold] = o.findings
      // Evidence is read at the head of the PR it names, else the finding's PR.
      assert.deepStrictEqual([drift!.verified, scaffold!.verified], [true, false])
      assert.deepStrictEqual([drift!.handledIn, scaffold!.handledIn], [null, 8])
      // Moved onto the diff's last line; a file outside the PR has none.
      assert.deepStrictEqual([drift!.anchor, scaffold!.anchor], [{ path: 'src/a.ts', line: 3 }, null])
    }))

  it.effect('cached per set of heads', () =>
    Effect.gen(function* () {
      let top = 'sha8'
      const { agent, layer, opine } = setup({ prs: () => [...stack.slice(0, 2), entry(8, 'f7', 'f8', top)] })
      yield* Effect.gen(function* () {
        const s = yield* StackOpiner
        assert.isUndefined(yield* s.cached(ref))
        const first = yield* opine
        assert.deepStrictEqual(yield* opine, first)
        assert.deepStrictEqual(yield* s.cached(ref), first)
        top = 'sha8-new'
        assert.isUndefined(yield* s.cached(ref))
        assert.strictEqual((yield* opine).heads[8], 'sha8-new')
      }).pipe(Effect.provide(layer))
      assert.strictEqual(stackCalls(agent.calls).length, 2)
    }))
})
