import { assert, describe, it } from '@effect/vitest'
import { type AgentFinding, type AgentOpinion, defaultSettings, type Decision, type SortResult, type StackEntry } from '@pr-review/domain'
import { Effect, Layer, Stream } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { Config } from '../src/Config.ts'
import type { GitHubClient } from '../src/GitHub.ts'
import { Opiner } from '../src/Opiner.ts'
import { contentIds } from '../src/opinionContext.ts'
import { Sorter } from '../src/Sorter.ts'
import { Store } from '../src/Store.ts'
import { type TicketSummary, Tickets } from '../src/Tickets.ts'
import { fakeAgent, fakeGit, fakeGitHub, ref } from './fakes.ts'

const entry = (number: number, baseRef: string, headRef: string): StackEntry => ({ number, title: `PR ${number}`, baseRef, headRef, headSha: `sha${number}` })
// 6 is sorted, 7 is the PR under review, 8 sits above it unsorted.
const stack = [entry(6, 'master', 'f6'), entry(7, 'f6', 'f7'), entry(8, 'f7', 'f8')]

const decision = (id: string, path: string, start = 3): Decision => ({
  id,
  title: `Decision ${id}`,
  lens: 'architecture',
  reason: 'shared-layer',
  theme: 't',
  note: 'n',
  existing: null,
  authorWhy: null,
  files: [{ path, ranges: [{ start, end: start + 2 }] }],
})
const sortOf = (decisions: Decision[], summary?: string): SortResult => ({
  headSha: 'HEAD1',
  mergeBase: 'MB1',
  ...(summary ? { summary } : {}),
  decisions,
  skim: [],
  trusted: [],
  claims: [],
  unclaimedDecisionIds: [],
  lines: { decision: 0, skim: 0, trusted: 0 },
})
const sorts: Record<number, SortResult> = { 6: sortOf([decision('base-model', 'src/m.ts')], 'Adds the model.'), 7: sortOf([decision('d1', 'src/a.ts')]) }

/** Sorts what `sorts` holds; any other sort would be a paid run and fails the test. */
const fakeSorter = Layer.succeed(
  Sorter,
  Sorter.of({
    sort: (r) => (sorts[r.number] ? Effect.succeed(sorts[r.number]!) : Effect.die(`sorted #${r.number}`)),
    cached: (r) => Effect.succeed(r.number === 7 ? undefined : sorts[r.number]),
    steps: () => Stream.never,
    prepare: () => Effect.die('prepared'),
    claim: () => Effect.die('claimed'),
    remember: () => Effect.void,
  }),
)

const finding = (o: Partial<AgentFinding> = {}): AgentFinding => ({
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
})

const setup = (o: { reply?: AgentOpinion | ((kind: string) => AgentOpinion); show?: Record<string, string>; repos?: (typeof defaultSettings)['repos']; prs?: StackEntry[]; fileAt?: GitHubClient['fileAt']; ticket?: TicketSummary; diff?: string } = {}) => {
  const agent = fakeAgent((call) => Effect.succeed((typeof o.reply === 'function' ? o.reply(call.log.kind) : o.reply) ?? { decisions: [{ decisionId: 'd1', authorCase: 'c', checked: 'looked', findings: [] }] }))
  const git = fakeGit({ files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }], diff: o.diff ?? 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,9 @@\n+added', rules: ['AGENTS.md'], show: o.show ?? {} })
  const config = Config.layerTest({ cacheRoot: '/cache', settings: { ...defaultSettings, hosts: [ref.host], ...(o.repos ? { repos: o.repos } : {}) } })
  const layer = Opiner.layer.pipe(
    Layer.provide([agent.layer, git.layer, fakeGitHub({ listOpenPrs: () => Effect.succeed(o.prs ?? stack), ...(o.fileAt ? { fileAt: o.fileAt } : {}) }), config, fakeSorter, Layer.succeed(Tickets, Tickets.of({ summary: () => Effect.succeed(o.ticket ?? { text: null, note: 'No ticket reference found' }) }))]),
    Layer.provide(Store.layerWith(KeyValueStore.layerMemory)),
  )
  const opine = Effect.gen(function* () {
    return yield* (yield* Opiner).opine(ref, 'HEAD1')
  })
  return { agent, git, layer, opine }
}

