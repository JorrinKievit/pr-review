import { RegistryProvider } from '@effect/atom-react'
import {
  type AskEvent,
  type AskTarget,
  type Chat,
  CompanionUnavailable,
  type DecisionOpinion,
  type DeeperEvent,
  type Draft,
  type Finding,
  type FindingStates,
  type OpinionEvent,
  type PrOpinion,
  ReviewRejected,
  type Decision,
  type PrView,
  type RuleDraft,
  type SortEvent,
  type SortResult,
} from '@pr-review/domain'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Deferred, Effect, Exit, Layer, Scope, Stream } from 'effect'
import type { ReactNode } from 'react'
import { AtomsContext, makeAtoms, makeReviewClient } from '../src/atoms.ts'
import { ReviewPage } from '../src/review/ReviewPage.tsx'
import { fakeCompanion } from './companion.ts'

type MockProps = {
  fileDiff: { name: string }
  options: {
    onLineSelectionEnd: (r: { start: number; end: number; side: string; endSide: string }) => void
    onGutterUtilityClick: (r: { start: number; end: number; side: string }) => void
  }
  lineAnnotations: unknown[]
  renderAnnotation: (a: unknown) => ReactNode
  renderHeaderPrefix?: (f: unknown) => ReactNode
}
vi.mock('@pierre/diffs/react', () => ({
  FileDiff: ({ fileDiff, options, lineAnnotations, renderAnnotation, renderHeaderPrefix }: MockProps & { options: { collapsed?: boolean } }) => (
    <div>
      <div data-diffs-header="">
        {renderHeaderPrefix?.(fileDiff)}
        <div data-testid="file" data-collapsed={String(options.collapsed ?? false)}>
          {fileDiff.name}
        </div>
      </div>
      <button type="button" onClick={() => options.onLineSelectionEnd({ start: 1, end: 1, side: 'deletions', endSide: 'deletions' })}>
        select deleted line in {fileDiff.name}
      </button>
      {/* Like the real diff: the + also selects its line. */}
      <button
        type="button"
        onClick={() => {
          options.onGutterUtilityClick({ start: 2, end: 2, side: 'additions' })
          options.onLineSelectionEnd({ start: 2, end: 2, side: 'additions', endSide: 'additions' })
        }}
      >
        comment on line 2 in {fileDiff.name}
      </button>
      {lineAnnotations.map((a, i) => (
        <div key={i}>{renderAnnotation(a)}</div>
      ))}
    </div>
  ),
}))

const patch = (name: string) => `diff --git a/${name} b/${name}
index 1111111..2222222 100644
--- a/${name}
+++ b/${name}
@@ -1,1 +1,2 @@
 one
+two
`

const paths = ['api.ts', 'cohesion.ts', 'page.tsx']
const pr: PrView = {
  number: 7, title: 'Settings shell', author: 'sam', body: '', baseRef: 'master', headRef: 'h', headSha: 'HEAD1', state: 'open',
  host: 'github.com', owner: 'acme', repo: 'core', baseSha: 'B', mergeBase: 'MB', defaultBranch: 'master',
  files: paths.map((path) => ({ path, additions: 1, deletions: 0 })), threads: [], checks: 'pass', stack: [], viewer: 'jorrin',
}

const decision = (id: string, path: string): Decision => ({
  id, title: `Decision ${id}`, lens: 'architecture', reason: 'shared-layer', theme: 't', note: `note ${id}`, existing: null, authorWhy: null,
  files: [{ path, ranges: [{ start: 2, end: 2 }] }],
})

const sorted: SortResult = {
  headSha: 'HEAD1',
  decisions: [decision('one', 'api.ts'), decision('two', 'cohesion.ts')],
  skim: [{ area: 'Agenda tab', summary: 's', files: ['page.tsx'] }],
  trusted: [], claims: [], unclaimedDecisionIds: [],
  lines: { decision: 2, skim: 1, trusted: 0 },
}
const done: SortEvent = { _tag: 'Done', result: sorted, state: {} }

const ref = { host: 'github.com', owner: 'acme', repo: 'core', number: 7 }
const scopes: Scope.Closeable[] = []
afterEach(() => scopes.splice(0).forEach((s) => Effect.runFork(Scope.close(s, Exit.void))))

const ruleDraft: RuleDraft = {
  path: 'AGENTS.md',
  text: '- Reuse the shared client.',
  old: '# Rules\n\n- one\n',
  patch: 'unused',
  branch: 'rules/reuse-the-shared-client',
  title: 'Review rule: Reuse the shared client.',
}

