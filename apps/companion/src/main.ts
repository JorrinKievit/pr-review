import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { GECKO_ID } from '@pr-review/domain'
import { portServer } from '@pr-review/native-messaging'
import { singlePort, streamPort } from '@pr-review/native-messaging/node'
import { Console, Effect, FileSystem, Layer, Logger } from 'effect'
import { Command, Flag } from 'effect/cli'
import { join } from 'node:path'
import { Acp } from './Acp.ts'
import { Agent } from './Agent.ts'
import { Asker } from './Asker.ts'
import { Config, defaultCacheRoot } from './Config.ts'
import { Git } from './Git.ts'
import { GitHub } from './GitHub.ts'
import { CompanionRpcs, HandlersLive, LoggedLive, VERSION } from './handlers.ts'
import { defaultExtensionId, install } from './install.ts'
import { Overview } from './Overview.ts'
import { Sorter } from './Sorter.ts'
import { Store } from './Store.ts'

const services = Layer.mergeAll(Sorter.layer, Asker.layer, Overview.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Git.layer, GitHub.layer, Store.layer)),
  Layer.provideMerge(Agent.layer.pipe(Layer.provide(Acp.layer))),
  Layer.provideMerge(Git.layer),
)

/** stdout carries frames only, so logs go to a file. */
const fileLogger = Logger.layer([Logger.toFile(Logger.formatSimple, join(defaultCacheRoot, 'host.log'))]).pipe(
  Layer.provide(
    Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Effect.ignore((yield* FileSystem.FileSystem).makeDirectory(defaultCacheRoot, { recursive: true }))
      }),
    ),
  ),
)

const host = Command.make('host', {}, () =>
  Effect.gen(function* () {
    const port = streamPort(process.stdin, process.stdout)
    const server = portServer(CompanionRpcs, HandlersLive.pipe(Layer.provide(services)), singlePort(port)).pipe(Layer.provide(LoggedLive))
    yield* Effect.log(`host ${VERSION} started`)
    // The browser closes stdin when the last port disconnects; that is the host's cue to exit.
    yield* Layer.launch(server).pipe(Effect.raceFirst(Effect.callback<void>((resume) => port.onDisconnect.addListener(() => resume(Effect.void)))))
    yield* Effect.log('host stopped')
  }).pipe(
    Effect.provide(Config.layer),
    Effect.provide(fileLogger),
  ),
).pipe(Command.withDescription('Run the native messaging host (the browser starts this)'))

const installCommand = Command.make(
  'install',
  {
    extensionIds: Flag.String('extension-id').pipe(
      Flag.withDefault(''),
      Flag.withDescription('Comma-separated Chrome Web Store or Edge Add-ons ids allowed to connect, besides the unpacked build'),
    ),
  },
  ({ extensionIds }) =>
    Effect.gen(function* () {
      const ids = [defaultExtensionId, ...extensionIds.split(',').map((id) => id.trim()).filter(Boolean)]
      const plan = yield* install(ids)
      for (const f of plan.files) yield* Console.log(`Wrote ${f.path}`)
      for (const r of plan.registry) yield* Console.log(`Registered ${r.key}`)
      yield* Console.log(`Chromium extensions ${ids.join(', ')} and Firefox extension ${GECKO_ID} can now start the companion.`)
    }),
).pipe(Command.withDescription('Register the native messaging host with Chrome, Chromium, Edge and Firefox'))

Command.make('pr-review').pipe(
  Command.withSubcommands([installCommand, host]),
  Command.run({ version: VERSION }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
