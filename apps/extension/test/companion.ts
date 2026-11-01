import { ReviewRpcs, type SortEvent } from '@pr-review/domain'
import { memoryHub, portClientProtocol, portServer } from '@pr-review/native-messaging'
import { Effect, Layer, Stream } from 'effect'
import { RpcSerialization } from 'effect/rpc'

type Handlers = Parameters<typeof ReviewRpcs.toLayer>[0] extends infer H ? (H extends Effect.Effect<infer A, any, any> ? A : H) : never

const unused = () => Effect.die('unused')

/** What Remember saved, shared by every fake companion so a test can leave a page and come back. */
export const remembered = new Map<string, string>()

/** A fake companion behind a memory hub. Defaults: Health, GetFilePatch echoes the path, Sort emits `sortEvents` 20 ms apart then stays open. */
export const fakeCompanion = (o: { sortEvents?: ReadonlyArray<SortEvent>; onSortEnd?: () => void; handlers?: Partial<Handlers> } = {}) => {
  const hub = memoryHub()
  const handlers = ReviewRpcs.toLayer({
    Health: () => Effect.succeed({ version: '0.0.0' }),
    GetFilePatch: ({ path }) => Effect.succeed(`patch of ${path}`),
    Sort: () =>
      Stream.concat(Stream.fromIterable(o.sortEvents ?? []).pipe(Stream.mapEffect((e) => Effect.as(Effect.sleep(20), e))), Stream.never).pipe(
        Stream.ensuring(Effect.sync(() => o.onSortEnd?.())),
      ),
    GetPr: unused,
    SetState: unused,
    Ask: () => Stream.die('unused'),
    Stack: () => Stream.die('unused'),
    GetChats: () => Effect.succeed([]),
    GetDescription: () => Effect.succeed(''),
    GetDrafts: () => Effect.succeed([]),
    Recall: ({ key }) => Effect.sync(() => remembered.get(key) ?? null),
    Remember: ({ key, value }) => Effect.sync(() => void remembered.set(key, value)),
    SetDrafts: unused,
    SubmitReview: unused,
    Configure: () => Effect.void,
    GetSettings: () => Effect.succeed(null),
    PoolStatus: () => Effect.succeed([]),
    ...o.handlers,
  } as Handlers)
  return {
    hub,
    server: portServer(ReviewRpcs, handlers, hub.onConnect) as Layer.Layer<never>,
    protocol: portClientProtocol(Effect.sync(() => hub.connect())).pipe(Layer.provide(RpcSerialization.layerNdjson)),
  }
}