const renderPage = (
  o: {
    sort?: Stream.Stream<SortEvent>
    getPr?: () => Effect.Effect<PrView, CompanionUnavailable>
    ask?: (p: { target: AskTarget }) => Stream.Stream<AskEvent>
    chats?: Chat[]
    refuseReview?: boolean
    description?: string
    /** The opinion cached before the page opens, and the one a run gives. */
    opinion?: { cached?: PrOpinion; run?: PrOpinion }
    deeper?: () => Stream.Stream<DeeperEvent>
  } = {},
) => {
  let drafts: ReadonlyArray<Draft> = []
  let stored = o.opinion?.cached
  let findingStates: FindingStates = {}
  const opinionRuns: boolean[] = []
  const stateCalls: unknown[] = []
  const ruleTexts: string[] = []
  const doneEvent = (opinion: PrOpinion): OpinionEvent => ({ _tag: 'Done', opinion, states: findingStates })
  const reviews: unknown[] = []
  const chats: Chat[] = [...(o.chats ?? [])]
  const setStates: unknown[] = []
  const patches: string[] = []
  const bases: string[] = []
  const companion = fakeCompanion({
    handlers: {
      GetPr: o.getPr ?? (() => Effect.succeed(pr)),
      Sort: () => o.sort ?? Stream.concat(Stream.make(done), Stream.never),
      GetFilePatch: ({ path, previous, mergeBase }) => Effect.sync(() => (patches.push(previous ? `${previous} => ${path}` : path), bases.push(mergeBase), patch(path))),
      SetState: (p) => Effect.sync(() => void setStates.push(p)),
      // Like the companion: an answered question joins its target's conversation.
      Ask: (p) => {
        let answer = ''
        return (o.ask ?? (() => Stream.make({ _tag: 'Text', delta: 'Because.' } as AskEvent, { _tag: 'Done', sessionId: 's' } as AskEvent)))(p).pipe(
          Stream.tap((e) =>
            Effect.sync(() => {
              if (e._tag === 'Text') return void (answer += e.delta)
              const at = chats.findIndex((c) => JSON.stringify(c.target) === JSON.stringify(p.target))
              const turn = { question: p.question, answer }
              if (at < 0) chats.push({ target: p.target, turns: [turn] })
              else chats[at] = { ...chats[at]!, turns: [...chats[at]!.turns, turn] }
            }),
          ),
        )
      },
      GetChats: () => Effect.sync(() => [...chats]),
      GetDrafts: () => Effect.sync(() => drafts),
      GetDescription: () => Effect.succeed(o.description ?? ''),
      SetDrafts: (p) => Effect.sync(() => void (drafts = p.drafts)),
      // Like the companion: a run is cached, and a deeper look replaces its decision in the cached opinion.
      Opinion: ({ run }) => {
        opinionRuns.push(run)
        if (run && o.opinion?.run) {
          const result = o.opinion.run
          return Stream.make({ _tag: 'Running', startedAt: new Date().toISOString(), step: 'Reading the rules' } as OpinionEvent).pipe(
            Stream.concat(Stream.fromEffect(Effect.sync(() => ((stored = result), doneEvent(result))).pipe(Effect.delay(50)))),
          )
        }
        return Stream.fromEffect(Effect.sync(() => (stored ? doneEvent(stored) : ({ _tag: 'Idle' } as OpinionEvent))))
      },
      DigDeeper: () =>
        (o.deeper?.() ?? Stream.never).pipe(
          Stream.tap((e) =>
            Effect.sync(() => {
              if (e._tag === 'Done' && stored) stored = { ...stored, decisions: stored.decisions.map((d) => (d.decisionId === e.opinion.decisionId ? e.opinion : d)) }
            }),
          ),
        ),
      DraftRule: ({ text }) => Effect.sync(() => (ruleTexts.push(text), ruleDraft)),
      SetFindingState: (p) =>
        Effect.sync(() => {
          stateCalls.push(p)
          const { [p.findingId]: _, ...rest } = findingStates
          findingStates = p.state ? { ...rest, [p.findingId]: p.state } : rest
        }),
      SubmitReview: (p) =>
        o.refuseReview
          ? Effect.fail(new ReviewRejected({ message: 'Validation Failed' }))
          : Effect.sync(() => {
              reviews.push({ ...p, comments: drafts })
              drafts = []
            }),
    },
  })
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  Effect.runSync(Layer.buildWithScope(companion.server, scope))
  class TestClient extends makeReviewClient<TestClient>()(companion.protocol) {}
  render(
    <RegistryProvider>
      <AtomsContext.Provider value={makeAtoms(TestClient)}>
        <ReviewPage prRef={ref} />
      </AtomsContext.Provider>
    </RegistryProvider>,
  )
  return { setStates, patches, bases, drafts: () => drafts, reviews, opinionRuns, stateCalls, ruleTexts }
}

const heading = (name: string) => screen.findByRole('heading', { name }, { timeout: 3000 })

test('renders only selected item files', async () => {
  renderPage()
  expect(await heading('Decision one')).toBeInTheDocument()
  await waitFor(() => expect(screen.getAllByTestId('file').map((e) => e.textContent)).toEqual(['api.ts']))
})

