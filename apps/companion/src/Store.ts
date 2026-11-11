import { AgentError, AskTarget, ChatTurn, DecisionState, DecisionStates, Draft, FileStat, FindingStates, GitError, GitHubError, PrOpinion, RepoNotConfigured, Rereview, SortResult, StackOverview } from '@pr-review/domain'
import { Context, Effect, Exit, Layer, Schema } from 'effect'
import { KeyValueStore, Persistable, Persistence } from 'effect/persistence'
import { NodeServices } from '@effect/platform-node'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Config } from './Config.ts'

/** Conversations per target key, with the Claude session a follow-up resumes. */
export const Chats = Schema.Record(Schema.String, Schema.Struct({ target: AskTarget, sessionId: Schema.String, turns: Schema.Array(ChatTurn) }))

const Drafts = Schema.Array(Draft)

/** The verdicts on the head last worked on, with each decision's files, so a push can carry them over. */
export const LastVerdicts = Schema.Struct({
  headSha: Schema.String,
  mergeBase: Schema.optionalKey(Schema.String),
  decisions: Schema.Array(Schema.Struct({ id: Schema.String, paths: Schema.Array(Schema.String), state: DecisionState })),
})

/** The file store names each entry after its key, so keys are hashed to stay under the 255-byte filename limit. */
const digest = (key: string) => createHash('sha256').update(key).digest('hex')

const errors = Schema.Union([AgentError, GitError, GitHubError, RepoNotConfigured])

export class SortKey extends Persistable.Class<{ payload: { host: string; owner: string; repo: string; number: number; headSha: string } }>()('SortKey', {
  primaryKey: (k) => digest(`${k.host}/${k.owner}/${k.repo}#${k.number}@${k.headSha}`),
  success: SortResult,
  error: errors,
}) {}

export class OpinionKey extends Persistable.Class<{ payload: { host: string; owner: string; repo: string; number: number; headSha: string } }>()('OpinionKey', {
  primaryKey: (k) => digest(`${k.host}/${k.owner}/${k.repo}#${k.number}@${k.headSha}`),
  success: PrOpinion,
  error: errors,
}) {}

export type OverviewEntry = { readonly number: number; readonly headSha: string; readonly sort: SortResult; readonly files: ReadonlyArray<FileStat> }

export class OverviewKey extends Persistable.Class<{
  payload: { host: string; owner: string; repo: string; entries: ReadonlyArray<OverviewEntry> }
}>()('OverviewKey', {
  primaryKey: (k) => digest(`${k.host}/${k.owner}/${k.repo} stack ${k.entries[0]?.number}@${k.entries.at(-1)?.headSha}`),
  success: StackOverview,
  error: errors,
}) {}

export class PatchKey extends Persistable.Class<{ payload: { repoKey: string; mergeBase: string; headSha: string; path: string; previous?: string | undefined } }>()('PatchKey', {
  primaryKey: (k) => digest(`${k.repoKey} ${k.mergeBase}..${k.headSha} ${k.previous ? `${k.previous} => ` : ''}${k.path}`),
  success: Schema.String,
  error: GitError,
}) {}

/** Results of agent runs and diffs are immutable per head; failures are retried, never remembered. */
export const cacheOptions = {
  timeToLive: (exit: Exit.Exit<unknown, unknown>) => (Exit.isSuccess(exit) ? '30 days' : 0),
  inMemoryTTL: (exit: Exit.Exit<unknown, unknown>) => (Exit.isSuccess(exit) ? '30 days' : 0),
  inMemoryCapacity: 200,
} as const

/** Reads what a `PersistedCache` with this store id holds, without running anything; a stored failure counts as nothing. */
export const peek = Effect.fnUntraced(function* (storeId: string) {
  const store = yield* (yield* Persistence.Persistence).make({ storeId, timeToLive: cacheOptions.timeToLive })
  return <A extends Schema.Constraint, E extends Schema.Constraint>(key: Persistable.Persistable<A, E>) =>
    store.get(key).pipe(
      Effect.catchTag('SchemaError', () => Effect.undefined),
      Effect.orDie,
      Effect.map((exit): A['Type'] | undefined => (exit && Exit.isSuccess(exit) ? exit.value : undefined)),
    )
})

/** A broken store must not hide the result: storage failures become defects. */
type StoreFailure = Persistence.PersistenceError | Schema.SchemaError
const isStoreFailure = (e: unknown): e is StoreFailure => e instanceof Persistence.PersistenceError || Schema.isSchemaError(e)
export const storeFailuresDie = <A, E, R>(effect: Effect.Effect<A, E | StoreFailure, R>): Effect.Effect<A, Exclude<E, StoreFailure>, R> =>
  effect.pipe(Effect.catchIf(isStoreFailure, Effect.die)) as never

/** Reviewer state (not a cache): decision verdicts and conversations, keyed by `…#n@headSha`. */
export class Store extends Context.Service<
  Store,
  {
    readonly state: KeyValueStore.SchemaStore<typeof DecisionStates>
    readonly chats: KeyValueStore.SchemaStore<typeof Chats>
    /** Review comments not sent yet, per PR (not per head, so a push doesn't lose them). */
    readonly drafts: KeyValueStore.SchemaStore<typeof Drafts>
    /** Per PR (not per head): see LastVerdicts. */
    readonly lastVerdicts: KeyValueStore.SchemaStore<typeof LastVerdicts>
    /** Per head: what changed since an earlier verdict, set when the verdicts are carried. */
    readonly rereview: KeyValueStore.SchemaStore<typeof Rereview>
    /** Per head: what the reviewer did with each finding. */
    readonly findings: KeyValueStore.SchemaStore<typeof FindingStates>
    /** Page state between visits, opaque to the companion. */
    readonly remembered: KeyValueStore.SchemaStore<typeof Schema.String>
  }
>()('pr-review/Store') {
  /** Store plus the `Persistence` that cached services build their `PersistedCache` on. */
  static readonly layerWith = <E, R>(kvs: Layer.Layer<KeyValueStore.KeyValueStore, E, R>) =>
    Layer.merge(
      Layer.effect(
        Store,
        Effect.gen(function* () {
          const store = yield* KeyValueStore.KeyValueStore
          return Store.of({
            state: KeyValueStore.toSchemaStore(KeyValueStore.prefix(store, 'state/'), DecisionStates),
            chats: KeyValueStore.toSchemaStore(KeyValueStore.prefix(store, 'conversations/'), Chats),
            drafts: KeyValueStore.toSchemaStore(KeyValueStore.prefix(store, 'drafts/'), Drafts),
            lastVerdicts: KeyValueStore.toSchemaStore(KeyValueStore.prefix(store, 'last-verdicts/'), LastVerdicts),
            rereview: KeyValueStore.toSchemaStore(KeyValueStore.prefix(store, 'rereview/'), Rereview),
            remembered: KeyValueStore.toSchemaStore(KeyValueStore.prefix(store, 'remembered/'), Schema.String),
            findings: KeyValueStore.toSchemaStore(KeyValueStore.prefix(store, 'findings/'), FindingStates),
          })
        }),
      ),
      Persistence.layerKvs,
    ).pipe(Layer.provide(kvs))

  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const { cacheRoot } = yield* Config
      return Store.layerWith(KeyValueStore.layerFileSystem(join(cacheRoot, 'store')).pipe(Layer.provide(NodeServices.layer), Layer.orDie))
    }),
  )
}
