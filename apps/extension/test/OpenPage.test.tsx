import { RegistryProvider } from '@effect/atom-react'
import type { PrView } from '@pr-review/domain'
import { render, waitFor } from '@testing-library/react'
import { Effect, Exit, Layer, Scope } from 'effect'
import { AtomsContext, makeAtoms, makeReviewClient } from '../src/atoms.ts'
import { OpenPage } from '../src/OpenPage.tsx'
import { fakeCompanion } from './companion.ts'

const ref = { host: 'github.com', owner: 'acme', repo: 'core', number: 7 }
const entry = (number: number) => ({ number, title: `#${number}`, baseRef: 'b', headRef: 'h', headSha: 's' })
const pr = (stack: PrView['stack']): PrView => ({
  number: 7, title: 't', author: 'a', body: '', baseRef: 'master', headRef: 'h', headSha: 'H', state: 'open',
  host: ref.host, owner: ref.owner, repo: ref.repo, baseSha: 'B', mergeBase: 'MB', defaultBranch: 'master', files: [], threads: [], checks: 'pass', stack, viewer: 'me',
})
const scopes: Scope.Closeable[] = []
afterEach(() => scopes.splice(0).forEach((s) => Effect.runFork(Scope.close(s, Exit.void))))

const open = (view: PrView) => {
  const companion = fakeCompanion({ handlers: { GetPr: () => Effect.succeed(view) } })
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  Effect.runSync(Layer.buildWithScope(companion.server, scope))
  class TestClient extends makeReviewClient<TestClient>()(companion.protocol) {}
  const go = vi.fn()
  render(
    <RegistryProvider>
      <AtomsContext.Provider value={makeAtoms(TestClient)}>
        <OpenPage prRef={ref} go={go} />
      </AtomsContext.Provider>
    </RegistryProvider>,
  )
  return go
}

test('a stacked PR opens the stack view', async () => {
  const go = open(pr([entry(7), entry(8)]))
  await waitFor(() => expect(go).toHaveBeenCalledWith('stack'), { timeout: 3000 })
})

test('a single PR opens the PR view', async () => {
  const go = open(pr([entry(7)]))
  await waitFor(() => expect(go).toHaveBeenCalledWith('pr'), { timeout: 3000 })
})
