import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { defaultSettings, RepoNotConfigured, type Settings } from '@pr-review/domain'
import { Effect, Layer } from 'effect'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Config } from '../src/Config.ts'
import { tmp } from './helpers.ts'

const load = (file: string) =>
  Effect.gen(function* () {
    return yield* Config
  }).pipe(Effect.provide(Config.layerFile(file, '/cache').pipe(Layer.provide(NodeServices.layer))))

const mine: Settings = { ...defaultSettings, hosts: ['github.com', 'git.example.com'] }

describe('Config', () => {
  it.effect('without a saved copy the defaults apply', () =>
    Effect.gen(function* () {
      const config = yield* load(join(tmp(), 'settings.json'))
      assert.strictEqual(config.cacheRoot, '/cache')
      assert.deepStrictEqual(yield* config.settings, defaultSettings)
      assert.strictEqual(yield* config.saved, null)
    }))

  it.effect('configured settings are kept on disk for the next start', () =>
    Effect.gen(function* () {
      const file = join(tmp(), 'settings.json')
      yield* (yield* load(file)).configure(mine)
      const restarted = yield* load(file)
      assert.deepStrictEqual(yield* restarted.settings, mine)
      assert.deepStrictEqual(yield* restarted.saved, mine)
    }))

  it.effect('a broken copy falls back to the defaults', () =>
    Effect.gen(function* () {
      const file = join(tmp(), 'settings.json')
      writeFileSync(file, '{"hosts": 3}')
      assert.deepStrictEqual(yield* (yield* load(file)).settings, defaultSettings)
    }))

  it.effect('a repo on a configured host clones over https; other hosts are not configured', () =>
    Effect.gen(function* () {
      const file = join(tmp(), 'settings.json')
      const config = yield* load(file)
      yield* config.configure(mine)
      assert.deepStrictEqual(yield* config.repo('git.example.com/acme/app'), { key: 'git.example.com/acme/app', remoteUrl: 'https://git.example.com/acme/app.git' })
      assert.instanceOf(yield* Effect.flip(config.repo('elsewhere.com/acme/app')), RepoNotConfigured)
    }))
})
