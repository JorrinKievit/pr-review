import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Layer, Schema, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { Rpc, RpcGroup } from 'effect/rpc'
import { makePortClient, memoryHub, portServer } from '../src/index.ts'

class TestRpcs extends RpcGroup.make(
  Rpc.make('Echo', { payload: { text: Schema.String }, success: Schema.String }),
  Rpc.make('Count', { payload: { to: Schema.Number }, success: Schema.Number, stream: true }),
  Rpc.make('Never', { success: Schema.String }),
) {}

const Handlers = TestRpcs.toLayer({
  Echo: ({ text }) => Effect.succeed(text),
  Count: ({ to }) => Stream.range(1, to),
  Never: () => Effect.never,
})

const setup = Effect.gen(function* () {
  const hub = memoryHub()
  yield* Layer.build(portServer(TestRpcs, Handlers, hub.onConnect))
  const client = () => makePortClient(TestRpcs, Effect.sync(() => hub.connect()))
  return { hub, client }
})

describe('RPC over message ports', () => {
  it.effect('a busy peer that is slow to answer pings does not fail a pending call', () =>
    Effect.gen(function* () {
      // A port whose peer never replies stands in for a host whose event loop is blocked.
      const silent = { postMessage: () => {}, onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} }, disconnect: () => {} }
      const c = yield* makePortClient(TestRpcs, Effect.succeed(silent))
      const call = yield* Effect.forkChild(Effect.exit(c.Never()))
      for (let i = 0; i < 60; i++) {
        yield* TestClock.adjust('1 second')
        for (let j = 0; j < 5; j++) yield* Effect.yieldNow
      }
      assert.isUndefined(call.pollUnsafe())
    }).pipe(Effect.scoped))

  it.live('echo works', () =>
    Effect.gen(function* () {
      const { client } = yield* setup
      const c = yield* client()
      assert.strictEqual(yield* c.Echo({ text: 'hi' }), 'hi')
    }).pipe(Effect.scoped))

  it.live('stream delivers every item', () =>
    Effect.gen(function* () {
      const { client } = yield* setup
      const c = yield* client()
      assert.deepStrictEqual(yield* Stream.runCollect(c.Count({ to: 5 })), [1, 2, 3, 4, 5])
    }).pipe(Effect.scoped))

  it.live('a message over 1 MB arrives whole', () =>
    Effect.gen(function* () {
      const { client } = yield* setup
      const c = yield* client()
      const big = 'y'.repeat(2_500_000)
      assert.strictEqual((yield* c.Echo({ text: big })).length, big.length)
    }).pipe(Effect.scoped))

  it.live('two clients on one server get their own replies', () =>
    Effect.gen(function* () {
      const { client } = yield* setup
      const [a, b] = yield* Effect.all([client(), client()])
      const [ra, rb] = yield* Effect.all([a.Echo({ text: 'a' }), b.Echo({ text: 'b' })], { concurrency: 2 })
      assert.deepStrictEqual([ra, rb], ['a', 'b'])
    }).pipe(Effect.scoped))

  it.live('disconnect fails a pending call', () =>
    Effect.gen(function* () {
      const { client, hub } = yield* setup
      const c = yield* client()
      const pending = yield* Effect.forkChild(c.Never())
      yield* Effect.sleep(20)
      hub.disconnectAll()
      const exit = yield* Fiber.await(pending).pipe(Effect.timeout(2000))
      assert.isTrue(Exit.isFailure(exit))
    }).pipe(Effect.scoped))
})
