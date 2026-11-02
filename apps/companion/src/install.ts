import { EXTENSION_KEY, GECKO_ID, HOST_NAME } from '@pr-review/domain'
import { Effect, FileSystem, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Chrome's id for an extension: the first 32 hex digits of sha256(public key), mapped 0-f to a-p. */
export const extensionIdFromKey = (key: string) =>
  [...createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')

const baseManifest = (path: string) => ({ name: HOST_NAME, description: 'PR Review companion', path, type: 'stdio' })
export const hostManifest = (o: { path: string; extensionIds: ReadonlyArray<string> }) => ({ ...baseManifest(o.path), allowed_origins: o.extensionIds.map((id) => `chrome-extension://${id}/`) })
export const firefoxHostManifest = (path: string) => ({ ...baseManifest(path), allowed_extensions: [GECKO_ID] })

export type Wsl = { distro: string; localAppData: { linux: string; windows: string } }
export type InstallPlan = {
  files: ReadonlyArray<{ path: string; content: string; executable?: boolean }>
  registry: ReadonlyArray<{ key: string; value: string }>
}

const manifestFile = `${HOST_NAME}.json`
const firefoxManifestFile = `${HOST_NAME}.firefox.json`

/**
 * Browsers start the host with a bare PATH, so the launcher names node by absolute path.
 * Chromium browsers share one manifest, Firefox gets its own. Under WSL the browser runs on Windows: both point at a .bat
 * that enters the distro, registered in HKCU.
 */
export function installTargets(o: { platform: NodeJS.Platform; home: string; node: string; main: string; extensionIds: ReadonlyArray<string>; wsl?: Wsl }): InstallPlan {
  const launcher = join(o.home, '.local', 'share', 'pr-review', 'pr-review-host')
  const script = { path: launcher, content: `#!/bin/sh\nexec '${o.node}' '${o.main}' host\n`, executable: true }
  const manifest = (path: string) => JSON.stringify(hostManifest({ path, extensionIds: o.extensionIds }), null, 2)
  const firefox = (path: string) => JSON.stringify(firefoxHostManifest(path), null, 2)

  if (o.wsl) {
    const dir = { linux: `${o.wsl.localAppData.linux}/pr-review`, windows: `${o.wsl.localAppData.windows}\\pr-review` }
    return {
      files: [
        script,
        { path: `${dir.linux}/pr-review-host.bat`, content: `@wsl.exe -d ${o.wsl.distro} -e ${launcher}\r\n` },
        { path: `${dir.linux}/${manifestFile}`, content: manifest(`${dir.windows}\\pr-review-host.bat`) },
        { path: `${dir.linux}/${firefoxManifestFile}`, content: firefox(`${dir.windows}\\pr-review-host.bat`) },
      ],
      registry: [
        { key: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, value: `${dir.windows}\\${manifestFile}` },
        { key: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`, value: `${dir.windows}\\${manifestFile}` },
        { key: `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`, value: `${dir.windows}\\${firefoxManifestFile}` },
      ],
    }
  }
  const mac = o.platform === 'darwin'
  const chromeDirs = mac
    ? [join(o.home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'), join(o.home, 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts')]
    : [
        join(o.home, '.config', 'google-chrome', 'NativeMessagingHosts'),
        join(o.home, '.config', 'chromium', 'NativeMessagingHosts'),
        join(o.home, '.config', 'microsoft-edge', 'NativeMessagingHosts'),
      ]
  const firefoxDir = mac ? join(o.home, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts') : join(o.home, '.mozilla', 'native-messaging-hosts')
  return {
    files: [
      script,
      ...chromeDirs.map((d) => ({ path: join(d, manifestFile), content: manifest(launcher) })),
      { path: join(firefoxDir, manifestFile), content: firefox(launcher) },
    ],
    registry: [],
  }
}

const output = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return (yield* spawner.string(ChildProcess.make(command, args))).trim()
  })

const detectWsl = Effect.gen(function* () {
  const distro = process.env.WSL_DISTRO_NAME
  if (!distro) return undefined
  const windows = (yield* output('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'])).replace(/\r/g, '')
  return { distro, localAppData: { windows, linux: yield* output('wslpath', ['-u', windows]) } } satisfies Wsl
})

export const install = Effect.fn('install')(function* (extensionIds: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const wsl = yield* detectWsl
  const plan = installTargets({
    platform: process.platform,
    home: homedir(),
    node: process.execPath,
    // The file this runs from: src/main.ts in a checkout, dist/main.mjs from a release.
    main: realpathSync(process.argv[1]!),
    extensionIds,
    ...(wsl ? { wsl } : {}),
  })
  for (const f of plan.files) {
    yield* fs.makeDirectory(dirname(f.path), { recursive: true })
    yield* fs.writeFileString(f.path, f.content)
    if (f.executable) yield* fs.chmod(f.path, 0o755)
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  for (const r of plan.registry) yield* spawner.exitCode(ChildProcess.make('reg.exe', ['add', r.key, '/ve', '/t', 'REG_SZ', '/d', r.value, '/f']))
  return plan
})

export const defaultExtensionId = extensionIdFromKey(EXTENSION_KEY)
