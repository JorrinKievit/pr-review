import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { PassThrough } from 'node:stream'
import { FrameDecoder, makePortClient, portServer } from '../src/index.ts'
import { singlePort, streamPort } from '../src/node.ts'

class TestRpcs extends RpcGroup.make(Rpc.make('Echo', { payload: { text: Schema.String }, success: Schema.String })) {}
const Handlers = TestRpcs.toLayer({ Echo: ({ text }) => Effect.succeed(text) })

describe('framed stdio port', () => {
  it.live('serves RPC over framed streams, every host frame under 1 MB', () =>
    Effect.gen(function* () {
      const toHost = new PassThrough()
      const fromHost = new PassThrough()
      const sizes: number[] = []
      const sniff = new FrameDecoder()
      fromHost.on('data', (chunk: Buffer) => {
        let offset = 0
        while (offset + 4 <= chunk.length) {
          const size = chunk.readUInt32LE(offset)
          sizes.push(size + 4)
          offset += 4 + size
        }
        sniff.push(chunk)
      })
      yield* Layer.build(portServer(TestRpcs, Handlers, singlePort(streamPort(toHost, fromHost))))
      const client = yield* makePortClient(TestRpcs, Effect.sync(() => streamPort(fromHost, toHost)))
      const big = 'z'.repeat(2_000_000)
      assert.strictEqual(yield* client.Echo({ text: 'hi' }), 'hi')
      assert.strictEqual((yield* client.Echo({ text: big })).length, big.length)
      assert.isTrue(sizes.every((s) => s < 1024 * 1024))
    }).pipe(Effect.scoped))
})
