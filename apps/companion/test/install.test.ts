import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { EXTENSION_KEY, ReviewRpcs } from '@pr-review/domain'
import { makePortClient } from '@pr-review/native-messaging'
import { streamPort } from '@pr-review/native-messaging/node'
import { Effect } from 'effect'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extensionIdFromKey, firefoxHostManifest, hostManifest, installTargets } from '../src/install.ts'
import { tmp } from './helpers.ts'

const launch = { node: '/usr/bin/node', main: '/repo/apps/companion/src/main.ts', path: '/home/u/.nvm/bin:/usr/bin:/mnt/c/Program Files (x86)/x' }
const launcher = '/home/u/.local/share/pr-review/pr-review-host'

describe('install', () => {
  it('manifest allows only the given extensions: the pinned one, and store ids', () => {
    assert.strictEqual(extensionIdFromKey(EXTENSION_KEY), 'nnejfifahepalipdkodocgfjbgicngol')
    assert.deepStrictEqual(hostManifest({ path: launcher, extensionIds: ['abc', 'def'] }), {
      name: 'pr_review',
      description: 'PR Review companion',
      path: launcher,
      type: 'stdio',
      allowed_origins: ['chrome-extension://abc/', 'chrome-extension://def/'],
    })
  })

  it('firefox manifest allows only the gecko id', () => {
    assert.deepStrictEqual(firefoxHostManifest(launcher), {
      name: 'pr_review',
      description: 'PR Review companion',
      path: launcher,
      type: 'stdio',
      allowed_extensions: ['pr-review@jorrinkievit'],
    })
  })

  it('the launcher runs main.ts host with an absolute node and the installer\'s PATH', () => {
    const [script] = installTargets({ platform: 'linux', home: '/home/u', ...launch, extensionIds: ['abc'] }).files
    assert.deepStrictEqual(script, { path: launcher, content: `#!/bin/sh\nexport PATH='/home/u/.nvm/bin:/usr/bin:/mnt/c/Program Files (x86)/x'\nexec '/usr/bin/node' '/repo/apps/companion/src/main.ts' host\n`, executable: true })
  })

  it('linux targets chrome, chromium, edge and firefox', () => {
    const t = installTargets({ platform: 'linux', home: '/home/u', ...launch, extensionIds: ['abc'] })
    assert.deepStrictEqual(t.files.map((f) => f.path), [
      launcher,
      '/home/u/.config/google-chrome/NativeMessagingHosts/pr_review.json',
      '/home/u/.config/chromium/NativeMessagingHosts/pr_review.json',
      '/home/u/.config/microsoft-edge/NativeMessagingHosts/pr_review.json',
      '/home/u/.mozilla/native-messaging-hosts/pr_review.json',
    ])
    assert.strictEqual(JSON.parse(t.files[1]!.content).path, launcher)
    assert.deepStrictEqual(JSON.parse(t.files[4]!.content).allowed_extensions, ['pr-review@jorrinkievit'])
    assert.deepStrictEqual(t.registry, [])
  })

  it('macOS targets Chrome, Edge and Firefox in Application Support', () => {
    const t = installTargets({ platform: 'darwin', home: '/Users/u', ...launch, extensionIds: ['abc'] })
    assert.deepStrictEqual(t.files.map((f) => f.path).slice(1), [
      '/Users/u/Library/Application Support/Google/Chrome/NativeMessagingHosts/pr_review.json',
      '/Users/u/Library/Application Support/Microsoft Edge/NativeMessagingHosts/pr_review.json',
      '/Users/u/Library/Application Support/Mozilla/NativeMessagingHosts/pr_review.json',
    ])
  })

  it('WSL writes a bat that runs host through wsl.exe and registry entries for Chrome, Edge and Firefox', () => {
    const t = installTargets({
      platform: 'linux',
      home: '/home/u',
      ...launch,
      extensionIds: ['abc'],
      wsl: { distro: 'Ubuntu', localAppData: { linux: '/mnt/c/Users/u/AppData/Local', windows: 'C:\\Users\\u\\AppData\\Local' } },
    })
    const [script, bat, manifest, firefox] = t.files
    assert.strictEqual(script!.content, `#!/bin/sh\nexport PATH='/home/u/.nvm/bin:/usr/bin:/mnt/c/Program Files (x86)/x'\nexec '/usr/bin/node' '/repo/apps/companion/src/main.ts' host\n`)
    assert.strictEqual(bat!.path, '/mnt/c/Users/u/AppData/Local/pr-review/pr-review-host.bat')
    assert.strictEqual(bat!.content, `@wsl.exe -d Ubuntu -e ${launcher}\r\n`)
    assert.strictEqual(manifest!.path, '/mnt/c/Users/u/AppData/Local/pr-review/pr_review.json')
    assert.strictEqual(JSON.parse(manifest!.content).path, 'C:\\Users\\u\\AppData\\Local\\pr-review\\pr-review-host.bat')
    assert.strictEqual(firefox!.path, '/mnt/c/Users/u/AppData/Local/pr-review/pr_review.firefox.json')
    assert.deepStrictEqual(JSON.parse(firefox!.content).allowed_extensions, ['pr-review@jorrinkievit'])
    assert.strictEqual(JSON.parse(firefox!.content).path, 'C:\\Users\\u\\AppData\\Local\\pr-review\\pr-review-host.bat')
    assert.deepStrictEqual(t.registry, [
      { key: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\pr_review', value: 'C:\\Users\\u\\AppData\\Local\\pr-review\\pr_review.json' },
      { key: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\pr_review', value: 'C:\\Users\\u\\AppData\\Local\\pr-review\\pr_review.json' },
      { key: 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\pr_review', value: 'C:\\Users\\u\\AppData\\Local\\pr-review\\pr_review.firefox.json' },
    ])
  })
})

describe('host', () => {
  it.live('host writes nothing but frames to stdout', () =>
    Effect.gen(function* () {
      const home = tmp()
      const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
      const child = spawn(process.execPath, [main, 'host'], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
      yield* Effect.addFinalizer(() => Effect.sync(() => child.kill()))
      const client = yield* makePortClient(ReviewRpcs, Effect.sync(() => streamPort(child.stdout, child.stdin)))
      const health = yield* client.Health().pipe(Effect.timeout('10 seconds'))
      assert.match(health.version, /^\d+\.\d+\.\d+$/)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    20_000, // spawns a real node process, which is slow under a parallel turbo run
  )
})
