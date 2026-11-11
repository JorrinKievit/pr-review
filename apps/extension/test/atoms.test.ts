// @vitest-environment node
import { assert, describe, it } from '@effect/vitest'
import type { ReviewEvent } from '@pr-review/domain'
import { portClientProtocol } from '@pr-review/native-messaging'
import { AsyncResult, AtomRegistry } from 'effect/reactivity'
import { Effect, Layer } from 'effect'
import { RpcSerialization } from 'effect/rpc'
import { makeAtoms, makeReviewClient } from '../src/atoms.ts'
import { fakeCompanion } from './companion.ts'

const result = { headSha: 'h', decisions: [], skim: [], trusted: [], claims: [], unclaimedDecisionIds: [], lines: { decision: 0, skim: 0, trusted: 0 } }
const events: ReviewEvent[] = [
  { _tag: 'Preparing', phases: [] },
  { _tag: 'Done', sort: result, state: {}, opinion: null, findingStates: {} },
]

describe('atoms', () => {
  it.live('reviewAtom yields Preparing then Done', () =>
    Effect.gen(function* () {
      const companion = fakeCompanion({ reviewEvents: events })
      yield* Layer.build(companion.server)
      const protocol = portClientProtocol(Effect.sync(() => companion.hub.connect())).pipe(Layer.provide(RpcSerialization.layerNdjson))
      class TestClient extends makeReviewClient<TestClient>()(protocol) {}
      const atoms = makeAtoms(TestClient)
      const registry = AtomRegistry.make()
      const seen: string[] = []
      const atom = atoms.reviewAtom({ host: 'h', owner: 'o', repo: 'r', number: 7 }, 'h')
      registry.subscribe(atom, (r) => AsyncResult.isSuccess(r) && seen.push(r.value._tag), { immediate: true })
      for (let i = 0; i < 100 && seen.length < 2; i++) yield* Effect.promise(() => new Promise((r) => setTimeout(r, 20)))
      assert.deepStrictEqual(seen, ['Preparing', 'Done'])
    }).pipe(Effect.scoped))
})
