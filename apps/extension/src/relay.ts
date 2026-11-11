import { CompanionUnavailable, ReviewRpcs, type Settings } from '@pr-review/domain'
import { makePortClient, type OnConnectLike, type PortLike, portServer } from '@pr-review/native-messaging'
import { Deferred, Effect, Exit, Fiber, Layer, Option, Scope, Semaphore, Stream } from 'effect'
import type { RpcClient, RpcClientError, RpcGroup } from 'effect/rpc'

/** A native port plus what Chrome said when it failed (`chrome.runtime.lastError`). */
export type NativeConnect = () => { port: PortLike; lastError: () => string | undefined }

export const IDLE = '5 minutes'

const deadPort = (): PortLike => ({
  postMessage: () => {},
  onMessage: { addListener: () => {} },
  onDisconnect: { addListener: (f) => queueMicrotask(f) },
  disconnect: () => {},
})

type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ReviewRpcs>, RpcClientError.RpcClientError>
type Connection = { client: Client; scope: Scope.Closeable; died: Deferred.Deferred<void>; reason: () => CompanionUnavailable['reason'] }

/**
 * The background worker's RPC proxy: serves every page port and forwards each call to one native host,
 * opened on first use and closed `IDLE` after the last page leaves. A dead host fails calls with
 * CompanionUnavailable; the next call reconnects.
 */
export const relay = (native: NativeConnect, pages: OnConnectLike, settings: Effect.Effect<Settings | undefined> = Effect.succeed(undefined), version?: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const services = yield* Effect.context<never>()
      const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runForkWith(services)(effect)
      const lock = yield* Semaphore.make(1)
      let current: Connection | undefined
      let pageCount = 0
      let idle: Fiber.Fiber<void> | undefined

      let dead: Connection[] = []
      const close = (c: Connection) =>
        Effect.suspend(() => {
          if (current === c) current = undefined
          return Scope.close(c.scope, Exit.void)
        })
      /** The protocol fails its pending calls itself; closing the scope now would interrupt them instead. */
      const retire = (c: Connection) => {
        if (current === c) current = undefined
        dead.push(c)
      }

      const connect = Effect.gen(function* () {
        yield* Effect.forEach(dead.splice(0), close, { discard: true })
        const scope = yield* Scope.make()
        const { port, lastError } = native()
        let received = false
        let alive = true
        const died = Deferred.makeUnsafe<void>()
        port.onMessage.addListener(() => (received = true))
        port.onDisconnect.addListener(() => {
          alive = false
          Deferred.doneUnsafe(died, Effect.void)
        })
        // The socket reader attaches its listeners a tick later; a port that died before then is handed over
        // as one that reports its disconnect at once, so the reader fails and pending calls fail with it.
        const open = Effect.sync((): PortLike => (alive ? port : deadPort()))
        const reason = (): CompanionUnavailable['reason'] => (!received && /not found|forbidden|no such native application/i.test(lastError() ?? '') ? 'not-installed' : 'disconnected')
        const client = (yield* makePortClient(ReviewRpcs, open).pipe(Scope.provide(scope))) as Client
        const connection: Connection = {
          client,
          scope,
          died,
          reason,
        }
        port.onDisconnect.addListener(() => retire(connection))
        // Before any page's call: the companion runs on what the settings page saved. Without any, it keeps its own copy.
        const saved = yield* settings
        if (saved) yield* Effect.ignore(client.Configure({ settings: saved }))
        // Both come from one release tag; a companion run from source reports 0.0.0 and works with any build.
        const theirs = version ? (yield* Effect.option(client.Health())).pipe(Option.map((h) => h.version), Option.getOrUndefined) : undefined
        if (theirs && theirs !== '0.0.0' && theirs !== version) {
          yield* Scope.close(scope, Exit.void)
          return yield* new CompanionUnavailable({ reason: 'mismatch' })
        }
        current = connection
        return connection
      })
      const connection = lock.withPermits(1)(Effect.suspend(() => (current ? Effect.succeed(current) : connect)))

      /** Calls race the connection's death, so they fail at once whatever the protocol's retry state. */
      const unavailable = (c: Connection) => Effect.andThen(Deferred.await(c.died), Effect.suspend(() => Effect.fail(new CompanionUnavailable({ reason: c.reason() }))))
      const call = <A, E>(f: (client: Client) => Effect.Effect<A, E | RpcClientError.RpcClientError>) =>
        Effect.flatMap(connection, (c) =>
          Effect.raceFirst(f(c.client).pipe(Effect.catchTag('RpcClientError', () => unavailable(c))), unavailable(c)),
        )
      const stream = <A, E>(f: (client: Client) => Stream.Stream<A, E | RpcClientError.RpcClientError>) =>
        Stream.unwrap(
          Effect.map(connection, (c) => f(c.client).pipe(Stream.catchTag('RpcClientError', () => Stream.fromEffect(unavailable(c))), Stream.interruptWhen(unavailable(c)))),
        )

      const handlers = ReviewRpcs.toLayer({
        Health: () => call((c) => c.Health()),
        Configure: (p) => call((c) => c.Configure(p)),
        GetSettings: () => call((c) => c.GetSettings()),
        PoolStatus: () => call((c) => c.PoolStatus()),
        GetPr: (p) => call((c) => c.GetPr(p)),
        GetFilePatch: (p) => call((c) => c.GetFilePatch(p)),
        Sort: (p) => stream((c) => c.Sort(p)),
        SetState: (p) => call((c) => c.SetState(p)),
        Opinion: (p) => stream((c) => c.Opinion(p)),
        DigDeeper: (p) => stream((c) => c.DigDeeper(p)),
        SetFindingState: (p) => call((c) => c.SetFindingState(p)),
        Ask: (p) => stream((c) => c.Ask(p)),
        Stack: (p) => stream((c) => c.Stack(p)),
        GetChats: (p) => call((c) => c.GetChats(p)),
        GetDescription: (p) => call((c) => c.GetDescription(p)),
        GetDrafts: (p) => call((c) => c.GetDrafts(p)),
        Recall: (p) => call((c) => c.Recall(p)),
        Remember: (p) => call((c) => c.Remember(p)),
        SetDrafts: (p) => call((c) => c.SetDrafts(p)),
        SubmitReview: (p) => call((c) => c.SubmitReview(p)),
      })

      const counted: OnConnectLike = {
        addListener: (f) =>
          pages.addListener((port) => {
            pageCount++
            if (idle) run(Fiber.interrupt(idle))
            port.onDisconnect.addListener(() => {
              if (--pageCount > 0) return
              idle = run(Effect.sleep(IDLE).pipe(Effect.andThen(Effect.suspend(() => (current ? close(current) : Effect.void)))))
            })
            f(port)
          }),
      }

      return portServer(ReviewRpcs, handlers, counted)
    }),
  )
