import { defaultSettings, ReviewRpcs, Settings } from '@pr-review/domain'
import { makePortClient } from '@pr-review/native-messaging'
import { Effect, Option, Schema, type Scope } from 'effect'
import type { RpcClient, RpcClientError, RpcGroup } from 'effect/rpc'

const KEY = 'settings'
const decode = Schema.decodeUnknownOption(Settings)

/** What the settings page saved; undefined before the first save, or after Firefox dropped a temporary add-on's storage. */
export const storedSettings: Effect.Effect<Settings | undefined> = Effect.promise(() => chrome.storage.local.get(KEY)).pipe(
  Effect.map((r) => Option.getOrUndefined(decode(r[KEY]))),
)

const store = (s: Settings) => Effect.promise(() => chrome.storage.local.set({ [KEY]: s }))

type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ReviewRpcs>, RpcClientError.RpcClientError>

/** One call to the companion through the background relay. */
export const companion = <A, E>(f: (c: Client) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.flatMap(makePortClient(ReviewRpcs, Effect.sync(() => chrome.runtime.connect({ name: 'rpc' }))) as Effect.Effect<Client, never, Scope.Scope>, f))

/** The stored settings, else the companion's copy (stored again), else the defaults. */
export const loadSettings = Effect.gen(function* () {
  const stored = yield* storedSettings
  if (stored) return stored
  const copy = yield* companion((c) => c.GetSettings()).pipe(Effect.timeout('5 seconds'), Effect.orElseSucceed(() => null))
  if (copy) yield* store(copy)
  return copy ?? defaultSettings
})

export const saveSettings = (s: Settings) => Effect.andThen(store(s), companion((c) => c.Configure({ settings: s })))
