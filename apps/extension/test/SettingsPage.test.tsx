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

const setup = (o: { stored?: Settings; copy?: Settings | null; pool?: AccountStatus[]; silent?: boolean; storageFails?: boolean }) => {
  const storage: Record<string, unknown> = o.stored ? { settings: o.stored } : {}
  const configured: Settings[] = []
  const requested: string[][] = []
  const companion = fakeCompanion({
    handlers: { GetSettings: () => (o.silent ? Effect.never : Effect.succeed(o.copy ?? null)), PoolStatus: () => Effect.succeed(o.pool ?? []), Configure: ({ settings }) => Effect.sync(() => void configured.push(settings)) },
  })
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  Effect.runSync(Layer.buildWithScope(companion.server, scope))
  const api = {
    storage: { local: { get: async (k: string) => { if (o.storageFails) throw new Error('storage is unavailable'); return k in storage ? { [k]: storage[k] } : {} }, set: async (v: Record<string, unknown>) => void Object.assign(storage, v) } },
    runtime: { connect: () => companion.hub.connect() },
    permissions: { request: async (p: { origins: string[] }) => (requested.push(p.origins), true) },
  }
  vi.stubGlobal('chrome', api)
  vi.stubGlobal('browser', api)
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

test('a companion that never answers does not keep the page loading', async () => {
  setup({ silent: true })
  expect(await screen.findByLabelText('Hosts', {}, { timeout: 8000 })).toHaveValue('github.com')
}, 10_000)

test('storage that fails still shows the settings', async () => {
  setup({ storageFails: true })
  expect(await screen.findByLabelText('Hosts', {}, { timeout: 8000 })).toHaveValue('github.com')
}, 10_000)

test('adds a repo with a related repo and a review skill', async () => {
  const { storage } = setup({ stored: defaultSettings })
  await userEvent.click(await screen.findByRole('button', { name: 'Add repo' }))
  await userEvent.type(screen.getByLabelText('Repo'), 'github.com/o/r')
  await userEvent.type(screen.getByLabelText('Related repos'), 'github.com/o/svc: owns the API spec')
  await userEvent.type(screen.getByLabelText('Review skill'), '.agents/skills/review/SKILL.md')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Saved.', {}, { timeout: 3000 })
  expect((storage.settings as Settings).repos).toEqual({
    'github.com/o/r': { related: [{ repo: 'github.com/o/svc', note: 'owns the API spec' }], reviewSkill: '.agents/skills/review/SKILL.md' },
  })
})

test('account checkboxes set tickets and deep', async () => {
  const { storage } = setup({ stored: defaultSettings })
  await userEvent.click(await screen.findByLabelText('Can read tickets'))
  await userEvent.click(screen.getByLabelText('Use for Dig deeper'))
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Saved.', {}, { timeout: 3000 })
  expect((storage.settings as Settings).accounts[0]).toMatchObject({ tickets: true, deep: true })
})

test("saves Claude's opinion mode, the small PR threshold and a fast model", async () => {
  const { storage } = setup({ stored: defaultSettings })
  expect(await screen.findByLabelText(/^Claude's opinion/, {}, { timeout: 3000 })).toHaveValue('automatic')
  expect(screen.getByLabelText(/^Small PR threshold/)).toHaveValue(200)
  await userEvent.selectOptions(screen.getByLabelText(/^Claude's opinion/), 'on-demand')
  await userEvent.clear(screen.getByLabelText(/^Small PR threshold/))
  await userEvent.type(screen.getByLabelText(/^Small PR threshold/), '120')
  await userEvent.type(screen.getByLabelText(/^Fast model/), 'haiku')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Saved.', {}, { timeout: 3000 })
  const saved = storage.settings as Settings
  expect(saved.review).toMatchObject({ opinions: 'on-demand', smallPrLines: 120 })
  expect(saved.accounts[0]).toMatchObject({ fastModel: 'haiku' })
})
