import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { GitError } from '@pr-review/domain'
import { Effect, Layer } from 'effect'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Config } from '../src/Config.ts'
import { Git } from '../src/Git.ts'
import { git, makeRemote, tmp } from './helpers.ts'

const key = 'example.com/acme/app'

const setup = () => {
  const remote = makeRemote()
  const cacheRoot = tmp()
  const layer = Git.layer.pipe(
    Layer.provide(Config.layerTest({ cacheRoot, remotes: { [key]: `file://${remote}` } })),
    Layer.provideMerge(NodeServices.layer),
  )
  return { remote, layer }
}

const run = <A, E>(f: (g: Git['Service'], remote: string) => Effect.Effect<A, E>) => {
  const { remote, layer } = setup()
  return Effect.gen(function* () {
    return yield* f(yield* Git, remote)
  }).pipe(Effect.provide(layer))
}

describe('Git', () => {
  it.live('clone is full and has gc.auto 0', () =>
    run((g) =>
      Effect.gen(function* () {
        yield* g.ensureClone(key)
        const dir = g.dir(key)
        const config = readFileSync(join(dir, 'config'), 'utf8')
        assert.match(config, /bare = true/)
        assert.notMatch(config, /partialclonefilter/)
        assert.strictEqual(git(dir, 'config', 'gc.auto'), '0')
        assert.strictEqual(git(dir, 'config', 'maintenance.auto'), 'false')
      }),
    ))

  it.live('ensureClone twice is a no-op', () => run((g) => Effect.andThen(g.ensureClone(key), g.ensureClone(key))))

  it.live('the default branch is the remote HEAD the clone took', () => run((g) => Effect.map(g.defaultBranch(key), (b) => assert.strictEqual(b, 'master'))))

  it.live('fetchPr resolves head, base and merge-base', () =>
    run((g, remote) =>
      Effect.gen(function* () {
        const head = git(remote, 'rev-parse', 'feat')
        const r = yield* g.fetchPr(key, 7, 'master', head)
        assert.deepStrictEqual(r, { headSha: head, baseSha: git(remote, 'rev-parse', 'master'), mergeBase: git(remote, 'rev-parse', 'master') })
      }),
    ))

  it.live('fetchPr runs git fetch once per head', () =>
    run((g, remote) =>
      Effect.gen(function* () {
        const head = git(remote, 'rev-parse', 'feat')
        const first = yield* g.fetchPr(key, 7, 'master', head)
        rmSync(remote, { recursive: true, force: true })
        assert.deepStrictEqual(yield* g.fetchPr(key, 7, 'master', head), first)
        const moved = yield* Effect.flip(g.fetchPr(key, 7, 'master', 'f'.repeat(40)))
        assert.instanceOf(moved, GitError)
      }),
    ))

  it.live('after a restart, fetchPr skips the network for a head the clone already has', () =>
    Effect.gen(function* () {
      const { remote, layer } = setup()
      const head = git(remote, 'rev-parse', 'feat')
      const first = yield* Effect.provide(Effect.gen(function* () { return yield* (yield* Git).fetchPr(key, 7, 'master', head) }), layer)
      rmSync(remote, { recursive: true, force: true })
      // A fresh layer: nothing cached in memory, only the clone on disk.
      assert.deepStrictEqual(yield* Effect.provide(Effect.gen(function* () { return yield* (yield* Git).fetchPr(key, 7, 'master', head) }), layer), first)
    }))

  it.live('numstat lists both files', () =>
    run((g, remote) =>
      Effect.gen(function* () {
        const r = yield* g.fetchPr(key, 7, 'master', git(remote, 'rev-parse', 'feat'))
        assert.deepStrictEqual(yield* g.numstat(key, r.mergeBase, r.headSha), [
          { path: 'a.txt', additions: 1, deletions: 1 },
          { path: 'b.txt', additions: 1, deletions: 0 },
        ])
      }),
    ))

  it.live('a moved file is one rename with its old path, and its diff shows the move', () =>
    run((g, remote) =>
      Effect.gen(function* () {
        git(remote, 'checkout', '-qb', 'move', 'master')
        writeFileSync(join(remote, 'a.txt'), 'one\n'.repeat(20))
        git(remote, 'commit', '-qam', 'longer')
        git(remote, 'update-ref', 'refs/heads/master', 'move')
        git(remote, 'mv', 'a.txt', 'moved.txt')
        appendFileSync(join(remote, 'moved.txt'), 'extra\n')
        git(remote, 'commit', '-qam', 'move')
        git(remote, 'update-ref', 'refs/pull/8/head', 'move')
        const r = yield* g.fetchPr(key, 8, 'master', git(remote, 'rev-parse', 'move'))
        assert.deepStrictEqual(yield* g.numstat(key, r.mergeBase, r.headSha), [{ path: 'moved.txt', previous: 'a.txt', additions: 1, deletions: 0 }])
        const patch = yield* g.diff(key, r.mergeBase, r.headSha, ['a.txt', 'moved.txt'])
        assert.match(patch, /rename from a\.txt/)
        assert.match(patch, /rename to moved\.txt/)
      }),
    ))

  it.live('diff limited to paths', () =>
    run((g, remote) =>
      Effect.gen(function* () {
        const r = yield* g.fetchPr(key, 7, 'master', git(remote, 'rev-parse', 'feat'))
        assert.match(yield* g.diff(key, r.mergeBase, r.headSha), /\+\+\+ b\/a\.txt/)
        const only = yield* g.diff(key, r.mergeBase, r.headSha, ['b.txt'])
        assert.match(only, /\+\+\+ b\/b\.txt/)
        assert.notMatch(only, /a\.txt/)
      }),
    ))

  it.live('show reads a file at a sha', () =>
    run((g, remote) =>
      Effect.gen(function* () {
        const r = yield* g.fetchPr(key, 7, 'master', git(remote, 'rev-parse', 'feat'))
        assert.strictEqual(yield* g.show(key, r.headSha, 'b.txt'), 'new\n')
      }),
    ))

  it.live('lsTree lists paths at a ref', () =>
    run((g, remote) =>
      Effect.gen(function* () {
        yield* g.fetchPr(key, 7, 'master', git(remote, 'rev-parse', 'feat'))
        assert.deepStrictEqual(yield* g.lsTree(key, 'refs/remotes/origin/master', []), ['a.txt'])
        assert.deepStrictEqual(yield* g.lsTree(key, 'refs/remotes/origin/master', ['.agents']), [])
      }),
    ))

  it.live('a failing git command becomes GitError with stderr', () =>
    run((g, remote) =>
      Effect.gen(function* () {
        const r = yield* g.fetchPr(key, 7, 'master', git(remote, 'rev-parse', 'feat'))
        const e = yield* Effect.flip(g.show(key, r.headSha, 'missing.txt'))
        assert.instanceOf(e, GitError)
        assert.match(e.message, /missing\.txt/)
      }),
    ))
})