test('shows Unsorted until sort is done', async () => {
  const gate = Effect.runSync(Deferred.make<void>())
  renderPage({ sort: Stream.concat(Stream.make({ _tag: 'Running', startedAt: 'now' } as SortEvent), Stream.fromEffect(Effect.as(Deferred.await(gate), done))).pipe(Stream.concat(Stream.never)) })
  expect(await screen.findByText('Unsorted', {}, { timeout: 3000 })).toBeInTheDocument()
  await waitFor(() => expect(screen.getAllByTestId('file')).toHaveLength(3))
  act(() => Effect.runSync(Deferred.succeed(gate, undefined)))
  expect(await heading('Decision one')).toBeInTheDocument()
  expect(screen.queryByText('Unsorted')).not.toBeInTheDocument()
})

test('a large item shows every file expanded', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`)
  renderPage({
    getPr: () => Effect.succeed({ ...pr, files: many.map((path) => ({ path, additions: 1, deletions: 0 })) }),
    sort: Stream.concat(Stream.make({ _tag: 'Running', startedAt: 'now' } as SortEvent), Stream.never),
  })
  await waitFor(() => expect(screen.getAllByTestId('file')).toHaveLength(30), { timeout: 3000 })
  expect(screen.getAllByTestId('file').every((f) => f.dataset.collapsed === 'false')).toBe(true)
})

test('a chat answer keeps streaming after the panel closes', async () => {
  const gate = Effect.runSync(Deferred.make<void>())
  let interrupted = false
  renderPage({
    ask: () =>
      Stream.concat(
        Stream.make({ _tag: 'Text', delta: 'part one ' } as AskEvent),
        Stream.fromEffect(Deferred.await(gate)).pipe(Stream.flatMap(() => Stream.make({ _tag: 'Text', delta: 'part two' } as AskEvent, { _tag: 'Done', sessionId: 's' } as AskEvent))),
      ).pipe(Stream.onExit((exit) => Effect.sync(() => (interrupted = Exit.hasInterrupts(exit))))),
  })
  await heading('Decision one')
  await userEvent.click(screen.getByRole('button', { name: /Discuss/ }))
  await userEvent.type(screen.getByLabelText('Ask about this decision'), 'why?{Enter}')
  expect(await screen.findByText(/part one/, {}, { timeout: 3000 })).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByLabelText('Ask about this decision')).not.toBeInTheDocument())
  await new Promise((r) => setTimeout(r, 600))
  act(() => Effect.runSync(Deferred.succeed(gate, undefined)))
  await userEvent.click(screen.getByRole('button', { name: /Discuss/ }))
  expect(await screen.findByText(/part one part two/, {}, { timeout: 3000 })).toBeInTheDocument()
  expect(interrupted).toBe(false)
})

test('a question on deleted lines reads the old side, and its answer can go into the review', async () => {
  const targets: AskTarget[] = []
  const { drafts } = renderPage({
    ask: ({ target }) => (targets.push(target), Stream.make({ _tag: 'Text', delta: 'It was unused.' } as AskEvent, { _tag: 'Done', sessionId: 's' } as AskEvent)),
  })
  await heading('Decision one')
  await userEvent.click(await screen.findByRole('button', { name: 'select deleted line in api.ts' }, { timeout: 3000 }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Ask Claude' }), 'why removed?{Enter}')
  await userEvent.click(await screen.findByRole('button', { name: 'Comment with this answer' }, { timeout: 3000 }))
  expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('It was unused.')
  await userEvent.click(screen.getByRole('button', { name: 'Add to review' }))
  await waitFor(() => expect(drafts()).toEqual([expect.objectContaining({ side: 'LEFT', line: 1, body: 'It was unused.' })]))
  expect(targets[0]).toMatchObject({ side: 'LEFT', commit: 'MB' })
})

test('a comment on a line waits in the review until the review is sent', async () => {
  const { drafts, reviews } = renderPage()
  await heading('Decision one')
  await userEvent.click(await screen.findByRole('button', { name: 'comment on line 2 in api.ts' }, { timeout: 3000 }))
  expect(screen.getByRole('tab', { name: 'Comment' })).toHaveAttribute('aria-selected', 'true')
  await userEvent.type(screen.getByRole('textbox', { name: 'Comment' }), 'Use the helper')
  await userEvent.click(screen.getByRole('button', { name: 'Add to review' }))
  expect(await screen.findByText('Use the helper', {}, { timeout: 3000 })).toBeInTheDocument()
  expect(screen.getByText('Pending')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /Review/ }))
  expect(screen.getByText('1 pending comment')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Request changes' }))
  await waitFor(() => expect(reviews).toEqual([expect.objectContaining({ event: 'REQUEST_CHANGES', commitId: 'HEAD1', comments: [expect.objectContaining({ path: 'api.ts', line: 2, side: 'RIGHT', body: 'Use the helper' })] })]))
  expect(drafts()).toEqual([])
})

test('on your own PR the review can only comment', async () => {
  renderPage({ getPr: () => Effect.succeed({ ...pr, author: 'jorrin' }) })
  await heading('Decision one')
  await userEvent.click(screen.getByRole('button', { name: /Review/ }))
  expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Request changes' })).not.toBeInTheDocument()
})

test('comments already on GitHub show under their line', async () => {
  renderPage({
    getPr: () => Effect.succeed({ ...pr, threads: [{ id: 1, path: 'api.ts', line: 2, side: 'RIGHT', author: 'kees', body: 'Moved from the old page.', inReplyTo: null, createdAt: '2026-10-30T10:00:00Z' }] }),
  })
  await heading('Decision one')
  expect(await screen.findByText('Moved from the old page.', {}, { timeout: 3000 })).toBeInTheDocument()
  expect(screen.getByText('kees')).toBeInTheDocument()
})

test('a saved conversation shows on its line with the question and the answer', async () => {
  renderPage({ chats: [{ target: { _tag: 'Lines', path: 'api.ts', start: 2, end: 2, side: 'RIGHT', commit: 'HEAD1' }, turns: [{ question: 'why two?', answer: 'Because one was lonely.' }] }] })
  await heading('Decision one')
  expect(await screen.findByText('why two?', {}, { timeout: 3000 })).toBeInTheDocument()
  expect(screen.getByText('Because one was lonely.')).toBeInTheDocument()
})

test('a question on lines stays above its answer, and follow-ups go below', async () => {
  renderPage()
  await heading('Decision one')
  await userEvent.click(await screen.findByRole('button', { name: 'select deleted line in api.ts' }, { timeout: 3000 }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Ask Claude' }), 'why removed?{Enter}')
  await screen.findByText('Because.', {}, { timeout: 3000 })
  expect(screen.getByText('why removed?')).toBeInTheDocument()
  await userEvent.type(screen.getAllByRole('textbox', { name: 'Ask Claude' })[0]!, 'and then?{Enter}')
  await waitFor(() => expect(screen.getAllByText('Because.')).toHaveLength(2), { timeout: 3000 })
  expect(screen.getByText('why removed?')).toBeInTheDocument()
  expect(screen.getByText('and then?')).toBeInTheDocument()
})

test('shows what the sort is working on', async () => {
  renderPage({ sort: Stream.concat(Stream.make({ _tag: 'Running', startedAt: new Date().toISOString(), step: 'Searching for "useResource"' } as SortEvent), Stream.never) })
  expect(await screen.findByText(/Searching for "useResource"/, {}, { timeout: 3000 })).toBeInTheDocument()
})

test('accept auto-advances to next open decision', async () => {
  const { setStates } = renderPage()
  await heading('Decision one')
  await userEvent.keyboard('a')
  expect(await heading('Decision two')).toBeInTheDocument()
  await waitFor(() => expect(setStates).toEqual([expect.objectContaining({ headSha: 'HEAD1', decisionId: 'one', state: 'accepted' })]))
})

test('skim areas and trusted groups can be accepted as reviewed too', async () => {
  const { setStates } = renderPage()
  await heading('Decision one')
  await userEvent.click(screen.getByRole('button', { name: /Agenda tab/ }))
  await heading('Agenda tab')
  await userEvent.keyboard('a')
  await waitFor(() => expect(setStates).toEqual([expect.objectContaining({ decisionId: 'skim:Agenda tab', state: 'accepted' })]))
})

test('accepting the last open item opens the review to send', async () => {
  renderPage()
  await heading('Decision one')
  await userEvent.keyboard('a')
  await heading('Decision two')
  await userEvent.keyboard('a')
  await heading('Agenda tab')
  expect(screen.queryByRole('textbox', { name: 'Review summary' })).not.toBeInTheDocument()
  await userEvent.keyboard('a')
  expect(await screen.findByRole('textbox', { name: 'Review summary' }, { timeout: 3000 })).toBeInTheDocument()
})

test('a departure says what it departs from, or that no existing code was named', async () => {
  const departs = (id: string, existing: Decision['existing']): Decision => ({ ...decision(id, 'api.ts'), reason: 'departs', existing })
  renderPage({
    sort: Stream.concat(
      Stream.make({ ...done, result: { ...sorted, decisions: [departs('one', { path: 'src/Lock.php', why: 'Locks the row it updates.' }), departs('two', null)] } } as SortEvent),
      Stream.never,
    ),
  })
  await heading('Decision one')
  expect(screen.getByText('Departs from:')).toBeInTheDocument()
  expect(screen.getByText('src/Lock.php')).toBeInTheDocument()
  await userEvent.keyboard('j')
  await heading('Decision two')
  expect(screen.getByText(/did not name the existing code/)).toBeInTheDocument()
})

test('a file collapses from its header, and every file at once', async () => {
  renderPage({ sort: Stream.concat(Stream.make({ _tag: 'Running', startedAt: 'now' } as SortEvent), Stream.never) })
  await waitFor(() => expect(screen.getAllByTestId('file')).toHaveLength(3), { timeout: 3000 })
  const collapsed = () => screen.getAllByTestId('file').map((f) => f.dataset.collapsed)
  await userEvent.click(screen.getByRole('button', { name: 'Collapse api.ts' }))
  expect(collapsed()).toEqual(['true', 'false', 'false'])
  // Anywhere on the header, not only its chevron.
  await userEvent.click(screen.getAllByTestId('file')[1]!)
  expect(collapsed()).toEqual(['true', 'true', 'false'])
  await userEvent.click(screen.getAllByTestId('file')[1]!)
  await userEvent.click(screen.getByRole('button', { name: 'Collapse all files' }))
  expect(collapsed()).toEqual(['true', 'true', 'true'])
  await userEvent.click(screen.getByRole('button', { name: 'Expand all files' }))
  expect(collapsed()).toEqual(['false', 'false', 'false'])
})

test('a PR with a description opens on it, video included', async () => {
  const { container } = { container: document.body }
  renderPage({
    getPr: () => Effect.succeed({ ...pr, body: 'Shows the list.' }),
    description: '<p>Shows the list.</p><video src="https://objects.example/v.mp4" controls></video>',
  })
  expect(await heading('Description')).toBeInTheDocument()
  expect(await screen.findByText('Shows the list.', {}, { timeout: 3000 })).toBeInTheDocument()
  expect(container.querySelector('video')?.getAttribute('src')).toBe('https://objects.example/v.mp4')
  await userEvent.keyboard('j')
  expect(await heading('Decision one')).toBeInTheDocument()
})

test('a moved file shows once, as a rename, even when an older sort listed both its paths', async () => {
  const both: Decision = { ...decision('one', 'api.ts'), files: [{ path: 'old/api.ts', ranges: [] }, { path: 'api.ts', ranges: [] }] }
  const { patches } = renderPage({
    getPr: () => Effect.succeed({ ...pr, files: pr.files.map((f) => (f.path === 'api.ts' ? { ...f, previous: 'old/api.ts' } : f)) }),
    sort: Stream.concat(Stream.make({ ...done, result: { ...sorted, decisions: [both] } } as SortEvent), Stream.never),
  })
  await heading('Decision one')
  await waitFor(() => expect(patches).toContain('old/api.ts => api.ts'), { timeout: 3000 })
  expect(screen.getAllByTestId('file').map((f) => f.textContent)).toEqual(['api.ts'])
})

test('the action bar moves on to the next item', async () => {
  renderPage()
  await heading('Decision one')
  await userEvent.click(screen.getByRole('button', { name: /^Next/ }))
  expect(await heading('Decision two')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /^Next/ }))
  expect(await heading('Agenda tab')).toBeInTheDocument()
})

test('coming back to a PR opens where the review left off, with the unsent summary', async () => {
  renderPage()
  await heading('Decision one')
  await userEvent.keyboard('j')
  await heading('Decision two')
  await userEvent.click(screen.getByRole('button', { name: /Review/ }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Review summary' }), 'Nearly there')
  cleanup()
  renderPage()
  expect(await heading('Decision two')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /Review/ }))
  expect(screen.getByRole('textbox', { name: 'Review summary' })).toHaveValue('Nearly there')
})

test('decisions sharing a theme sit under one sidebar row that opens on the selected one', async () => {
  const themed = (id: string, theme: string): Decision => ({ ...decision(id, 'api.ts'), theme })
  renderPage({
    sort: Stream.concat(
      Stream.make({ ...done, result: { ...sorted, decisions: [themed('model', 'Data'), themed('client', 'API'), themed('migration', 'Data')] } } as SortEvent),
      Stream.never,
    ),
  })
  await heading('Decision model')
  const nav = screen.getByRole('navigation', { name: 'Review items' })
  // The theme of the open decision is expanded, its decisions next to each other; a lone decision needs no theme row.
  expect(within(nav).getByRole('button', { name: /^Data/ })).toHaveAttribute('aria-expanded', 'true')
  expect(within(within(nav).getByRole('group', { name: 'Data' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Decision model', 'Decision migration'])
  expect(within(nav).queryByRole('button', { name: /^API/ })).toBeNull()
  await userEvent.keyboard('j')
  expect(await heading('Decision migration')).toBeInTheDocument()
  await userEvent.keyboard('j')
  expect(await heading('Decision client')).toBeInTheDocument()
  expect(within(nav).queryByRole('group', { name: 'Data' })).toBeNull()
  await userEvent.click(within(nav).getByRole('button', { name: /^Data/ }))
  expect(await heading('Decision model')).toBeInTheDocument()
})

test('j and k move between items', async () => {
  renderPage()
  await heading('Decision one')
  await userEvent.keyboard('j')
  expect(await heading('Decision two')).toBeInTheDocument()
  await userEvent.keyboard('k')
  expect(await heading('Decision one')).toBeInTheDocument()
})

test('push back adds a comment to the review; a refused review keeps it', async () => {
  const { drafts } = renderPage({ refuseReview: true })
  await heading('Decision one')
  await userEvent.keyboard('p')
  const box = await screen.findByRole('textbox', { name: 'Comment' })
  await userEvent.type(box, 'Use the core client setup')
  await userEvent.click(screen.getByRole('button', { name: 'Add to review' }))
  await waitFor(() => expect(drafts()).toEqual([expect.objectContaining({ path: 'api.ts', line: 2, body: 'Use the core client setup' })]))
  await userEvent.click(screen.getByRole('button', { name: /Review/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Request changes' }))
  expect(await screen.findByText(/GitHub refused the review/, {}, { timeout: 3000 })).toBeInTheDocument()
  expect(drafts()).toHaveLength(1)
})

test('j and k are ignored while typing', async () => {
  renderPage()
  await heading('Decision one')
  await userEvent.keyboard('p')
  const box = await screen.findByRole('textbox', { name: 'Comment' })
  await userEvent.type(box, 'jk')
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Decision one' })).toBeInTheDocument())
})

test('without a companion, setup says why one is needed and gives the line that installs this release of it', async () => {
  renderPage({ getPr: () => Effect.fail(new CompanionUnavailable({ reason: 'not-installed' })) })
  expect(await screen.findByRole('heading', { name: 'Install the companion' }, { timeout: 3000 })).toBeInTheDocument()
  expect(screen.getByText(/don't let an extension register one itself/)).toBeInTheDocument()
  expect(screen.getByText(/^curl /).textContent).toBe('curl -fsSL https://github.com/JorrinKievit/pr-review/releases/download/v0.3.0/install.sh | sh -s -- --extension-id test-extension-id')
  expect(screen.getByRole('link', { name: /Open on GitHub/ })).toHaveAttribute('href', 'https://github.com/acme/core/pull/7/files?native=1')
})

test('a companion from another release gets the same line to update it', async () => {
  renderPage({ getPr: () => Effect.fail(new CompanionUnavailable({ reason: 'mismatch' })) })
  expect(await screen.findByRole('heading', { name: 'Update the companion' }, { timeout: 3000 })).toBeInTheDocument()
  expect(screen.getByText(/^curl /).textContent).toMatch(/v0\.3\.0\/install\.sh \| sh/)
})

test('an item changed since it was pushed back opens as a follow-up: what you said, then what changed since', async () => {
  const thread = (id: number, author: string, body: string) => ({ id, path: 'api.ts', line: 2, side: 'RIGHT' as const, author, body, inReplyTo: null, createdAt: '2026-10-28T10:00:00Z' })
  const { bases } = renderPage({
    getPr: () => Effect.succeed({ ...pr, threads: [thread(1, 'jorrin', 'Use the shared client'), thread(2, 'sam', 'Done')] }),
    sort: Stream.concat(Stream.make({ ...done, rereview: { one: { since: 'OLD', was: 'pushed-back' } } } as SortEvent), Stream.never),
  })
  await heading('Decision one')
  const followUp = screen.getByRole('region', { name: 'Follow-up' })
  within(followUp).getByText(/You pushed this back/)
  within(followUp).getByText('Use the shared client')
  expect(within(followUp).queryByText('Done')).toBeNull()
  // Earlier fetches are the unsorted list, before the sort arrived.
  await waitFor(() => expect(bases.at(-1)).toBe('OLD'))
  await userEvent.click(screen.getByRole('button', { name: 'Show the whole change' }))
  screen.getByRole('button', { name: 'Show only what changed since' })
  // Deciding again ends the follow-up.
  await userEvent.click(screen.getByRole('button', { name: /Resolved/ }))
  await heading('Decision two')
  await userEvent.click(screen.getByRole('button', { name: /Decision one/ }))
  await heading('Decision one')
  expect(screen.queryByRole('region', { name: 'Follow-up' })).toBeNull()
})

test('sidebar says how many decisions changed since you looked', async () => {
  renderPage({ sort: Stream.concat(Stream.make({ ...done, rereview: { one: { since: 'OLD', was: 'accepted' }, two: { since: 'OLD', was: 'accepted' } } } as SortEvent), Stream.never) })
  await heading('Decision one')
  screen.getByText('2 decisions changed since you looked')
})

const finding = (o: Pick<Finding, 'id' | 'decisionId' | 'severity' | 'title'> & Partial<Finding>): Finding => ({
  pr: 7, axis: 'standards', kind: 'design', take: `take ${o.id}`, evidence: [], alternative: null, comment: null, anchor: null, handledIn: null, verified: true, ...o,
})
const decisionOpinion = (decisionId: string, findings: Finding[], authorCase = `case ${decisionId}`): DecisionOpinion => ({ decisionId, authorCase, checked: null, findings, deep: false })
const opinion: PrOpinion = {
  headSha: 'HEAD1', ticket: null, ticketNote: '', stackHeads: {},
  decisions: [
    decisionOpinion(
      'one',
      [
        finding({ id: 'f1', decisionId: 'one', severity: 'ask', title: 'Name the timeout', verified: false }),
        finding({
          id: 'f2', decisionId: 'one', severity: 'should', kind: 'reuse', title: 'Use the shared client',
          evidence: [
            { ref: 'base', path: 'src/client.ts', line: 4, quote: 'export const client = make()' },
            { ref: 'docs', path: 'TanStack Query', line: 0, quote: 'one QueryClient per app' },
          ],
          alternative: 'Import client from src/client.ts.', comment: 'Could this use the shared client?', anchor: { path: 'api.ts', line: 2 },
        }),
      ],
      'Keeps the client next to its only caller.',
    ),
    decisionOpinion('two', [finding({ id: 'f3', decisionId: 'two', severity: 'blocks', title: 'Drops the permission check', handledIn: null })]),
  ],
}
const nav = () => screen.getByRole('navigation', { name: 'Review items' })
/** With no description the page opens on the findings; Decision one is next. */
const openDecisionOne = async () => {
  await heading("Claude's findings")
  await userEvent.keyboard('j')
  return heading('Decision one')
}

test('no opinion runs until the button is pressed', async () => {
  const { opinionRuns } = renderPage({ opinion: { run: opinion } })
  await heading('Decision one')
  const button = await screen.findByRole('button', { name: "Claude's opinion" }, { timeout: 3000 })
  await new Promise((r) => setTimeout(r, 100))
  expect(opinionRuns).toEqual([false])
  await userEvent.click(button)
  expect(opinionRuns.filter((r) => r)).toEqual([true])
  expect(await screen.findByText('Reading the rules', {}, { timeout: 3000 })).toBeInTheDocument()
  expect(await within(nav()).findByRole('button', { name: /Claude's findings/ }, { timeout: 3000 })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: "Claude's opinion" })).toBeNull()
})

test('findings list ranks blocks first and opens the decision', async () => {
  renderPage({ opinion: { cached: opinion } })
  await heading("Claude's findings")
  // A closed theme shows the worst open finding of its decisions; each decision shows its own once open.
  expect(within(nav()).getByRole('button', { name: /^t/ })).toHaveTextContent('Blocks')
  expect(within(nav()).getByRole('button', { name: /Claude's findings/ })).toHaveTextContent(/1.*1.*1/)
  const rows = within(screen.getByRole('list', { name: 'Findings' })).getAllByRole('button')
  expect(rows.map((r) => r.querySelector('b')?.textContent)).toEqual(['Drops the permission check', 'Use the shared client', 'Name the timeout'])
  expect(rows[0]).toHaveTextContent('Blocks merge')
  expect(rows[0]).toHaveTextContent('Decision two')
  await userEvent.click(rows[0]!)
  expect(await heading('Decision two')).toBeInTheDocument()
  expect(within(nav()).getByRole('button', { name: /Decision one/ })).toHaveTextContent('Should fix')
  expect(within(nav()).getByRole('button', { name: /Decision two/ })).toHaveTextContent('Blocks')
})

test('decision shows its findings with evidence and Use as comment saves a draft at the anchor', async () => {
  const { drafts, stateCalls } = renderPage({ opinion: { cached: opinion } })
  await openDecisionOne()
  expect(screen.getByText('Keeps the client next to its only caller.')).toBeInTheDocument()
  const shared = screen.getByRole('region', { name: 'Use the shared client' })
  within(shared).getByText('Should fix')
  within(shared).getByText('src/client.ts:4')
  within(shared).getByText('export const client = make()')
  within(shared).getByText(/TanStack Query/)
  within(shared).getByText('Import client from src/client.ts.')
  within(screen.getByRole('region', { name: 'Name the timeout' })).getByText('not verified')
  expect(within(shared).queryByText('not verified')).toBeNull()
  await userEvent.click(within(shared).getByRole('button', { name: 'Use as comment' }))
  await waitFor(() => expect(drafts()).toEqual([expect.objectContaining({ path: 'api.ts', line: 2, side: 'RIGHT', body: 'Could this use the shared client?' })]))
  await waitFor(() => expect(stateCalls).toEqual([expect.objectContaining({ headSha: 'HEAD1', findingId: 'f2', state: 'posted' })]))
})

test('dismiss folds the finding away', async () => {
  const { stateCalls } = renderPage({ opinion: { cached: opinion } })
  await openDecisionOne()
  await userEvent.click(within(screen.getByRole('region', { name: 'Name the timeout' })).getByRole('button', { name: 'Dismiss' }))
  expect(await screen.findByText('1 dismissed', {}, { timeout: 3000 })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Name the timeout' })).toBeNull()
  expect(stateCalls).toEqual([expect.objectContaining({ findingId: 'f1', state: 'dismissed' })])
})

test('dig deeper replaces the findings', async () => {
  const gate = Effect.runSync(Deferred.make<void>())
  const deep: DecisionOpinion = { ...decisionOpinion('one', [finding({ id: 'd1', decisionId: 'one', severity: 'blocks', title: 'Races the save' })]), deep: true }
  renderPage({
    opinion: { cached: opinion },
    deeper: () =>
      Stream.make({ _tag: 'Running', startedAt: new Date().toISOString(), step: 'Reading the callers' } as DeeperEvent).pipe(
        Stream.concat(Stream.fromEffect(Effect.as(Deferred.await(gate), { _tag: 'Done', opinion: deep } as DeeperEvent))),
      ),
  })
  await openDecisionOne()
  await userEvent.click(screen.getByRole('button', { name: 'Dig deeper' }))
  expect(await screen.findByText('Reading the callers', {}, { timeout: 3000 })).toBeInTheDocument()
  act(() => Effect.runSync(Deferred.succeed(gate, undefined)))
  expect(await screen.findByRole('region', { name: 'Races the save' }, { timeout: 3000 })).toBeInTheDocument()
  expect(screen.getByText('Deeper look')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Use the shared client' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Dig deeper' })).toBeNull()
})

test('stack moved line offers a re-run', async () => {
  const entry = (number: number, baseRef: string, headRef: string, headSha: string) => ({ number, title: `#${number}`, baseRef, headRef, headSha })
  const { opinionRuns } = renderPage({
    getPr: () => Effect.succeed({ ...pr, stack: [entry(7, 'master', 'h', 'HEAD1'), entry(8, 'h', 'h2', 'NEW')] }),
    opinion: { cached: { ...opinion, stackHeads: { '8': 'OLD' } }, run: opinion },
  })
  expect(await screen.findByText('The stack moved since this opinion.', {}, { timeout: 3000 })).toBeInTheDocument()
  expect(opinionRuns).not.toContain(true)
  await userEvent.click(screen.getByRole('button', { name: 'Run again' }))
  await waitFor(() => expect(opinionRuns).toContain(true))
  await waitFor(() => expect(screen.queryByText('The stack moved since this opinion.')).toBeNull())
  expect(opinionRuns.filter((r) => r)).toEqual([true])
})

