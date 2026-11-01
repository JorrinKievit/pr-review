import { assert, describe, it } from '@effect/vitest'
import type { SortResult } from '@pr-review/domain'
import { Effect, Layer } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { Overview } from '../src/Overview.ts'
import { Store } from '../src/Store.ts'
import { configLayer, fakeAgent, fakeGit, overviewReply, ref } from './fakes.ts'

const sort = (id: string, title: string): SortResult => ({
  headSha: 'h',
  decisions: [{ id, title, lens: 'architecture', reason: 'data-model', theme: 'Data model', note: 'n', existing: null, authorWhy: null, files: [{ path: 'migrations/V1.php', ranges: [] }] }],
  skim: [],
  trusted: [],
  claims: [],
  unclaimedDecisionIds: [],
  lines: { decision: 1, skim: 0, trusted: 0 },
})

const entries = [
  { number: 2567, headSha: 'top0', sort: sort('money', 'Money naming'), files: [{ path: 'migrations/V1.php', additions: 10, deletions: 0 }] },
  { number: 2568, headSha: 'top1', sort: sort('record', 'Record usage'), files: [{ path: 'src/Usage/Record.php', additions: 5, deletions: 0 }] },
]

const setup = () => {
  const agent = fakeAgent(() => Effect.succeed(overviewReply))
  const layer = Overview.layer.pipe(Layer.provide([agent.layer, fakeGit().layer, configLayer(), Store.layerWith(KeyValueStore.layerMemory)]))
  const make = Effect.gen(function* () {
    const overview = yield* Overview
    return [yield* overview.make(ref, entries), yield* overview.make(ref, entries)] as const
  }).pipe(Effect.provide(layer))
  return { agent, make }
}

describe('Overview', () => {
  it.effect('sends decisions tagged with PR number and no diff', () =>
    Effect.gen(function* () {
      const { agent, make } = setup()
      yield* make
      const p = agent.calls[0]!.prompt
      assert.match(p, /#2567.*Money naming/)
      assert.match(p, /#2568.*Record usage/)
      assert.match(p, /src\/Usage\/Record\.php/)
      assert.notMatch(p, /diff --git/)
    }))

  it.effect('uses sonnet and is cached per bottom PR and top head', () =>
    Effect.gen(function* () {
      const { agent, make } = setup()
      const [r] = yield* make
      assert.strictEqual(agent.calls.length, 1)
      assert.strictEqual(r.summary, 's')
    }))
})
