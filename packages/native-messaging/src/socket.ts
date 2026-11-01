import { Context, Effect, Exit, Fiber, Layer, Scope, pipe } from 'effect'
import { NetAddress } from 'effect/net'
import { type Rpc, RpcClient, type RpcGroup, RpcSerialization, RpcServer } from 'effect/rpc'
import { Socket, SocketServer } from 'effect/socket'
import { splitMessage } from './framing.ts'
import type { OnConnectLike, PortLike } from './port.ts'

/** Web streams over a port: incoming string messages, outgoing bytes posted as (split) strings. */
export function portStreams(port: PortLike): Socket.InputTransformStream {
  // The port outlives the reader: once the reader cancels, later messages are dropped instead of thrown.
  let open = true
  const readable = new ReadableStream<string>({
    start(controller) {
      port.onMessage.addListener((m) => open && controller.enqueue(typeof m === 'string' ? m : JSON.stringify(m)))
      // An error, not a clean close: pending calls must fail rather than wait for a reconnect.
      port.onDisconnect.addListener(() => {
        if (open) controller.error(new Error('Port disconnected'))
        open = false
      })
    },
    cancel() {
      open = false
    },
  })
  const decoder = new TextDecoder()
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      // A gone port drops writes: Chrome throws on posting to a disconnected port.
      if (!open) return
      const text = decoder.decode(chunk, { stream: true })
      if (text) for (const part of splitMessage(text)) port.postMessage(part)
    },
    close() {
      port.disconnect()
    },
  })
  return { readable, writable }
}

/** An Effect Socket over a port; the port is disconnected when the socket's scope closes. */
export const portSocket = <E, R>(acquire: Effect.Effect<PortLike, E, R>) =>
  Socket.fromTransformStream(
    Effect.acquireRelease(acquire, (p) => Effect.sync(() => p.disconnect())).pipe(
      Effect.map(portStreams),
      Effect.mapError((cause) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: 'Unknown', cause }) })),
    ),
  )

/** Accepts every port from `onConnect` as a socket connection, for as long as `run` runs. */
export const portSocketServer = (onConnect: OnConnectLike): SocketServer.SocketServer['Service'] => {
  type Connection = { port: PortLike; streams: Socket.InputTransformStream }
  let current: ((c: Connection) => void) | undefined
  const pending: Connection[] = []
  // Listeners attach on connect, before `run` starts: in Chrome a page's connect is what wakes the worker,
  // and its first request arrives before the server is running.
  onConnect.addListener((port) => {
    const c = { port, streams: portStreams(port) }
    if (current) current(c)
    else pending.push(c)
  })
  return SocketServer.SocketServer.of({
    address: NetAddress.unixPathAddress('chrome-runtime-port'),
    run: <R, E, _>(handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const services = Context.omit(Scope.Scope)(yield* Effect.context<R>())
        const track = Fiber.runIn(scope)
        current = ({ port, streams }) =>
          pipe(
            Socket.fromTransformStream(Effect.acquireRelease(Effect.succeed(streams), () => Effect.sync(() => port.disconnect()))),
            Effect.flatMap(handler),
            Effect.scoped,
            Effect.ignoreCause({ log: 'Debug', message: 'port connection ended' }),
            Effect.runForkWith(services),
            track,
          )
        pending.splice(0).forEach(current)
        return yield* Effect.callback<never>(() => Effect.sync(() => (current = undefined))).pipe(Effect.ensuring(Scope.close(scope, Exit.void)))
      }),
  })
}

/**
 * Ports report their own disconnects, so pings only add a failure mode: a host busy for longer than the
 * ping timeout would drop every call. The interval is set past any review session instead.
 */
export const portClientProtocol = <E, R>(acquire: Effect.Effect<PortLike, E, R>) =>
  Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket({ pingInterval: '1 day' })).pipe(
    Layer.provide(Layer.effect(Socket.Socket, portSocket(acquire))),
  )

export const portServerLayer = (onConnect: OnConnectLike) =>
  RpcServer.layerProtocolSocketServer.pipe(Layer.provide(Layer.succeed(SocketServer.SocketServer, portSocketServer(onConnect))))

/** An RPC client over a port. Its protocol lives in the caller's scope, so the read loop keeps running. */
export const makePortClient = <Rpcs extends Rpc.Any, E, R>(group: RpcGroup.RpcGroup<Rpcs>, acquire: Effect.Effect<PortLike, E, R>) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(portClientProtocol(acquire).pipe(Layer.provide(RpcSerialization.layerNdjson)))
    return yield* RpcClient.make(group).pipe(Effect.provide(protocol))
  })

/** Serves `group` to every port that connects through `onConnect`. */
export const portServer = <Rpcs extends Rpc.Any, E, R>(
  group: RpcGroup.RpcGroup<Rpcs>,
  handlers: Layer.Layer<Rpc.ToHandler<Rpcs>, E, R>,
  onConnect: OnConnectLike,
) =>
  RpcServer.layer(group).pipe(
    Layer.provide(handlers),
    Layer.provide(portServerLayer(onConnect)),
    Layer.provide(RpcSerialization.layerNdjson),
  )
