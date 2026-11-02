import { RegistryProvider } from '@effect/atom-react'
import { type Decision, type Draft, GitError, type PrView, type SortResult, type StackEntry, type StackEvent } from '@pr-review/domain'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Effect, Exit, Layer, Scope, Stream } from 'effect'
import { AtomsContext, makeAtoms, makeReviewClient } from '../src/atoms.ts'
import { StackPage } from '../src/stack/StackPage.tsx'
import { fakeCompanion, remembered } from './companion.ts'

const pr = (number: number): StackEntry => ({ number, title: `PR ${number}`, baseRef: 'b', headRef: 'h', headSha: `s${number}` })
const decision = (id: string, lens: Decision['lens'], theme: string): Decision => ({
  id, title: `Decision ${id}`, lens, reason: 'data-model', theme, note: 'n', existing: null, authorWhy: null, files: [{ path: `${id}.php`, ranges: [] }],
})
const result = (decisions: Decision[]): SortResult => ({
  headSha: 'h', decisions, skim: [], trusted: [], claims: [], unclaimedDecisionIds: [], lines: { decision: 1, skim: 0, trusted: 0 },
})

const ref = { host: 'github.com', owner: 'acme', repo: 'core', number: 2567 }
const scopes: Scope.Closeable[] = []
afterEach(() => scopes.splice(0).forEach((s) => Effect.runFork(Scope.close(s, Exit.void))))

const view = (number: number): PrView => ({
  number, title: `PR ${number}`, author: 'a', body: '', baseRef: 'b', headRef: 'h', headSha: `s${number}`, state: 'open',
  host: ref.host, owner: ref.owner, repo: ref.repo, baseSha: 'B', mergeBase: 'MB', defaultBranch: 'master', files: [], threads: [], checks: 'pass', stack: [], viewer: 'me',
})

const renderStack = (events: ReadonlyArray<StackEvent>, o: { getPr?: (n: number) => Effect.Effect<PrView, GitError>; drafts?: Draft[] } = {}) => {
  const saved: unknown[] = []
  const reviews: number[] = []
  const companion = fakeCompanion({
    handlers: {
      Stack: () => Stream.concat(Stream.fromIterable(events), Stream.never),
      GetPr: ({ ref }) => (o.getPr ? o.getPr(ref.number) : Effect.succeed(view(ref.number))),
      SetState: (p) => Effect.sync(() => void saved.push(p)),
      GetDrafts: () => Effect.succeed(o.drafts ?? []),
      SubmitReview: (p) => Effect.sync(() => void reviews.push(p.ref.number)),
    },
  })
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  Effect.runSync(Layer.buildWithScope(companion.server, scope))
  class TestClient extends makeReviewClient<TestClient>()(companion.protocol) {}
  render(
    <RegistryProvider>
      <AtomsContext.Provider value={makeAtoms(TestClient)}>
        <StackPage prRef={ref} />
      </AtomsContext.Provider>
    </RegistryProvider>,
  )
  return { saved, reviews }
}

