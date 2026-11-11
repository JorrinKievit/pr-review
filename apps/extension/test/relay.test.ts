// @vitest-environment node
import { assert, describe, it } from '@effect/vitest'
import { CompanionUnavailable, defaultSettings, ReviewRpcs, type Settings } from '@pr-review/domain'
import { makePortClient, memoryHub, type PortLike } from '@pr-review/native-messaging'
import { Effect, Exit, Fiber, Layer, Scope, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { relay } from '../src/relay.ts'
import { fakeCompanion } from './companion.ts'

const ref = { host: 'h', owner: 'o', repo: 'r', number: 7 }
const flush = Effect.promise(() => new Promise((r) => setTimeout(r, 50)))

const setup = (o: { onSortEnd?: () => void; settings?: Settings; configured?: Settings[]; version?: string; companionVersion?: string } = {}) =>
  Effect.gen(function* () {
    const companion = fakeCompanion({
      ...o,
      handlers: {
        Configure: ({ settings }) => Effect.sync(() => void o.configured?.push(settings)),
        ...(o.companionVersion ? { Health: () => Effect.succeed({ version: o.companionVersion! }) } : {}),
      },
    })
    yield* Layer.build(companion.server)
    const native = { opened: 0, closed: 0 }
    companion.hub.onConnect.addListener((port) => port.onDisconnect.addListener(() => native.closed++))
    const pages = memoryHub()
    yield* Layer.build(
      relay(() => {
        native.opened++
        return { port: companion.hub.connect(), lastError: () => undefined }
      }, pages.onConnect, Effect.succeed(o.settings), o.version),
    )
    /** A page with its own scope; closing the scope is the tab going away. */
    const page = Effect.gen(function* () {
      const scope = yield* Scope.make()
      const client = yield* makePortClient(ReviewRpcs, Effect.sync(() => pages.connect())).pipe(Scope.provide(scope))
      return { client, close: Scope.close(scope, Exit.void) }
    })
    return { companion, native, page }
  })

describe('relay', () => {
  it.effect('a prepare from the background reaches the companion, and without one nothing throws', () =>
    Effect.gen(function* () {
      const prepared: unknown[] = []
      const companion = fakeCompanion({ handlers: { Prepare: ({ ref }) => Effect.sync(() => void prepared.push(ref)) } })
      yield* Layer.build(companion.server)
      let fire: (r: typeof ref) => void = () => {}
      yield* Layer.build(relay(() => ({ port: companion.hub.connect(), lastError: () => undefined }), memoryHub().onConnect, Effect.succeed(undefined), undefined, { addListener: (f) => (fire = f) }))
      fire(ref)
      yield* flush
      assert.deepStrictEqual(prepared, [ref])
    }).pipe(Effect.scoped))

  it.effect('configures the companion with the stored settings before the first call', () =>
    Effect.gen(function* () {
      const configured: Settings[] = []
      const settings = { ...defaultSettings, hosts: ['git.example.com'] }
      const { page } = yield* setup({ settings, configured })
      yield* (yield* page).client.Health()
      assert.deepStrictEqual(configured, [settings])
    }).pipe(Effect.scoped))

  it.effect('a companion from another release fails calls as a mismatch, so the page asks to update it', () =>
    Effect.gen(function* () {
      const { page } = yield* setup({ version: '0.3.0', companionVersion: '0.2.0' })
      const exit = yield* Effect.exit((yield* page).client.GetDrafts({ ref }))
      assert.deepStrictEqual(exit, Exit.fail(new CompanionUnavailable({ reason: 'mismatch' })))
    }).pipe(Effect.scoped))

  it.effect('a companion of the same release, or run from source, is used as is', () =>
    Effect.gen(function* () {
      for (const companionVersion of ['0.3.0', '0.0.0']) {
        const { page } = yield* setup({ version: '0.3.0', companionVersion })
        assert.deepStrictEqual(yield* (yield* page).client.GetDrafts({ ref }), [])
      }
    }).pipe(Effect.scoped))

  it.effect('opens one native port for two pages', () =>
    Effect.gen(function* () {
      const { native, page } = yield* setup()
      const [a, b] = yield* Effect.all([page, page])
      yield* a.client.Health()
      yield* b.client.Health()
      assert.strictEqual(native.opened, 1)
    }).pipe(Effect.scoped))

  it.effect('routes replies to the page that asked', () =>
    Effect.gen(function* () {
      const { page } = yield* setup()
      const [a, b] = yield* Effect.all([page, page])
      const [ra, rb] = yield* Effect.all(
        [a.client.GetFilePatch({ ref, mergeBase: 'm', headSha: 'h', path: 'a.ts' }), b.client.GetFilePatch({ ref, mergeBase: 'm', headSha: 'h', path: 'b.ts' })],
        { concurrency: 2 },
      )
      assert.deepStrictEqual([ra, rb], ['patch of a.ts', 'patch of b.ts'])
    }).pipe(Effect.scoped))

  it.effect('ends the companion stream when its page goes away', () =>
    Effect.gen(function* () {
      let ended = false
      const { page } = yield* setup({ onSortEnd: () => (ended = true) })
      const p = yield* page
      yield* Effect.forkChild(Stream.runDrain(p.client.Sort({ ref, headSha: 'h' })))
      yield* flush
      assert.isFalse(ended)
      yield* p.close
      for (let i = 0; i < 200 && !ended; i++) yield* flush
      assert.isTrue(ended)
    }).pipe(Effect.scoped))

  it.effect('closes native 5 minutes after the last page', () =>
    Effect.gen(function* () {
      const { native, page } = yield* setup()
      const p = yield* page
      yield* p.client.Health()
      yield* p.close
      yield* flush
      yield* TestClock.adjust('4 minutes')
      yield* flush
      assert.strictEqual(native.closed, 0)
      yield* TestClock.adjust('1 minute')
      yield* flush
      assert.strictEqual(native.closed, 1)
      const again = yield* page
      yield* again.client.Health()
      assert.strictEqual(native.opened, 2)
    }).pipe(Effect.scoped))

  it.effect('a prepare with no page closes the connection after 10 minutes, not before', () =>
    Effect.gen(function* () {
      const companion = fakeCompanion({ handlers: { Prepare: () => Effect.void } })
      yield* Layer.build(companion.server)
      let closed = 0
      companion.hub.onConnect.addListener((port) => port.onDisconnect.addListener(() => closed++))
      let fire: (r: typeof ref) => void = () => {}
      yield* Layer.build(relay(() => ({ port: companion.hub.connect(), lastError: () => undefined }), memoryHub().onConnect, Effect.succeed(undefined), undefined, { addListener: (f) => (fire = f) }))
      fire(ref)
      yield* flush
      yield* TestClock.adjust('9 minutes')
      yield* flush
      assert.strictEqual(closed, 0)
      yield* TestClock.adjust('1 minute')
      yield* flush
      assert.strictEqual(closed, 1)
    }).pipe(Effect.scoped))

  it.effect('native disconnect surfaces CompanionUnavailable', () =>
    Effect.gen(function* () {
      const { companion, page } = yield* setup()
      const p = yield* page
      const pending = yield* Effect.forkChild(Stream.runDrain(p.client.Sort({ ref, headSha: 'h' })))
      yield* flush
      companion.hub.disconnectAll()
      const exit = yield* Fiber.await(pending)
      assert.isTrue(Exit.isFailure(exit))
      const error = Exit.isFailure(exit) ? exit.cause.reasons.find((r) => r._tag === 'Fail') : undefined
      assert.instanceOf(error?._tag === 'Fail' ? error.error : undefined, CompanionUnavailable)
      // The next call reconnects.
      yield* p.client.Health()
    }).pipe(Effect.scoped))

  it.effect('a missing host is reported as not-installed', () =>
    Effect.gen(function* () {
      const pages = memoryHub()
      const dead = (): PortLike => {
        const listeners: Array<() => void> = []
        // Chrome reports a missing host on a later task, after listeners are attached.
        setTimeout(() => listeners.forEach((f) => f()), 0)
        return { postMessage: () => {}, onMessage: { addListener: () => {} }, onDisconnect: { addListener: (f) => void listeners.push(f) }, disconnect: () => {} }
      }
      yield* Layer.build(relay(() => ({ port: dead(), lastError: () => 'Specified native messaging host not found.' }), pages.onConnect))
      const client = yield* makePortClient(ReviewRpcs, Effect.sync(() => pages.connect()))
      const e = yield* Effect.flip(client.Health())
      assert.strictEqual((e as CompanionUnavailable).reason, 'not-installed')
    }).pipe(Effect.scoped))

  it.effect('a missing host in Firefox is reported as not-installed', () =>
    Effect.gen(function* () {
      const pages = memoryHub()
      const dead = (): PortLike => {
        const listeners: Array<() => void> = []
        // Chrome reports a missing host on a later task, after listeners are attached.
        setTimeout(() => listeners.forEach((f) => f()), 0)
        return { postMessage: () => {}, onMessage: { addListener: () => {} }, onDisconnect: { addListener: (f) => void listeners.push(f) }, disconnect: () => {} }
      }
      yield* Layer.build(relay(() => ({ port: dead(), lastError: () => 'No such native application pr_review' }), pages.onConnect))
      const client = yield* makePortClient(ReviewRpcs, Effect.sync(() => pages.connect()))
      const e = yield* Effect.flip(client.Health())
      assert.strictEqual((e as CompanionUnavailable).reason, 'not-installed')
    }).pipe(Effect.scoped))
})
