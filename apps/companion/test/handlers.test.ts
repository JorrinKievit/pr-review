import { assert, describe, it } from '@effect/vitest'
import { AgentError, type AgentOpinion, type AgentSort, type Decision, type FileStat, ReviewRejected, ReviewRpcs, RepoNotConfigured, type StackEntry } from '@pr-review/domain'
import { NodeServices } from '@effect/platform-node'
import { Effect, Fiber, Layer, Logger, Stream } from 'effect'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KeyValueStore } from 'effect/persistence'
import { RpcTest } from 'effect/rpc'
import { Asker } from '../src/Asker.ts'
import { Config } from '../src/Config.ts'
import { Git } from '../src/Git.ts'
import { CompanionRpcs, HandlersLive, LoggedLive } from '../src/handlers.ts'
import { Opiner } from '../src/Opiner.ts'
import { Overview } from '../src/Overview.ts'
import { Sorter } from '../src/Sorter.ts'
import { Store } from '../src/Store.ts'
import { Tickets } from '../src/Tickets.ts'
import { configLayer, fakeAgent, fakeGit, fakeGitHub, overviewReply, pr, ref } from './fakes.ts'
import { git, makeRemote, tmp } from './helpers.ts'
import { TestClock } from 'effect/testing'

const entry = (number: number, baseRef: string, headRef: string): StackEntry => ({ number, title: `#${number}`, baseRef, headRef, headSha: `sha${number}` })
const files = [{ path: 'src/a.ts', additions: 3, deletions: 1 }]
const sortReply = { decisions: [], skim: [], claims: [] }
const d1: Decision = { id: 'd1', title: 'd1', lens: 'architecture', reason: 'data-model', theme: 't', note: 'n', existing: null, authorWhy: null, files: [{ path: 'src/a.ts', ranges: [] }] }
const opinionReply: AgentOpinion = {
  decisions: [
    {
      decisionId: 'd1',
      authorCase: 'c',
      checked: null,
      findings: [
        {
          severity: 'should',
          axis: 'standards',
          kind: 'design',
          title: 'f',
          take: 't',
          evidence: [{ ref: 'docs', path: 'react', line: 0, quote: 'effects' }],
          alternative: null,
          comment: null,
          anchor: null,
          handledIn: null,
        },
      ],
    },
  ],
}
const opinionCalls = (calls: ReadonlyArray<{ log: { kind: string } }>) => calls.filter((c) => c.log.kind === 'opinion').length

const setup = (
  o: { delay?: number; overviewFails?: string; github?: Parameters<typeof fakeGitHub>[0]; sorts?: ReadonlyArray<AgentSort>; files?: FileStat[]; diff?: NonNullable<Parameters<typeof fakeGit>[0]>['diff']; git?: ReturnType<typeof fakeGit> } = {},
) => {
  let sorted = 0
  const agent = fakeAgent((call) =>
    call.log.kind === 'overview' && o.overviewFails
      ? Effect.fail(new AgentError({ message: o.overviewFails }))
      : Effect.as(
          o.delay ? Effect.sleep(o.delay) : Effect.void,
          call.log.kind === 'overview' ? overviewReply : call.log.kind === 'opinion' ? opinionReply : (o.sorts?.[sorted++] ?? sortReply),
        ),
  )
  const deps = Layer.mergeAll(agent.layer, (o.git ?? fakeGit({ files: o.files ?? files, diff: o.diff ?? 'd' })).layer, fakeGitHub({ listOpenPrs: () => Effect.succeed([entry(7, 'master', 'feat')]), ...o.github }), configLayer())
  const store = Store.layerWith(KeyValueStore.layerMemory)
  const services = Layer.mergeAll(Opiner.layer, Asker.layer, Overview.layer).pipe(Layer.provideMerge(Layer.mergeAll(Sorter.layer, Tickets.layer)), Layer.provideMerge(store), Layer.provideMerge(deps))
  const layer = HandlersLive.pipe(Layer.provide(services))
  // Built in the test's scope, like the companion's process scope: the handlers outlive each client call.
  const client = Effect.flatMap(Layer.build(Layer.merge(layer, LoggedLive)), (ctx) => RpcTest.makeClient(CompanionRpcs).pipe(Effect.provideContext(ctx)))
  return { agent, client }
}

