import { type AccountStatus, defaultSettings, type Settings } from '@pr-review/domain'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Effect, Exit, Layer, Scope } from 'effect'
import { SettingsPage } from '../src/settings/SettingsPage.tsx'
import { fakeCompanion } from './companion.ts'

const scopes: Scope.Closeable[] = []
afterEach(() => {
  cleanup()
  scopes.splice(0).forEach((s) => Effect.runFork(Scope.close(s, Exit.void)))
  vi.unstubAllGlobals()
})

const setup = (o: { stored?: Settings; copy?: Settings | null; pool?: AccountStatus[] }) => {
  const storage: Record<string, unknown> = o.stored ? { settings: o.stored } : {}
  const configured: Settings[] = []
  const requested: string[][] = []
  const companion = fakeCompanion({
    handlers: { GetSettings: () => Effect.succeed(o.copy ?? null), PoolStatus: () => Effect.succeed(o.pool ?? []), Configure: ({ settings }) => Effect.sync(() => void configured.push(settings)) },
  })
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  Effect.runSync(Layer.buildWithScope(companion.server, scope))
  vi.stubGlobal('chrome', {
    storage: { local: { get: async (k: string) => (k in storage ? { [k]: storage[k] } : {}), set: async (v: Record<string, unknown>) => void Object.assign(storage, v) } },
    runtime: { connect: () => companion.hub.connect() },
    permissions: { request: async (p: { origins: string[] }) => (requested.push(p.origins), true) },
  })
  render(<SettingsPage />)
  return { storage, configured, requested }
}

test('a browser that lost its settings gets the companion copy back', async () => {
  const copy = { ...defaultSettings, hosts: ['github.com', 'git.example.com'] }
  const { storage } = setup({ copy })
  expect(await screen.findByLabelText('Hosts', {}, { timeout: 3000 })).toHaveValue('github.com\ngit.example.com')
  await waitFor(() => expect(storage.settings).toEqual(copy))
})

test('saving stores the settings, hands them to the companion and asks for the extra hosts', async () => {
  const { storage, configured, requested } = setup({ stored: defaultSettings })
  const hosts = await screen.findByLabelText('Hosts', {}, { timeout: 3000 })
  await userEvent.type(hosts, '\ngit.example.com')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Saved.', {}, { timeout: 3000 })
  const saved = { ...defaultSettings, hosts: ['github.com', 'git.example.com'] }
  expect(storage.settings).toEqual(saved)
  expect(configured).toEqual([saved])
  expect(requested).toEqual([['https://git.example.com/*']])
})

test('an account at its limit says until when it sits out', async () => {
  setup({ stored: defaultSettings, pool: [{ id: 'claude', busy: 0, until: Date.now() + 3_600_000, error: "You've hit your usage limit" }] })
  const line = await screen.findByText(/Sitting out until/, {}, { timeout: 3000 })
  expect(line).toHaveAttribute('title', "You've hit your usage limit")
})
