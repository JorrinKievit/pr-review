import { type AgentAccount, AgentError, type AgentSort, defaultSettings, type FileStat, GitError, type PrMeta, type StackOverview } from '@pr-review/domain'
import { Effect, Layer, Schema, Stream } from 'effect'
import { Agent } from '../src/Agent.ts'
import { Config } from '../src/Config.ts'
import { Git } from '../src/Git.ts'
import { GitHub, type GitHubClient } from '../src/GitHub.ts'

export const ref = { host: 'h', owner: 'o', repo: 'r', number: 7 }
export const repoKey = 'h/o/r'

export const configLayer = (cacheRoot = '/cache') => Config.layerTest({ cacheRoot, settings: { ...defaultSettings, hosts: [ref.host] } })

/** Session turns carry their session (numbered from 1), account, index in the session (from 0) and the model asked for. */
export type AgentCall = {
  prompt: string
  cwd: string
  related?: ReadonlyArray<string>
  prefer?: 'deep'
  resume?: string
  log: { kind: string; number: number }
  session?: number
  account?: string
  turn?: number
  model?: 'fast' | 'main'
  onText?: (line: string) => Effect.Effect<void>
}

export const fakeAccount: AgentAccount = { id: 'fake', name: 'Fake', agent: 'custom', command: 'x', env: {}, concurrency: 1, enabled: true }
export const fakeAccount2: AgentAccount = { ...fakeAccount, id: 'fake2', name: 'Fake 2' }

/**
 * An Agent whose structured runs and session turns answer with `reply()`, streaming runs emit `Hi` then Done, and ticket runs answer with `ticket()` (default: no ticket account).
 * A session takes the first `pool` account it doesn't avoid; `idle()` lists the whole pool.
 */
export const fakeAgent = (
  reply: (call: AgentCall) => Effect.Effect<unknown, any> = () => Effect.succeed({ decisions: [], skim: [], claims: [] } satisfies AgentSort),
  ticket: (prompt: string) => Effect.Effect<string, AgentError> = () => Effect.fail(new AgentError({ message: 'No AI account is set to read tickets' })),
  pool: ReadonlyArray<AgentAccount> = [fakeAccount],
) => {
  const calls: AgentCall[] = []
  let sessions = 0
  const ticketPrompts: string[] = []
  const ticketModels: Array<'fast' | 'main' | undefined> = []
  const answer = (call: AgentCall, onStep: ((s: string) => Effect.Effect<void>) | undefined, schema: Schema.Top) =>
    Effect.suspend(() => {
      calls.push(call)
      return (onStep?.('Searching for "x"') ?? Effect.void).pipe(
        Effect.andThen(reply(call)),
        Effect.flatMap((x) => Effect.orDie(Schema.decodeUnknownEffect(schema as Schema.Codec<unknown>)(x))),
      )
    })
  const layer = Layer.succeed(
    Agent,
    Agent.of({
      structured: (o) => answer(o, o.onStep, o.schema) as never,
      session: (o, use) =>
        Effect.suspend(() => {
          const session = ++sessions
          const account = pool.find((a) => !o.avoid?.has(a.id)) ?? fakeAccount
          let turn = 0
          return use(
            {
              structured: (prompt, schema, model = 'main', turnKind) =>
                answer({ ...o, prompt, session, account: account.id, turn: turn++, model, log: turnKind ? { ...o.log, kind: turnKind } : o.log }, o.onStep, schema) as never,
            },
            account,
          )
        }),
      idle: () => Effect.succeed(pool),
      streaming: (o) =>
        Stream.suspend(() => {
          calls.push(o)
          return Stream.make({ _tag: 'Text' as const, delta: 'Hi' }, { _tag: 'Done' as const, sessionId: 'sess-1' })
        }),
      ticket: (o) => Effect.suspend(() => (ticketPrompts.push(o.prompt), ticketModels.push(o.model), ticket(o.prompt))),
      status: Effect.succeed([]),
    }),
  )
  return { calls, ticketPrompts, ticketModels, layer }
}

export const overviewReply: StackOverview = { summary: 's', tables: [], modules: [], endpoints: [], sharedLayers: [] }

export const fakeGit = (o: { files?: FileStat[]; diff?: string | ((from: string, to: string, paths: ReadonlyArray<string>) => string); /** One text for every file, or texts keyed `ref:path` (others fail). */ show?: string | Record<string, string>; rules?: string[] } = {}) => {
  const diffPaths: Array<ReadonlyArray<string>> = []
  const shown: string[] = []
  const listed: Array<ReadonlyArray<string>> = []
  const layer = Layer.succeed(
    Git,
    Git.of({
      dir: () => '/cache/repo.git',
      ensureClone: () => Effect.void,
      fetchPr: () => Effect.succeed({ headSha: 'HEAD1', baseSha: 'BASE1', mergeBase: 'MB1' }),
      numstat: () => Effect.succeed(o.files ?? []),
      diff: (_k, from, to, paths = []) => Effect.sync(() => (diffPaths.push(paths), typeof o.diff === 'function' ? o.diff(from, to, paths) : (o.diff ?? ''))),
      show: (_k, ref, path) =>
        Effect.suspend(() => {
          shown.push(ref)
          if (typeof o.show !== 'object') return Effect.succeed(o.show ?? '')
          const text = o.show[`${ref}:${path}`]
          return text === undefined ? Effect.fail(new GitError({ message: `no ${ref}:${path}` })) : Effect.succeed(text)
        }),
      lsTree: (_k, _ref, paths) => Effect.sync(() => (listed.push(paths), o.rules ?? [])),
      defaultBranch: () => Effect.succeed('master'),
    }),
  )
  return { diffPaths, shown, listed, layer }
}

export const pr: PrMeta = { number: 7, title: 'Add a thing', author: 'dev', body: '## Decisions\n- one', baseRef: 'master', headRef: 'feat', headSha: 'HEAD1', state: 'open' }

export const fakeGitHub = (overrides: Partial<GitHubClient> = {}) =>
  Layer.succeed(
    GitHub,
    GitHub.of({
      forHost: () =>
        Effect.succeed({
          getPr: () => Effect.succeed(pr),
          getChecks: () => Effect.succeed('pass' as const),
          listOpenPrs: () => Effect.succeed([]),
          listThreads: () => Effect.succeed([]),
          viewer: () => Effect.succeed('me'),
          requestedReviewers: () => Effect.succeed([]),
          fileAt: () => Effect.undefined,
          getIssue: () => Effect.succeed(null),
          description: () => Effect.succeed(''),
          submitReview: () => Effect.die('unused'),
          ...overrides,
        } satisfies GitHubClient),
    }),
  )
