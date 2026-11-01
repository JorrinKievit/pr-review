import { defaultSettings, RepoNotConfigured, Settings } from '@pr-review/domain'
import { Context, Effect, FileSystem, Layer, Option, Ref, Schema } from 'effect'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type RepoConfig = { readonly key: string; readonly remoteUrl: string }

export const defaultSettingsFile = join(homedir(), '.config', 'pr-review', 'settings.json')
export const defaultCacheRoot = join(homedir(), '.cache', 'pr-review')

const SettingsJson = Schema.fromJsonString(Settings)

/**
 * The settings the extension sent, kept on disk too: the host starts before the extension configures it,
 * and a Firefox temporary add-on loses its storage on restart.
 */
export class Config extends Context.Service<
  Config,
  {
    readonly cacheRoot: string
    readonly settings: Effect.Effect<Settings>
    configure(settings: Settings): Effect.Effect<void>
    /** The copy from the last Configure, or null before the first. */
    readonly saved: Effect.Effect<Settings | null>
    /** A repo on one of the configured hosts. */
    repo(key: string): Effect.Effect<RepoConfig, RepoNotConfigured>
  }
>()('pr-review/Config') {
  private static make = (o: { cacheRoot: string; initial: Settings | null; remotes?: Record<string, string>; persist: (s: Settings) => Effect.Effect<void> }) =>
    Effect.gen(function* () {
      const saved = yield* Ref.make(o.initial)
      const settings = Effect.map(Ref.get(saved), (s) => s ?? defaultSettings)
      return Config.of({
        cacheRoot: o.cacheRoot,
        settings,
        saved: Ref.get(saved),
        configure: (s) => Effect.andThen(Ref.set(saved, s), o.persist(s)),
        repo: (key) =>
          Effect.flatMap(settings, (s) =>
            s.hosts.includes(key.split('/')[0]!) || o.remotes?.[key]
              ? Effect.succeed({ key, remoteUrl: o.remotes?.[key] ?? `https://${key}.git` })
              : Effect.fail(new RepoNotConfigured({ key })),
          ),
      })
    })

  /** `remotes` points repos at local clones in tests. */
  static readonly layerTest = (o: { cacheRoot: string; settings?: Settings; remotes?: Record<string, string> }) =>
    Layer.effect(Config, Config.make({ cacheRoot: o.cacheRoot, initial: o.settings ?? null, ...(o.remotes ? { remotes: o.remotes } : {}), persist: () => Effect.void }))

  static readonly layerFile = (file: string, cacheRoot: string) =>
    Layer.effect(
      Config,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const initial = yield* fs.readFileString(file).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(SettingsJson)),
          Effect.option,
          Effect.map(Option.getOrNull),
        )
        const persist = (s: Settings) =>
          Effect.andThen(fs.makeDirectory(dirname(file), { recursive: true }), fs.writeFileString(file, JSON.stringify(s, null, 2) + '\n')).pipe(
            Effect.catch((e) => Effect.logWarning(`Could not save settings to ${file}: ${e.message}`)),
          )
        return yield* Config.make({ cacheRoot, initial, persist })
      }),
    )

  static readonly layer = Config.layerFile(defaultSettingsFile, defaultCacheRoot)
}
