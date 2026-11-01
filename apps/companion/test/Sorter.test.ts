import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { AgentError, defaultSettings, type FileStat } from '@pr-review/domain'
import { Effect, Layer } from 'effect'
import { KeyValueStore, PersistedCache } from 'effect/persistence'
import { Sorter } from '../src/Sorter.ts'
import { cacheOptions, PatchKey, Store } from '../src/Store.ts'
import { configLayer, fakeAgent, fakeGit, fakeGitHub, ref } from './fakes.ts'
import { tmp } from './helpers.ts'

const files: FileStat[] = [
  { path: 'src/a.ts', additions: 3, deletions: 1 },
  { path: 'src/__tests__/a.test.ts', additions: 9, deletions: 0 },
]

const layers = (o: { diff?: string; agent?: ReturnType<typeof fakeAgent>; kvs?: Layer.Layer<KeyValueStore.KeyValueStore>; files?: typeof files } = {}) => {
  const agent = o.agent ?? fakeAgent()
  const git = fakeGit({ files: o.files ?? files, diff: o.diff ?? 'd', rules: ['.agents/rules/react.md', '.agents/agents/frontend-reviewer.md'] })
  const layer = Sorter.layer.pipe(
    Layer.provide([agent.layer, git.layer, fakeGitHub(), configLayer()]),
    Layer.provide(Store.layerWith(o.kvs ?? KeyValueStore.layerMemory)),
  )
  return { agent, git, layer }
}

const sortWith = (layer: Layer.Layer<Sorter>) =>
  Effect.gen(function* () {
    return yield* (yield* Sorter).sort(ref, 'HEAD1')
  }).pipe(Effect.provide(layer))

describe('Sorter', () => {
  it.effect('sends numstat only for oversized diffs', () =>
    Effect.gen(function* () {
      const { agent, layer } = layers({ diff: 'x'.repeat(300_001) })
      yield* sortWith(layer)
      const p = agent.calls[0]!.prompt
      assert.match(p, /Diff too large; read files with git show HEAD1:<path>/)
      assert.notMatch(p, /xxxxxxxxxx/)
      assert.match(p, /src\/a\.ts\t\+3\t-1/)
    }))

  it.effect('includes the diff and PR body when it fits', () =>
    Effect.gen(function* () {
      const { agent, layer } = layers({ diff: 'diff --git a/src/a.ts b/src/a.ts\n+hello' })
      yield* sortWith(layer)
      assert.match(agent.calls[0]!.prompt, /\+hello/)
      assert.match(agent.calls[0]!.prompt, /## Decisions/)
    }))

  it.effect('trusted files are not in the prompt diff', () =>
    Effect.gen(function* () {
      const { agent, git, layer } = layers()
      yield* sortWith(layer)
      assert.deepStrictEqual(git.diffPaths[0], ['src/a.ts'])
      assert.notMatch(agent.calls[0]!.prompt.split('# Changed files')[1]!.split('# ')[0]!, /a\.test\.ts/)
      // Claude still sees them, as candidates it confirms or moves.
      assert.match(agent.calls[0]!.prompt.split('# Likely trusted')[1]!, /## tests: CI checks: pass\nsrc\/__tests__\/a\.test\.ts/)
    }))

  it.effect('a moved file is diffed with its old path, so Claude sees a rename', () =>
    Effect.gen(function* () {
      const { git, layer } = layers({ files: [{ path: 'src/b.ts', previous: 'src/a.ts', additions: 1, deletions: 0 }] })
      yield* sortWith(layer)
      assert.deepStrictEqual(git.diffPaths[0], ['src/a.ts', 'src/b.ts'])
    }))

  it.effect('prompt lists the repo guidance at the default branch and says never cd', () =>
    Effect.gen(function* () {
      const { agent, git, layer } = layers()
      yield* sortWith(layer)
      const p = agent.calls[0]!.prompt
      assert.match(p, /git show origin\/master:<path>/)
      assert.match(p, /\.agents\/agents\/frontend-reviewer\.md/)
      assert.deepStrictEqual(git.listed[0], defaultSettings.review.guidance)
      assert.match(p, /never `cd`/)
      assert.match(p, /MB1/)
    }))

  it.effect('uses sonnet in the clone and returns a normalized result', () =>
    Effect.gen(function* () {
      const { agent, layer } = layers()
      const r = yield* sortWith(layer)
      assert.strictEqual(agent.calls[0]!.cwd, '/cache/repo.git')
      assert.strictEqual(r.headSha, 'HEAD1')
      assert.deepStrictEqual(r.trusted.map((t) => t.group), ['tests'])
      assert.deepStrictEqual(r.skim, [{ area: 'Unsorted', summary: 'Not placed by the sort.', files: ['src/a.ts'] }])
    }))
})

describe('Store', () => {
  it.live('a sort is computed once and then read from disk', () =>
    Effect.gen(function* () {
      const dir = tmp()
      const kvs = KeyValueStore.layerFileSystem(dir).pipe(Layer.provide(NodeServices.layer), Layer.orDie)
      const agent = fakeAgent()
      const first = yield* sortWith(layers({ agent, kvs }).layer)
      // A fresh layer is a restarted companion: only the disk survives.
      const second = yield* sortWith(layers({ agent, kvs }).layer)
      assert.strictEqual(agent.calls.length, 1)
      assert.deepStrictEqual(second, first)
    }))

  it.live('a patch for a deep path is cached on disk', () =>
    Effect.gen(function* () {
      const kvs = KeyValueStore.layerFileSystem(tmp()).pipe(Layer.provide(NodeServices.layer), Layer.orDie)
      const path = `apps/web/src/${'nested-directory/'.repeat(10)}component.tsx`
      const key = new PatchKey({ repoKey: 'github.com/acme/core', mergeBase: 'a'.repeat(40), headSha: 'b'.repeat(40), path })
      let lookups = 0
      const get = Effect.gen(function* () {
        const cache = yield* PersistedCache.make((_: PatchKey) => Effect.sync(() => (lookups++, 'patch')), { storeId: 'patch', ...cacheOptions })
        return yield* cache.get(key)
      }).pipe(Effect.scoped, Effect.provide(Store.layerWith(kvs)))
      assert.strictEqual(yield* get, 'patch')
      assert.strictEqual(yield* get, 'patch')
      assert.strictEqual(lookups, 1)
    }))

  it.effect('a failed sort is not cached', () =>
    Effect.gen(function* () {
      let n = 0
      const agent = fakeAgent(() => (n++ === 0 ? Effect.fail(new AgentError({ message: 'boom' })) : Effect.succeed({ decisions: [], skim: [], claims: [] })))
      const { layer } = layers({ agent })
      yield* Effect.gen(function* () {
        const sorter = yield* Sorter
        assert.instanceOf(yield* Effect.flip(sorter.sort(ref, 'HEAD1')), AgentError)
        yield* sorter.sort(ref, 'HEAD1')
      }).pipe(Effect.provide(layer))
      assert.strictEqual(agent.calls.length, 2)
    }))

  it.live('two concurrent gets share one lookup', () =>
    Effect.gen(function* () {
      const agent = fakeAgent(() => Effect.as(Effect.sleep(20), { decisions: [], skim: [], claims: [] }))
      yield* Effect.gen(function* () {
        const sorter = yield* Sorter
        yield* Effect.all([sorter.sort(ref, 'HEAD1'), sorter.sort(ref, 'HEAD1')], { concurrency: 2 })
      }).pipe(Effect.provide(layers({ agent }).layer))
      assert.strictEqual(agent.calls.length, 1)
    }))
})