const tags = <A extends { _tag: string }>(xs: ReadonlyArray<A>) => xs.map((x) => x._tag)

describe('handlers', () => {
  it.effect('GetPr carries files and stack but no diff', () =>
    Effect.gen(function* () {
      const c = yield* setup().client
      const view = yield* c.GetPr({ ref })
      assert.deepStrictEqual(view.files, files)
      assert.deepStrictEqual(view.stack.map((s) => s.number), [7])
      assert.strictEqual(view.mergeBase, 'MB1')
      assert.strictEqual(view.defaultBranch, 'master')
      assert.strictEqual(view.viewer, 'me')
      assert.notProperty(view, 'diff')
    }).pipe(Effect.scoped))

  it.effect('a failed call is logged with its name and PR', () =>
    Effect.gen(function* () {
      const lines: string[] = []
      const capture = Logger.layer([Logger.make(({ message }) => void lines.push((Array.isArray(message) ? message : [message]).join(' ')))])
      yield* Effect.gen(function* () {
        const c = yield* setup().client
        yield* Effect.flip(c.GetPr({ ref: { ...ref, host: 'nope.example' } }))
      }).pipe(Effect.provide(capture))
      assert.isTrue(lines.some((l) => l.includes('GetPr #7 failed') && l.includes('nope.example')), lines.join('\n'))
    }).pipe(Effect.scoped))

  it.effect('GetDescription returns the rendered body', () =>
    Effect.gen(function* () {
      const c = yield* setup({ github: { description: () => Effect.succeed('<p>Shows the list.</p>') } }).client
      assert.strictEqual(yield* c.GetDescription({ ref }), '<p>Shows the list.</p>')
    }).pipe(Effect.scoped))

  it.effect('GetFilePatch for a moved file asks git for both paths', () =>
    Effect.gen(function* () {
      const git = fakeGit({ diff: 'rename from a' })
      const c = yield* setup({ git }).client
      yield* c.GetFilePatch({ ref, mergeBase: 'MB1', headSha: 'HEAD1', path: 'src/b.ts', previous: 'src/a.ts' })
      assert.deepStrictEqual(git.diffPaths.at(-1), ['src/a.ts', 'src/b.ts'])
    }).pipe(Effect.scoped))

  it.effect('a repo on a host missing from the settings fails RepoNotConfigured', () =>
    Effect.gen(function* () {
      const c = yield* setup().client
      assert.instanceOf(yield* Effect.flip(c.GetPr({ ref: { ...ref, host: 'nope.example' } })), RepoNotConfigured)
    }).pipe(Effect.scoped))

  it.live('Sort streams Running then Done', () =>
    Effect.gen(function* () {
      const c = yield* setup({ delay: 200 }).client
      const t = tags(yield* Stream.runCollect(c.Sort({ ref, headSha: 'HEAD1' })))
      assert.deepStrictEqual([...new Set(t)], ['Running', 'Done'])
      assert.strictEqual(t.at(-1), 'Done')
    }).pipe(Effect.scoped))

  it.live('Sort on a cached head emits Done only', () =>
    Effect.gen(function* () {
      const c = yield* setup({ delay: 200 }).client
      yield* Stream.runCollect(c.Sort({ ref, headSha: 'HEAD1' }))
      assert.deepStrictEqual(tags(yield* Stream.runCollect(c.Sort({ ref, headSha: 'HEAD1' }))), ['Done'])
    }).pipe(Effect.scoped))

  it.live('two Sort calls for one head run one agent', () =>
    Effect.gen(function* () {
      const { agent, client } = setup({ delay: 100 })
      const c = yield* client
      yield* Effect.all([Stream.runCollect(c.Sort({ ref, headSha: 'HEAD1' })), Stream.runCollect(c.Sort({ ref, headSha: 'HEAD1' }))], { concurrency: 2 })
      assert.strictEqual(agent.calls.length, 1)
    }).pipe(Effect.scoped))

  it.live('Stack sorts bottom first and ends with the overview', () =>
    Effect.gen(function* () {
      const { agent, client } = setup({ github: { listOpenPrs: () => Effect.succeed([entry(8, 'feat', 'feat2'), entry(7, 'master', 'feat')]) } })
      const c = yield* client
      const events = yield* Stream.runCollect(c.Stack({ ref: { ...ref, number: 8 } }))
      assert.deepStrictEqual(agent.calls.map((x) => x.log.kind), ['sort', 'sort', 'overview'])
      assert.deepStrictEqual(agent.calls.slice(0, 2).map((x) => x.log.number), [7, 8])
      assert.deepStrictEqual(events[0]!.entries.map((e) => e.status), ['queued', 'queued'])
      const last = events.at(-1)!
      assert.deepStrictEqual(last.entries.map((e) => [e.pr.number, e.status]), [[7, 'done'], [8, 'done']])
      assert.deepStrictEqual(last.overview, overviewReply)
    }).pipe(Effect.scoped))

  it.live('Stack ends with why the overview failed, so the page stops waiting for it', () =>
    Effect.gen(function* () {
      const c = yield* setup({ overviewFails: 'Claude took longer than 10 minutes' }).client
      const last = (yield* Stream.runCollect(c.Stack({ ref }))).at(-1)!
      assert.deepStrictEqual(last.entries.map((e) => e.status), ['done'])
      assert.strictEqual(last.overview, null)
      assert.strictEqual(last.overviewError, 'Claude took longer than 10 minutes')
    }).pipe(Effect.scoped))

  it.live('Stack entries carry the saved verdicts of each PR', () =>
    Effect.gen(function* () {
      const { client } = setup({ github: { listOpenPrs: () => Effect.succeed([entry(8, 'feat', 'feat2'), entry(7, 'master', 'feat')]) } })
      const c = yield* client
      yield* c.SetState({ ref, headSha: 'sha7', decisionId: 'd1', state: 'accepted' })
      const last = (yield* Stream.runCollect(c.Stack({ ref: { ...ref, number: 8 } }))).at(-1)!
      assert.deepStrictEqual(last.entries.map((e) => [e.pr.number, e.state]), [[7, { d1: 'accepted' }], [8, {}]])
    }).pipe(Effect.scoped))

  it.effect('drafts are kept per PR and sent with the review, then cleared', () =>
    Effect.gen(function* () {
      const sent: unknown[] = []
      const c = yield* setup({ github: { submitReview: (_o, _r, _n, r) => Effect.sync(() => void sent.push(r)) } }).client
      const draft = { id: 'd1', path: 'src/a.ts', line: 2, side: 'RIGHT' as const, body: 'Use the helper' }
      yield* c.SetDrafts({ ref, drafts: [draft] })
      assert.deepStrictEqual(yield* c.GetDrafts({ ref }), [draft])
      assert.deepStrictEqual(yield* c.GetDrafts({ ref: { ...ref, number: 8 } }), [])
      yield* c.SubmitReview({ ref, event: 'REQUEST_CHANGES', body: 'b', commitId: 'HEAD1' })
      assert.deepStrictEqual(sent, [{ event: 'REQUEST_CHANGES', body: 'b', commitId: 'HEAD1', comments: [draft] }])
      assert.deepStrictEqual(yield* c.GetDrafts({ ref }), [])
    }).pipe(Effect.scoped))

  it.effect('remembers where a review left off, by key', () =>
    Effect.gen(function* () {
      const c = yield* setup().client
      assert.isNull(yield* c.Recall({ key: 'at:h/o/r#7' }))
      yield* c.Remember({ key: 'at:h/o/r#7', value: '"d:two"' })
      assert.strictEqual(yield* c.Recall({ key: 'at:h/o/r#7' }), '"d:two"')
    }).pipe(Effect.scoped))

  it.effect('a refused review keeps the drafts', () =>
    Effect.gen(function* () {
      const c = yield* setup({ github: { submitReview: () => Effect.fail(new ReviewRejected({ message: 'Validation Failed' })) } }).client
      const draft = { id: 'd1', path: 'src/a.ts', line: 2, side: 'RIGHT' as const, body: 'keep me' }
      yield* c.SetDrafts({ ref, drafts: [draft] })
      assert.instanceOf(yield* Effect.flip(c.SubmitReview({ ref, event: 'COMMENT', body: '', commitId: 'HEAD1' })), ReviewRejected)
      assert.deepStrictEqual(yield* c.GetDrafts({ ref }), [draft])
    }).pipe(Effect.scoped))

  it.effect('Ask follow-up resumes the stored session', () =>
    Effect.gen(function* () {
      const { agent, client } = setup()
      const c = yield* client
      const target = { _tag: 'Lines' as const, path: 'src/a.ts', start: 1, end: 2, side: 'RIGHT' as const, commit: 'HEAD1' }
      yield* Stream.runCollect(c.Ask({ ref, headSha: 'HEAD1', target, question: 'q1', followUp: false }))
      yield* Stream.runCollect(c.Ask({ ref, headSha: 'HEAD1', target, question: 'q2', followUp: true }))
      assert.strictEqual(agent.calls[1]!.resume, 'sess-1')
      assert.strictEqual(agent.calls[1]!.prompt, 'q2')
    }).pipe(Effect.scoped))

  it.effect('a conversation keeps every question and answer, per target', () =>
    Effect.gen(function* () {
      const c = yield* setup().client
      const target = { _tag: 'Lines' as const, path: 'src/a.ts', start: 1, end: 2, side: 'RIGHT' as const, commit: 'HEAD1' }
      yield* Stream.runCollect(c.Ask({ ref, headSha: 'HEAD1', target, question: 'q1', followUp: false }))
      yield* Stream.runCollect(c.Ask({ ref, headSha: 'HEAD1', target, question: 'q2', followUp: true }))
      const chats = yield* c.GetChats({ ref, headSha: 'HEAD1' })
      assert.deepStrictEqual(chats, [{ target, turns: [{ question: 'q1', answer: 'Hi' }, { question: 'q2', answer: 'Hi' }] }])
      assert.deepStrictEqual(yield* c.GetChats({ ref, headSha: 'OTHER' }), [])
    }).pipe(Effect.scoped))

  it.live('Sort streams what it is working on and ends with Done', () =>
    Effect.gen(function* () {
      const c = yield* setup({ delay: 100 }).client
      const events = yield* Stream.runCollect(c.Sort({ ref, headSha: 'HEAD1' }))
      const steps = events.flatMap((e) => (e._tag === 'Running' && e.step ? [e.step] : []))
      assert.include(steps, 'Searching for "x"')
      assert.strictEqual(events.at(-1)!._tag, 'Done')
    }).pipe(Effect.scoped))

  it.live('Stack entries carry the step of a running sort', () =>
    Effect.gen(function* () {
      const { client } = setup({ delay: 100, github: { listOpenPrs: () => Effect.succeed([entry(8, 'feat', 'feat2'), entry(7, 'master', 'feat')]) } })
      const c = yield* client
      const events = yield* Stream.runCollect(c.Stack({ ref: { ...ref, number: 8 } }))
      assert.isTrue(events.some((e) => e.entries.some((x) => x.status === 'running' && x.step === 'Searching for "x"')))
    }).pipe(Effect.scoped))

  it.live('a sort keeps running after the page leaves', () =>
    Effect.gen(function* () {
      const { agent, client } = setup({ delay: 200 })
      const c = yield* client
      yield* Stream.runHead(c.Sort({ ref, headSha: 'HEAD1' }))
      yield* Effect.sleep('300 millis')
      assert.deepStrictEqual(tags(yield* Stream.runCollect(c.Sort({ ref, headSha: 'HEAD1' }))), ['Done'])
      assert.strictEqual(agent.calls.length, 1)
    }).pipe(Effect.scoped))

  it.effect('verdicts carry to a new head for decisions whose files did not change', () =>
    Effect.gen(function* () {
      const decision = (id: string, path: string): Decision => ({ id, title: id, lens: 'architecture', reason: 'data-model', theme: 't', note: 'n', existing: null, authorWhy: null, files: [{ path, ranges: [] }] })
      const c = yield* setup({
        files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }, { path: 'src/b.ts', additions: 1, deletions: 0 }, { path: 'src/c.ts', additions: 1, deletions: 0 }],
        // Between the two heads only b.ts changed.
        diff: (_from, to, paths) => (to === 'HEAD2' && paths.includes('src/b.ts') ? 'changed' : 'd'),
        sorts: [
          { decisions: [decision('a', 'src/a.ts'), decision('b', 'src/b.ts')], skim: [{ area: 'Wiring', summary: 's', files: ['src/c.ts'] }], claims: [] },
          // The new sort names a's decision differently; it still covers the same file.
          { decisions: [decision('a-renamed', 'src/a.ts'), decision('b', 'src/b.ts')], skim: [{ area: 'Wiring', summary: 's', files: ['src/c.ts'] }], claims: [] },
        ],
      }).client
      yield* Stream.runCollect(c.Sort({ ref, headSha: 'HEAD1' }))
      yield* c.SetState({ ref, headSha: 'HEAD1', decisionId: 'a', state: 'accepted' })
      yield* c.SetState({ ref, headSha: 'HEAD1', decisionId: 'b', state: 'pushed-back' })
      yield* c.SetState({ ref, headSha: 'HEAD1', decisionId: 'skim:Wiring', state: 'accepted' })
      const done = (yield* Stream.runCollect(c.Sort({ ref, headSha: 'HEAD2' }))).at(-1)!
      assert.deepStrictEqual(done._tag === 'Done' ? done.state : undefined, { 'a-renamed': 'accepted', 'skim:Wiring': 'accepted' })
      // b changed since it was pushed back: it opens again, marked for a second look against the old head.
      assert.deepStrictEqual(done._tag === 'Done' ? done.rereview : undefined, { b: { since: 'HEAD1', was: 'pushed-back' } })
      // The marks stay once this head has verdicts of its own.
      yield* c.SetState({ ref, headSha: 'HEAD2', decisionId: 'skim:Wiring', state: null })
      const again = (yield* Stream.runCollect(c.Sort({ ref, headSha: 'HEAD2' }))).at(-1)!
      assert.deepStrictEqual(again._tag === 'Done' ? again.rereview : undefined, { b: { since: 'HEAD1', was: 'pushed-back' } })
    }).pipe(Effect.scoped))

  it.live('a rebase that only moved the base carries the verdict', () =>
    Effect.gen(function* () {
      const remote = makeRemote()
      const lines = (first: string) => `${first}\n${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}\n`
      const commit = (msg: string) => (git(remote, 'add', '.'), git(remote, 'commit', '-qm', msg))
      git(remote, 'checkout', '-q', 'master')
      writeFileSync(join(remote, 'm.txt'), lines('top'))
      commit('m')
      git(remote, 'checkout', '-q', 'feat')
      git(remote, 'rebase', '-q', 'master')
      writeFileSync(join(remote, 'm.txt'), lines('top').replace('line 15', 'changed'))
      commit('feat edits m')
      git(remote, 'update-ref', 'refs/pull/7/head', 'feat')
      const decision = (id: string, path: string): Decision => ({ id, title: id, lens: 'architecture', reason: 'data-model', theme: 't', note: 'n', existing: null, authorWhy: null, files: [{ path, ranges: [] }] })
      const reply = { decisions: [decision('a', 'm.txt')], skim: [], claims: [] }
      const realGit = Git.layer.pipe(Layer.provide(Config.layerTest({ cacheRoot: tmp(), remotes: { 'h/o/r': `file://${remote}` } })), Layer.provideMerge(NodeServices.layer))
      const c = yield* setup({ sorts: [reply, reply], git: { layer: realGit } as ReturnType<typeof fakeGit> }).client
      const head1 = git(remote, 'rev-parse', 'feat')
      yield* Stream.runCollect(c.Sort({ ref, headSha: head1 }))
      yield* c.SetState({ ref, headSha: head1, decisionId: 'a', state: 'accepted' })
      git(remote, 'checkout', '-q', 'master')
      writeFileSync(join(remote, 'm.txt'), lines('top').replace('top', 'new top\nsecond top'))
      commit('base moves')
      git(remote, 'checkout', '-q', 'feat')
      git(remote, 'rebase', '-q', 'master')
      git(remote, 'update-ref', 'refs/pull/7/head', 'feat')
      const head2 = git(remote, 'rev-parse', 'feat')
      assert.notStrictEqual(head2, head1)
      const done = (yield* Stream.runCollect(c.Sort({ ref, headSha: head2 }))).at(-1)!
      assert.strictEqual(done._tag === 'Done' ? done.state.a : undefined, 'accepted')
      assert.deepStrictEqual(done._tag === 'Done' ? done.rereview : undefined, {})
    }).pipe(Effect.scoped))

  it.effect('GetPr reads the PR while the open PRs load, and later shows the open PRs as last seen', () =>
    Effect.gen(function* () {
      let lists = 0
      const c = yield* setup({
        github: {
          getPr: () => Effect.as(Effect.sleep('1 second'), pr),
          listOpenPrs: () => Effect.as(Effect.sleep('1 second'), [entry(7, 'master', 'feat'), ...(lists++ ? [entry(8, 'feat', 'feat2')] : [])]),
        },
      }).client
      const cold = yield* Effect.forkChild(c.GetPr({ ref }))
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual((yield* Fiber.join(cold)).stack.map((s) => s.number), [7])
      // The list is refreshed behind the scenes; this load doesn't wait for it.
      const warm = yield* Effect.forkChild(c.GetPr({ ref }))
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual((yield* Fiber.join(warm)).stack.map((s) => s.number), [7])
      const next = yield* Effect.forkChild(c.GetPr({ ref }))
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual((yield* Fiber.join(next)).stack.map((s) => s.number), [7, 8])
    }).pipe(Effect.scoped))

  it.effect('trusted piles start out accepted, and stay as the reviewer leaves them', () =>
    Effect.gen(function* () {
      const c = yield* setup({ files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }, { path: 'src/a.test.ts', additions: 1, deletions: 0 }] }).client
      const first = (yield* Stream.runCollect(c.Sort({ ref, headSha: 'HEAD1' }))).at(-1)!
      assert.deepStrictEqual(first._tag === 'Done' && first.state, { 'trusted:tests': 'accepted' })
      yield* c.SetState({ ref, headSha: 'HEAD1', decisionId: 'trusted:tests', state: null })
      const again = (yield* Stream.runCollect(c.Sort({ ref, headSha: 'HEAD1' }))).at(-1)!
      assert.deepStrictEqual(again._tag === 'Done' && again.state, {})
    }).pipe(Effect.scoped))

  it.effect('SetState is per head', () =>
    Effect.gen(function* () {
      const c = yield* setup().client
      yield* c.SetState({ ref, headSha: 'HEAD1', decisionId: 'd1', state: 'accepted' })
      yield* c.SetState({ ref, headSha: 'HEAD1', decisionId: 'd2', state: 'pushed-back' })
      yield* c.SetState({ ref, headSha: 'HEAD1', decisionId: 'd2', state: null })
      const done = (yield* Stream.runCollect(c.Sort({ ref, headSha: 'HEAD1' }))).at(-1)!
      assert.deepStrictEqual(done._tag === 'Done' && done.state, { d1: 'accepted' })
      const other = (yield* Stream.runCollect(c.Sort({ ref, headSha: 'OTHER' }))).at(-1)!
      assert.deepStrictEqual(other._tag === 'Done' && other.state, {})
    }).pipe(Effect.scoped))

  it.effect('Opinion with run false and nothing cached is Idle', () =>
    Effect.gen(function* () {
      const { agent, client } = setup()
      const c = yield* client
      assert.deepStrictEqual(tags(yield* Stream.runCollect(c.Opinion({ ref, headSha: 'HEAD1', run: false }))), ['Idle'])
      assert.strictEqual(agent.calls.length, 0)
    }).pipe(Effect.scoped))

  it.live('Opinion with run true streams Running then Done with saved finding states', () =>
    Effect.gen(function* () {
      const { agent, client } = setup({ delay: 100, sorts: [{ decisions: [d1], skim: [], claims: [] }] })
      const c = yield* client
      yield* c.SetFindingState({ ref, headSha: 'HEAD1', findingId: 'd1:0', state: 'posted' })
      const events = yield* Stream.runCollect(c.Opinion({ ref, headSha: 'HEAD1', run: true }))
      assert.deepStrictEqual([...new Set(tags(events))], ['Running', 'Done'])
      const done = events.at(-1)!
      assert.deepStrictEqual(done._tag === 'Done' && [done.opinion.decisions[0]!.findings[0]!.id, done.states], ['d1:0', { 'd1:0': 'posted' }])
      // Cached now: a page opening later gets it without asking for a run.
      assert.deepStrictEqual(tags(yield* Stream.runCollect(c.Opinion({ ref, headSha: 'HEAD1', run: false }))), ['Done'])
      assert.strictEqual(opinionCalls(agent.calls), 1)
    }).pipe(Effect.scoped))

  it.effect('Opinion run true re-runs when a PR above has a new head', () =>
    Effect.gen(function* () {
      let above = 'sha8'
      const { agent, client } = setup({ github: { listOpenPrs: () => Effect.sync(() => [entry(7, 'master', 'feat'), { ...entry(8, 'feat', 'feat2'), headSha: above }]) } })
      const c = yield* client
      const run = Stream.runCollect(c.Opinion({ ref, headSha: 'HEAD1', run: true }))
      yield* run
      yield* run
      assert.strictEqual(opinionCalls(agent.calls), 1)
      above = 'sha8-new'
      const done = (yield* run).at(-1)!
      assert.strictEqual(opinionCalls(agent.calls), 2)
      assert.deepStrictEqual(done._tag === 'Done' && done.opinion.stackHeads, { 8: 'sha8-new' })
    }).pipe(Effect.scoped))

  it.effect('SetFindingState saves and clears', () =>
    Effect.gen(function* () {
      const c = yield* setup().client
      yield* Stream.runCollect(c.Opinion({ ref, headSha: 'HEAD1', run: true }))
      yield* c.SetFindingState({ ref, headSha: 'HEAD1', findingId: 'a', state: 'posted' })
      yield* c.SetFindingState({ ref, headSha: 'HEAD1', findingId: 'b', state: 'dismissed' })
      yield* c.SetFindingState({ ref, headSha: 'HEAD1', findingId: 'b', state: null })
      const done = (yield* Stream.runCollect(c.Opinion({ ref, headSha: 'HEAD1', run: false }))).at(-1)!
      assert.deepStrictEqual(done._tag === 'Done' && done.states, { a: 'posted' })
    }).pipe(Effect.scoped))
})