test('the overview maps every PR bottom to top with what it does', async () => {
  renderStack([
    {
      entries: [
        { pr: pr(2567), status: 'done', result: { ...result([decision('money', 'architecture', 'Data model')]), summary: 'Adds credit grants.' }, error: null, state: { money: 'accepted' } },
        { pr: pr(2568), status: 'running', result: null, error: null, state: {}, step: 'Reading select-field.tsx' },
      ],
      overview: { summary: 'Adds credits.', tables: ['usage_events'], modules: [], endpoints: [], sharedLayers: [] },
    },
  ])
  const map = await screen.findByRole('list', { name: 'PRs in this stack' }, { timeout: 3000 })
  const items = within(map).getAllByRole('listitem').map((li) => li.textContent)
  expect(items[0]).toMatch(/1.*#2567.*PR 2567.*Adds credit grants\..*1 \/ 1/)
  expect(items[1]).toMatch(/2.*#2568.*PR 2568.*Reading select-field\.tsx/)
  expect(screen.getByText('Adds credits.')).toBeInTheDocument()
})

test('a stack summary that could not be written says why instead of waiting forever', async () => {
  renderStack([
    {
      entries: [{ pr: pr(2567), status: 'done', result: result([decision('money', 'architecture', 'Data model')]), error: null, state: {} }],
      overview: null,
      overviewError: 'Claude took longer than 10 minutes',
    },
  ])
  expect(await screen.findByText(/No stack summary: Claude took longer than 10 minutes/, {}, { timeout: 3000 })).toBeInTheDocument()
  expect(screen.queryByText(/follows once every PR is sorted/)).toBeNull()
})

test('the stack summary reads as name and what changed, not one string per line', async () => {
  renderStack([
    {
      entries: [{ pr: pr(2567), status: 'done', result: result([]), error: null, state: {} }],
      overview: { summary: 'Adds credits.', tables: ['company_group: new CompanyGroupEntity on the legacy table', 'No migrations in the stack'], modules: [], endpoints: [], sharedLayers: [] },
    },
  ])
  const tables = await screen.findByRole('region', { name: 'Tables' }, { timeout: 3000 })
  expect(within(tables).getAllByRole('term').map((t) => t.textContent)).toEqual(['company_group'])
  expect(within(tables).getByRole('definition').textContent).toBe('new CompanyGroupEntity on the legacy table')
  expect(within(tables).getByText('No migrations in the stack')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Modules' })).not.toBeInTheDocument()
})

test('the sidebar lists decisions under their PR', async () => {
  renderStack([
    {
      entries: [
        { pr: pr(2567), status: 'done', result: result([decision('fmt', 'quality', 'Formatting'), decision('money', 'architecture', 'Data model')]), error: null, state: {} },
        { pr: pr(2568), status: 'done', result: result([decision('meter', 'architecture', 'Data model')]), error: null, state: {} },
      ],
      overview: null,
    },
  ])
  const nav = await screen.findByRole('navigation', { name: 'Stack' }, { timeout: 3000 })
  await userEvent.click(within(nav).getByRole('button', { name: /#2567/ }))
  const first = within(nav).getByRole('group', { name: '#2567' })
  expect(within(first).getAllByRole('button').map((b) => b.textContent)).toEqual(['Decision money', 'Decision fmt'])
  expect(await screen.findByRole('heading', { name: 'Decision money' })).toBeInTheDocument()
})

test('every file in a PR is reachable: skim areas and trusted groups follow its decisions', async () => {
  const withRest: SortResult = {
    ...result([decision('money', 'architecture', 'Data model')]),
    skim: [{ area: 'Wiring', summary: 'Service registration.', files: ['services.yaml'] }],
    trusted: [{ group: 'tests', why: 'Only tests.', files: ['MoneyTest.php'] }],
  }
  renderStack([{ entries: [{ pr: pr(2567), status: 'done', result: withRest, error: null, state: {} }], overview: null }])
  const nav = await screen.findByRole('navigation', { name: 'Stack' }, { timeout: 3000 })
  await userEvent.click(within(nav).getByRole('button', { name: /#2567/ }))
  const group = within(nav).getByRole('group', { name: '#2567' })
  expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Decision money', 'Wiring', 'Tests'])
  await userEvent.keyboard('j')
  expect(await screen.findByRole('heading', { name: 'Wiring' })).toBeInTheDocument()
  expect(screen.getByText('Service registration.')).toBeInTheDocument()
})

test('the PR in view can be reviewed from its bar', async () => {
  renderStack([{ entries: [{ pr: pr(2567), status: 'done', result: result([decision('money', 'architecture', 'Data model')]), error: null, state: {} }], overview: null }])
  const nav = await screen.findByRole('navigation', { name: 'Stack' }, { timeout: 3000 })
  await userEvent.click(within(nav).getByRole('button', { name: /#2567/ }))
  await userEvent.click(await screen.findByRole('button', { name: /^Review/ }, { timeout: 3000 }))
  expect(screen.getByText('No pending comments')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
})

test('coming back to a stack opens the item the review was on', async () => {
  const events: StackEvent[] = [
    {
      entries: [
        { pr: pr(2567), status: 'done', result: result([decision('money', 'architecture', 'Data model')]), error: null, state: {} },
        { pr: pr(2568), status: 'done', result: result([decision('meter', 'architecture', 'Data model')]), error: null, state: {} },
      ],
      overview: null,
    },
  ]
  renderStack(events)
  await screen.findByRole('navigation', { name: 'Stack' }, { timeout: 3000 })
  await userEvent.keyboard(']]')
  expect(await screen.findByRole('heading', { name: 'Decision meter' })).toBeInTheDocument()
  cleanup()
  renderStack(events)
  expect(await screen.findByRole('heading', { name: 'Decision meter' }, { timeout: 3000 })).toBeInTheDocument()
})

test('a remembered item that is gone, after a push, falls back to the overview', async () => {
  remembered.set(`at:stack:${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`, JSON.stringify({ kind: 'decision', key: '2567:d:old' }))
  renderStack([{ entries: [{ pr: pr(2567), status: 'done', result: result([decision('money', 'architecture', 'Data model')]), error: null, state: {} }], overview: null }])
  expect(await screen.findByRole('list', { name: 'PRs in this stack' }, { timeout: 3000 })).toBeInTheDocument()
})

test('a PR that could not be loaded says why and can be tried again', async () => {
  let calls = 0
  renderStack([{ entries: [{ pr: pr(2567), status: 'done', result: result([decision('money', 'architecture', 'Data model')]), error: null, state: {} }], overview: null }], {
    getPr: (n) => (++calls === 1 ? Effect.fail(new GitError({ message: 'git fetch: cannot lock ref' })) : Effect.succeed(view(n))),
  })
  const nav = await screen.findByRole('navigation', { name: 'Stack' }, { timeout: 3000 })
  await userEvent.click(within(nav).getByRole('button', { name: /#2567/ }))
  expect(await screen.findByText(/cannot lock ref/, {}, { timeout: 3000 })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByRole('heading', { name: 'Decision money' }, { timeout: 3000 })).toBeInTheDocument()
})

const twoPrs: StackEvent = {
  entries: [
    { pr: pr(2567), status: 'done', result: result([decision('money', 'architecture', 'Data model'), decision('fmt', 'quality', 'Formatting')]), error: null, state: { money: 'accepted' } },
    { pr: pr(2568), status: 'done', result: result([decision('meter', 'architecture', 'Data model')]), error: null, state: {} },
  ],
  overview: null,
}

test('accepting the last open item of a PR without comments moves on to the next PR', async () => {
  renderStack([twoPrs])
  const nav = await screen.findByRole('navigation', { name: 'Stack' }, { timeout: 3000 })
  await userEvent.click(within(nav).getByRole('button', { name: /#2567/ }))
  await screen.findByRole('heading', { name: 'Decision fmt' })
  await userEvent.keyboard('a')
  await screen.findByRole('heading', { name: 'Decision meter' }, { timeout: 3000 })
  expect(screen.queryByRole('textbox', { name: 'Review summary' })).toBeNull()
})

test('with comments pending, the last accept opens the review in view, and sending it moves on to the next PR', async () => {
  const scrolled: Element[] = []
  const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
    scrolled.push(this)
  })
  onTestFinished(() => spy.mockRestore())
  const { reviews } = renderStack([twoPrs], { drafts: [{ id: 'x', path: 'fmt.php', line: 1, side: 'RIGHT', body: 'Rename this' }] })
  const nav = await screen.findByRole('navigation', { name: 'Stack' }, { timeout: 3000 })
  await userEvent.click(within(nav).getByRole('button', { name: /#2567/ }))
  await screen.findByRole('heading', { name: 'Decision fmt' })
  await userEvent.keyboard('a')
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Review summary' })).toHaveFocus(), { timeout: 3000 })
  // The Review button sits at the top of the scrolled pane; a popover anchored off-screen never shows.
  expect(scrolled).toContain(screen.getByRole('button', { name: /^Review/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Request changes' }))
  await screen.findByRole('heading', { name: 'Decision meter' }, { timeout: 3000 })
  expect(reviews).toEqual([2567])
})

test('a PR with a body lists its description first and opens on it until reviewing starts', async () => {
  renderStack([
    {
      entries: [
        { pr: { ...pr(2567), hasBody: true }, status: 'done', result: result([decision('money', 'architecture', 'Data model')]), error: null, state: {} },
        { pr: { ...pr(2568), hasBody: true }, status: 'done', result: result([decision('meter', 'architecture', 'Data model')]), error: null, state: { meter: 'accepted' } },
      ],
      overview: null,
    },
  ])
  const nav = await screen.findByRole('navigation', { name: 'Stack' }, { timeout: 3000 })
  await userEvent.click(within(nav).getByRole('button', { name: /#2567/ }))
  expect(within(within(nav).getByRole('group', { name: '#2567' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Description', 'Decision money'])
  expect(await screen.findByRole('heading', { name: 'Description' })).toBeInTheDocument()
  await userEvent.click(within(nav).getByRole('button', { name: /#2568/ }))
  expect(await screen.findByRole('heading', { name: 'Decision meter' })).toBeInTheDocument()
})

test('[ and ] move between PRs, j and k through decisions in stack order', async () => {
  renderStack([
    {
      entries: [
        { pr: pr(2567), status: 'done', result: result([decision('money', 'architecture', 'Data model')]), error: null, state: {} },
        { pr: pr(2568), status: 'done', result: result([decision('meter', 'architecture', 'Data model'), decision('fmt', 'quality', 'Formatting')]), error: null, state: { meter: 'accepted' } },
      ],
      overview: null,
    },
  ])
  await screen.findByRole('list', { name: 'PRs in this stack' }, { timeout: 3000 })
  await userEvent.keyboard(']')
  expect(await screen.findByRole('heading', { name: 'Decision money' }, { timeout: 3000 })).toBeInTheDocument()
  await userEvent.keyboard(']')
  expect(await screen.findByRole('heading', { name: 'Decision fmt' }, { timeout: 3000 })).toBeInTheDocument()
  await userEvent.keyboard('k')
  expect(await screen.findByRole('heading', { name: 'Decision meter' }, { timeout: 3000 })).toBeInTheDocument()
  await userEvent.keyboard('[[')
  expect(await screen.findByRole('heading', { name: 'Decision money' }, { timeout: 3000 })).toBeInTheDocument()
})

test('accept in the stack saves the verdict on its PR and moves to its next open item', async () => {
  const { saved } = renderStack([
    {
      entries: [
        { pr: pr(2567), status: 'done', result: result([decision('money', 'architecture', 'Data model'), decision('fmt', 'quality', 'Formatting')]), error: null, state: {} },
        { pr: pr(2568), status: 'done', result: result([decision('meter', 'architecture', 'Data model')]), error: null, state: {} },
      ],
      overview: null,
    },
  ])
  await screen.findByRole('list', { name: 'PRs in this stack' }, { timeout: 3000 })
  await userEvent.keyboard('j')
  expect(await screen.findByRole('heading', { name: 'Decision money' }, { timeout: 3000 })).toBeInTheDocument()
  await userEvent.keyboard('a')
  expect(await screen.findByRole('heading', { name: 'Decision fmt' }, { timeout: 3000 })).toBeInTheDocument()
  await waitFor(() => expect(saved).toEqual([{ ref: { ...ref, number: 2567 }, headSha: 's2567', decisionId: 'money', state: 'accepted' }]))
})

test('failed sorts say why', async () => {
  renderStack([
    {
      entries: [
        { pr: pr(2567), status: 'failed', result: null, error: 'Failed to authenticate: OAuth session expired', state: {} },
        { pr: pr(2568), status: 'failed', result: null, error: 'Failed to authenticate: OAuth session expired', state: {} },
      ],
      overview: null,
    },
  ])
  expect(await screen.findByText(/2 PRs could not be sorted: Failed to authenticate: OAuth session expired/, {}, { timeout: 3000 })).toBeInTheDocument()
})

test('running sorts show what they are working on', async () => {
  renderStack([
    {
      entries: [
        { pr: pr(2567), status: 'running', result: null, error: null, state: {}, step: 'Reading select-field.tsx' },
        { pr: pr(2568), status: 'running', result: null, error: null, state: {}, step: 'Waiting for a free Claude run (two are busy)' },
      ],
      overview: null,
    },
  ])
  const map = await screen.findByRole('list', { name: 'PRs in this stack' }, { timeout: 3000 })
  expect(within(map).getByText('Reading select-field.tsx')).toBeInTheDocument()
  expect(within(map).getByText('Waiting for a free Claude run (two are busy)')).toBeInTheDocument()
})

test('a PR not sorted yet shows the description from its body', async () => {
  renderStack([{ entries: [{ pr: { ...pr(2567), title: 'feat(console): supplier groups', description: 'The Groups section.' }, status: 'queued', result: null, error: null, state: {} }], overview: null }])
  const map = await screen.findByRole('list', { name: 'PRs in this stack' }, { timeout: 3000 })
  expect(within(map).getByRole('listitem').textContent).toMatch(/#2567supplier groupsThe Groups section\.queued/)
})

test('a stack item changed since its verdict says so', async () => {
  renderStack([
    {
      entries: [{ pr: pr(2567), status: 'done', result: result([decision('money', 'architecture', 'Data model')]), error: null, state: {}, rereview: { money: { since: 'OLD', was: 'accepted' } } }],
      overview: null,
    },
  ])
  const nav = await screen.findByRole('navigation', { name: 'Stack' }, { timeout: 3000 })
  await userEvent.click(within(nav).getByRole('button', { name: /#2567/ }))
  expect(await screen.findByText(/You accepted this on an earlier push/, undefined, { timeout: 3000 })).toBeInTheDocument()
})