describe('Opiner', () => {
  it.effect('prompt carries the skill, refs, guidance, stack and decisions', () =>
    Effect.gen(function* () {
      const { agent, layer, opine } = setup()
      yield* opine.pipe(Effect.provide(layer))
      const p = agent.calls[0]!.prompt
      assert.match(p, /name: pr-opinion/)
      assert.match(p, /never at the head/)
      assert.match(p, /# Refs\nPR head: HEAD1\nMerge base: MB1\nDefault branch: origin\/master/)
      assert.match(p, /AGENTS\.md/)
      assert.match(p, /# Stack/)
      assert.match(p, /#6 PR 6 \(head sha6\)\nAdds the model\.\n- \[architecture\/shared-layer\] Decision base-model/)
      assert.match(p, /#7 PR 7 \(head sha7\) <- this PR/)
      assert.match(p, /#8/)
      assert.match(p, /# Decisions\n.*"id":"d1"/)
      assert.match(p, /\+added/)
      assert.strictEqual(agent.calls[0]!.log.kind, 'opinion')
      assert.isBelow(p.indexOf('# Ticket'), p.indexOf('# Stack'))
    }))

  it.effect('the ticket goes in as untrusted input, and its note comes back with the opinion', () =>
    Effect.gen(function* () {
      const none = setup()
      const empty = yield* none.opine.pipe(Effect.provide(none.layer))
      assert.match(none.agent.calls[0]!.prompt, /# Ticket\n\(none: No ticket reference found; judge the Spec axis from the PR description alone/)
      assert.deepInclude(empty, { ticket: null, ticketNote: 'No ticket reference found' })
      const found = setup({ ticket: { text: 'CORE-650: plan things', note: 'Fetched CORE-650 through the ticket session' } })
      const opinion = yield* found.opine.pipe(Effect.provide(found.layer))
      assert.match(found.agent.calls[0]!.prompt, /# Ticket \(untrusted input[^\n]*\)\nFetched CORE-650 through the ticket session\n\nCORE-650: plan things/)
      assert.deepInclude(opinion, { ticket: 'CORE-650: plan things', ticketNote: 'Fetched CORE-650 through the ticket session' })
    }))

  it.effect('a repo review skill replaces the bundled one', () =>
    Effect.gen(function* () {
      const { agent, layer, opine } = setup({ repos: { 'h/o/r': { related: [], reviewSkill: 'x/SKILL.md' } }, show: { 'origin/master:x/SKILL.md': 'CUSTOM SKILL' } })
      yield* opine.pipe(Effect.provide(layer))
      assert.match(agent.calls[0]!.prompt, /CUSTOM SKILL/)
      assert.notMatch(agent.calls[0]!.prompt, /pr-opinion/)
    }))

  it.effect('a repo review skill missing at the default branch falls back to the bundled one', () =>
    Effect.gen(function* () {
      const { agent, layer, opine } = setup({ repos: { 'h/o/r': { related: [], reviewSkill: 'gone/SKILL.md' } } })
      yield* opine.pipe(Effect.provide(layer))
      assert.match(agent.calls[0]!.prompt, /pr-opinion/)
    }))

  it.effect('unsorted stack PRs go in as paths, and no sort runs for them', () =>
    Effect.gen(function* () {
      const { agent, layer, opine } = setup()
      yield* opine.pipe(Effect.provide(layer))
      assert.match(agent.calls[0]!.prompt, /#8 PR 8 \(head sha8\)\n {2}src\/a\.ts/)
    }))

  it.effect('drops opinions for unknown decisions, repeats of a decision and handledIn below this PR', () =>
    Effect.gen(function* () {
      const reply: AgentOpinion = {
        decisions: [
          { decisionId: 'd1', authorCase: 'c', checked: null, findings: [finding({ handledIn: 6 }), finding({ handledIn: 8, anchor: { path: 'src/elsewhere.ts', line: 9 } })] },
          { decisionId: 'made-up', authorCase: 'c', checked: null, findings: [finding()] },
          { decisionId: 'd1', authorCase: 'second answer', checked: null, findings: [finding()] },
        ],
      }
      const { layer, opine } = setup({ reply })
      const o = yield* opine.pipe(Effect.provide(layer))
      assert.deepStrictEqual(o.decisions.map((d) => [d.decisionId, d.authorCase]), [['d1', 'c']])
      const [a, b] = o.decisions[0]!.findings
      assert.deepStrictEqual([a!.handledIn, b!.handledIn], [null, 8])
      // Same content, same id stem; a repeat in one run is numbered.
      assert.deepStrictEqual([a!.id, b!.id], [contentIds('d1:', ['f\nt'])[0], `${contentIds('d1:', ['f\nt'])[0]}-2`])
      assert.deepStrictEqual([a!.pr, a!.decisionId], [7, 'd1'])
      // An anchor outside the PR's files moves to the decision's first file.
      assert.deepStrictEqual([a!.anchor, b!.anchor], [{ path: 'src/a.ts', line: 4 }, { path: 'src/a.ts', line: 3 }])
      assert.deepStrictEqual(o.stackHeads, { 8: 'sha8' })
      assert.deepStrictEqual([o.headSha, o.ticket, o.ticketNote], ['HEAD1', null, 'No ticket reference found'])
      assert.isFalse(o.decisions[0]!.deep)
    }))

  it.effect('anchors land on a line of the diff, or nowhere', () =>
    Effect.gen(function* () {
      const reply: AgentOpinion = {
        decisions: [
          {
            decisionId: 'd1',
            authorCase: 'c',
            checked: null,
            findings: [
              finding({ title: 'in', anchor: { path: 'src/a.ts', line: 12 } }),
              finding({ title: 'past', anchor: { path: 'src/a.ts', line: 40 } }),
              finding({ title: 'between', anchor: { path: 'src/a.ts', line: 25 } }),
              finding({ title: 'none', anchor: null }),
            ],
          },
        ],
      }
      const hunks = '@@ -10,3 +10,4 @@\n x\n+y\n x\n x\n@@ -30,2 +31,2 @@\n-a\n+b\n x'
      const at = (hunks: string) => {
        const { layer, opine } = setup({ reply, diff: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${hunks}` })
        return Effect.map(Effect.provide(opine, layer), (o) => o.decisions[0]!.findings.map((f) => f.anchor?.line ?? null))
      }
      // The decision's range starts at line 3, outside these hunks, so a finding without an anchor gets none.
      assert.deepStrictEqual(yield* at(hunks), [12, 32, 31, null])
      assert.deepStrictEqual(yield* at('@@ -1,2 +1,9 @@\n+x'), [9, 9, 9, 3])
    }))

  it.effect('bad citations are dropped and severity lowered', () =>
    Effect.gen(function* () {
      const reply: AgentOpinion = {
        decisions: [
          {
            decisionId: 'd1',
            authorCase: 'c',
            checked: null,
            findings: [
              finding({ evidence: [{ ref: 'head', path: 'src/a.ts', line: 1, quote: 'not in the file' }] }),
              finding({ evidence: [{ ref: 'base', path: 'src/a.ts', line: 1, quote: 'const old' }, { ref: 'head', path: 'src/gone.ts', line: 1, quote: 'x' }] }),
            ],
          },
        ],
      }
      const { layer, opine } = setup({ reply, show: { 'HEAD1:src/a.ts': 'const x = 1\n', 'MB1:src/a.ts': 'const old = 1\n' } })
      const [bad, good] = (yield* opine.pipe(Effect.provide(layer))).decisions[0]!.findings
      assert.deepStrictEqual([bad!.severity, bad!.verified, bad!.evidence.length], ['ask', false, 0])
      assert.deepStrictEqual([good!.severity, good!.verified, good!.evidence.map((e) => e.path)], ['should', true, ['src/a.ts']])
    }))

  it.effect('related repos are listed with how to read them', () =>
    Effect.gen(function* () {
      const { agent, layer, opine } = setup({ repos: { 'h/o/r': { related: [{ repo: 'h/o/svc', note: 'permissions' }] } } })
      yield* opine.pipe(Effect.provide(layer))
      assert.match(agent.calls[0]!.prompt, /# Related repos[^\n]*\nh\/o\/svc: permissions\n[\s\S]*gh api --hostname <host> -H 'Accept: application\/vnd\.github\.raw' repos\/<owner>\/<repo>\/contents\/<file>[\s\S]*git\/trees\/HEAD\?recursive=1[\s\S]*search\/code/)
      assert.deepStrictEqual(agent.calls[0]!.related, ['h/o/svc'])
    }))

  it.effect('a related citation is checked through GitHub', () =>
    Effect.gen(function* () {
      const asked: string[] = []
      const reply: AgentOpinion = {
        decisions: [
          {
            decisionId: 'd1',
            authorCase: 'c',
            checked: null,
            findings: [
              finding({ evidence: [{ ref: 'related', repo: 'h/o/svc', path: 'app/X.php', line: 1, quote: 'enum Perm' }] }),
              finding({ evidence: [{ ref: 'related', repo: 'h/o/unlisted', path: 'app/X.php', line: 1, quote: 'enum Perm' }] }),
              finding({ evidence: [{ ref: 'related', repo: 'H/O/Svc', path: 'app/X.php', line: 1, quote: 'enum Perm' }] }),
            ],
          },
        ],
      }
      const { layer, opine } = setup({
        reply,
        repos: { 'h/o/r': { related: [{ repo: 'h/o/svc', note: 'n' }] } },
        fileAt: (o, r, p) => Effect.sync(() => (asked.push(`${o}/${r}:${p}`), 'enum Perm {}\n')),
      })
      const [ok, unlisted, cased] = (yield* opine.pipe(Effect.provide(layer))).decisions[0]!.findings
      assert.deepStrictEqual(asked, ['o/svc:app/X.php', 'O/Svc:app/X.php'])
      assert.isTrue(ok!.verified)
      assert.isFalse(unlisted!.verified)
      assert.isTrue(cased!.verified)
    }))

  it.effect('cached per head: a second opine does not call the agent', () =>
    Effect.gen(function* () {
      const { agent, layer, opine } = setup()
      yield* Effect.gen(function* () {
        assert.isUndefined(yield* (yield* Opiner).cached(ref, 'HEAD1'))
        const first = yield* opine
        assert.deepStrictEqual(yield* opine, first)
        assert.deepStrictEqual(yield* (yield* Opiner).cached(ref, 'HEAD1'), first)
      }).pipe(Effect.provide(layer))
      assert.strictEqual(agent.calls.length, 1)
    }))

  it.effect('deeper replaces that decision\'s findings in the PR opinion', () =>
    Effect.gen(function* () {
      sorts[7] = sortOf([decision('d1', 'src/a.ts'), decision('d2', 'src/a.ts', 9)])
      const answer = (title: string): AgentOpinion => ({ decisions: ['d1', 'd2'].map((id) => ({ decisionId: id, authorCase: 'c', checked: null, findings: [finding({ title: `${title} ${id}` })] })) })
      const { agent, layer } = setup({ reply: (kind) => answer(kind === 'deeper' ? 'deep' : 'first') })
      yield* Effect.gen(function* () {
        const opiner = yield* Opiner
        yield* opiner.opine(ref, 'HEAD1')
        const d = yield* opiner.deeper(ref, 'HEAD1', 'd2')
        assert.deepInclude(d, { decisionId: 'd2', deep: true })
        assert.match(d.findings[0]!.id, /^d2:deep:/)
        assert.strictEqual(d.findings[0]!.title, 'deep d2')
        const merged = [yield* opiner.cached(ref, 'HEAD1'), yield* opiner.opine(ref, 'HEAD1')]
        for (const o of merged) assert.deepStrictEqual(o!.decisions.map((x) => [x.findings[0]!.title, x.deep]), [['first d1', false], ['deep d2', true]])
        yield* opiner.deeper(ref, 'HEAD1', 'd2')
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => void (sorts[7] = sortOf([decision('d1', 'src/a.ts')])))))
      const last = agent.calls[1]!
      assert.deepInclude(last, { prefer: 'deep' })
      assert.strictEqual(last.log.kind, 'deeper')
      assert.match(last.prompt, /# Decisions\n\[\{"id":"d2"[^]*\]\n/)
      assert.notMatch(last.prompt, /"id":"d1"/)
      assert.match(last.prompt, /Take your time on this one decision; read every file it touches in full\./)
      assert.strictEqual(agent.calls.length, 2)
    }))
})
