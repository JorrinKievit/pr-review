import { registerHosts } from '../src/hosts.ts'

afterEach(() => vi.unstubAllGlobals())

test('only granted hosts besides github.com get the content script, and a second call replaces the first', async () => {
  let scripts: Array<{ id: string; matches: string[] }> = []
  vi.stubGlobal('chrome', {
    permissions: { contains: async (p: { origins: string[] }) => p.origins[0] !== 'https://denied.example/*' },
    scripting: {
      getRegisteredContentScripts: async ({ ids }: { ids: string[] }) => scripts.filter((s) => ids.includes(s.id)),
      unregisterContentScripts: async ({ ids }: { ids: string[] }) => void (scripts = scripts.filter((s) => !ids.includes(s.id))),
      registerContentScripts: async (s: Array<{ id: string; matches: string[] }>) => {
        if (s.some((x) => scripts.some((y) => y.id === x.id))) throw new Error('Duplicate script ID')
        scripts.push(...s)
      },
    },
  })
  await registerHosts(['github.com', 'git.example.com', 'denied.example'])
  expect(scripts.map((s) => s.matches)).toEqual([['https://git.example.com/*/*/pull/*']])
  await registerHosts(['github.com', 'other.example'])
  expect(scripts.map((s) => s.matches)).toEqual([['https://other.example/*/*/pull/*']])
  await registerHosts(['github.com'])
  expect(scripts).toEqual([])
})