test('Make it a rule on a posted finding shows the drafted patch', async () => {
  const { ruleTexts } = renderPage({ opinion: { cached: opinion } })
  await openDecisionOne()
  const shared = screen.getByRole('region', { name: 'Use the shared client' })
  expect(within(shared).queryByRole('button', { name: 'Make it a rule' })).toBeNull()
  await userEvent.click(within(shared).getByRole('button', { name: 'Use as comment' }))
  await userEvent.click(await within(shared).findByRole('button', { name: 'Make it a rule' }))
  const dialog = await within(shared).findByRole('dialog', { name: 'Make it a rule' }, { timeout: 3000 })
  expect(ruleTexts).toEqual([expect.stringContaining('Use the shared client')])
  const patchText = () => within(dialog).getByLabelText('Patch').textContent
  await waitFor(() => expect(patchText()).toContain('+- Reuse the shared client.'))
  expect(patchText()).toContain('--- a/AGENTS.md')
  expect(within(dialog).getByText('rules/reuse-the-shared-client')).toBeInTheDocument()
  expect(within(dialog).queryByText('Patch assumes a new file')).toBeNull()
  await userEvent.type(within(dialog).getByLabelText('Rule'), ' Always.')
  expect(patchText()).toContain('+- Reuse the shared client. Always.')
  await userEvent.clear(within(dialog).getByLabelText('File'))
  await userEvent.type(within(dialog).getByLabelText('File'), '.agents/api.md')
  expect(within(dialog).getByText('Patch assumes a new file')).toBeInTheDocument()
  expect(patchText()).toContain('--- /dev/null')
})

test('Make it a rule is offered on the reviewer\'s own line comments only', async () => {
  const t = (id: number, author: string) => ({ id, path: 'api.ts', line: 2, side: 'RIGHT' as const, author, body: `by ${author}`, inReplyTo: null, createdAt: '2026-10-30T10:00:00Z' })
  const { ruleTexts } = renderPage({ getPr: () => Effect.succeed({ ...pr, threads: [t(1, 'jorrin'), t(2, 'kees')] }) })
  await heading('Decision one')
  const buttons = await screen.findAllByRole('button', { name: 'Make it a rule' })
  expect(buttons).toHaveLength(1)
  await userEvent.click(buttons[0]!)
  expect(await screen.findByRole('dialog', { name: 'Make it a rule' }, { timeout: 3000 })).toBeInTheDocument()
  expect(ruleTexts).toEqual(['by jorrin'])
})
