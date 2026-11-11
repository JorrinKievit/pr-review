import { type Checks, type Draft, GitHubError, type PrMeta, ReviewRejected, type StackEntry, type Thread } from '@pr-review/domain'
import { Cache, Context, Duration, Effect, Exit, Layer, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { Octokit, RequestError } from 'octokit'
import { description } from './description.ts'

export const apiUrlFor = (host: string) => (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`)

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

export interface GitHubClient {
  getPr(owner: string, repo: string, n: number): Effect.Effect<PrMeta, GitHubError>
  listOpenPrs(owner: string, repo: string): Effect.Effect<ReadonlyArray<StackEntry>, GitHubError>
  listThreads(owner: string, repo: string, n: number): Effect.Effect<ReadonlyArray<Thread>, GitHubError>
  getChecks(owner: string, repo: string, sha: string): Effect.Effect<Checks, GitHubError>
  /** The body as GitHub renders it to HTML; not cached, its media links expire after five minutes. */
  description(owner: string, repo: string, n: number): Effect.Effect<string, GitHubError>
  /** Raw file text at `ref` (default branch when omitted); undefined when it does not exist. */
  fileAt(owner: string, repo: string, path: string, ref?: string): Effect.Effect<string | undefined, GitHubError>
  /** An issue's title and body; null when it is a pull request or does not exist. */
  getIssue(owner: string, repo: string, n: number): Effect.Effect<{ title: string; body: string } | null, GitHubError>
  /** The login the token belongs to. */
  viewer(): Effect.Effect<string, GitHubError>
  submitReview(
    owner: string,
    repo: string,
    n: number,
    r: { event: ReviewEvent; body: string; commitId: string; comments: ReadonlyArray<Draft> },
  ): Effect.Effect<void, GitHubError | ReviewRejected>
}

type RawComment = {
  id: number
  path: string
  line?: number | null
  side?: 'LEFT' | 'RIGHT'
  user: { login: string } | null
  body: string
  in_reply_to_id?: number | null
  created_at: string
}

const toThread = (c: RawComment): Thread => ({
  id: c.id,
  path: c.path,
  line: c.line ?? null,
  side: c.side ?? 'RIGHT',
  author: c.user?.login ?? 'ghost',
  body: c.body,
  inReplyTo: c.in_reply_to_id ?? null,
  createdAt: c.created_at,
})

const call = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => (e instanceof RequestError ? new GitHubError({ status: e.status, message: e.message }) : new GitHubError({ status: 0, message: String(e) })),
  })

const successFor = (ttl: Duration.Input) => (exit: Exit.Exit<unknown, unknown>) => (Exit.isSuccess(exit) ? ttl : 0)

/** Reads go through a 30-second cache so page reloads and stack walks don't hammer the API. */
const cachedRead = <A>(lookup: (args: ReadonlyArray<string | number>) => Effect.Effect<A, GitHubError>) =>
  Cache.makeWith((key: string) => lookup(JSON.parse(key)), { capacity: 512, timeToLive: successFor('30 seconds') }).pipe(
    Effect.map((cache) =>
      Object.assign((...args: ReadonlyArray<string | number>) => Cache.get(cache, JSON.stringify(args)), {
        invalidate: (...args: ReadonlyArray<string | number>) => Cache.invalidate(cache, JSON.stringify(args)),
      }),
    ),
  )

export const makeClient = Effect.fnUntraced(function* (octokit: Octokit) {
  const getPr = yield* cachedRead(([owner, repo, n]) =>
    call(() => octokit.rest.pulls.get({ owner: String(owner), repo: String(repo), pull_number: Number(n) })).pipe(
      Effect.map(({ data: p }): PrMeta => ({
        number: p.number,
        title: p.title,
        author: p.user?.login ?? 'ghost',
        body: p.body ?? '',
        baseRef: p.base.ref,
        headRef: p.head.ref,
        headSha: p.head.sha,
        state: p.state,
      })),
    ),
  )
  type OpenPrs = {
    repository: {
      pullRequests: {
        nodes: Array<{ number: number; title: string; body: string; headRefName: string; baseRefName: string; headRefOid: string }>
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }
    }
  }
  // GraphQL: a quarter of the bytes REST sends for the same list, so about twice as fast.
  const openPrsQuery = `query($owner: String!, $repo: String!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(states: OPEN, first: 100, after: $after) {
        nodes { number title body headRefName baseRefName headRefOid }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`
  const listOpenPrs = yield* cachedRead(([owner, repo]) =>
    Effect.gen(function* () {
      const prs: StackEntry[] = []
      let after: string | null = null
      do {
        const page: OpenPrs['repository']['pullRequests'] = (yield* call(() => octokit.graphql<OpenPrs>(openPrsQuery, { owner, repo, after }))).repository.pullRequests
        for (const p of page.nodes) {
          const text = p.body ? description(p.body) : undefined
          prs.push({
            number: p.number,
            title: p.title,
            headRef: p.headRefName,
            baseRef: p.baseRefName,
            headSha: p.headRefOid,
            hasBody: Boolean(p.body.trim()),
            ...(text ? { description: text } : {}),
          })
        }
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
      } while (after)
      return prs
    }),
  )
  const listThreads = yield* cachedRead(([owner, repo, n]) =>
    call(() => octokit.paginate(octokit.rest.pulls.listReviewComments, { owner: String(owner), repo: String(repo), pull_number: Number(n), per_page: 100 })).pipe(
      Effect.map((cs) => cs.map(toThread)),
    ),
  )
  const getChecks = yield* cachedRead(([owner, repo, sha]) =>
    call(() => octokit.rest.checks.listForRef({ owner: String(owner), repo: String(repo), ref: String(sha), per_page: 100 })).pipe(
      Effect.map(({ data }): Checks => {
        const runs = data.check_runs
        if (runs.length === 0) return 'none'
        if (runs.some((c) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion ?? ''))) return 'fail'
        if (runs.some((c) => c.status !== 'completed')) return 'pending'
        return 'pass'
      }),
    ),
  )

  const viewer = yield* Cache.makeWith(() => call(() => octokit.rest.users.getAuthenticated()).pipe(Effect.map(({ data }) => data.login)), {
    capacity: 1,
    timeToLive: successFor(Infinity),
  })

  return {
    getPr: (owner, repo, n) => getPr(owner, repo, n),
    listOpenPrs: (owner, repo) => listOpenPrs(owner, repo),
    listThreads: (owner, repo, n) => listThreads(owner, repo, n),
    getChecks: (owner, repo, sha) => getChecks(owner, repo, sha),
    viewer: () => Cache.get(viewer, 'me'),
    fileAt: (owner, repo, path, ref) =>
      call(() => octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path, ...(ref ? { ref } : {}), mediaType: { format: 'raw' } })).pipe(
        Effect.map(({ data }) => (typeof data === 'string' ? data : undefined)),
        Effect.catchIf((e) => e.status === 404, () => Effect.undefined),
      ),
    getIssue: (owner, repo, n) =>
      call(() => octokit.rest.issues.get({ owner, repo, issue_number: n })).pipe(
        Effect.map(({ data }) => (data.pull_request ? null : { title: data.title, body: data.body ?? '' })),
        Effect.catchIf((e) => e.status === 404, () => Effect.succeed(null)),
      ),
    description: (owner, repo, n) =>
      call(() => octokit.rest.pulls.get({ owner, repo, pull_number: n, mediaType: { format: 'html' } })).pipe(Effect.map(({ data }) => (data as { body_html?: string | null }).body_html ?? '')),
    submitReview: (owner, repo, n, r) =>
      call(() =>
        octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: n,
          event: r.event,
          body: r.body,
          commit_id: r.commitId,
          comments: r.comments.map((c) => ({
            path: c.path,
            line: c.line,
            side: c.side,
            ...(c.startLine !== undefined && c.startLine !== c.line ? { start_line: c.startLine, start_side: c.side } : {}),
            body: c.body,
          })),
        }),
      ).pipe(
        // 422 usually means a commented line is no longer in the PR.
        Effect.mapError((e) => (e.status === 422 ? new ReviewRejected({ message: e.message }) : e)),
        Effect.andThen(listThreads.invalidate(owner, repo, n)),
      ),
  } satisfies GitHubClient
})

export class GitHub extends Context.Service<GitHub, { forHost(host: string): Effect.Effect<GitHubClient, GitHubError> }>()('pr-review/GitHub') {
  /** Clients from `octokitFor`, one per host, kept for the process lifetime once built. */
  static readonly layerWith = <R>(octokitFor: (host: string) => Effect.Effect<Octokit, GitHubError, R>) =>
    Layer.effect(
      GitHub,
      Effect.gen(function* () {
        const services = yield* Effect.context<R>()
        const clients = yield* Cache.makeWith(
          (host: string) => octokitFor(host).pipe(Effect.flatMap(makeClient), Effect.provide(services)),
          { capacity: 16, timeToLive: successFor(Infinity) },
        )
        return GitHub.of({ forHost: (host) => Cache.get(clients, host) })
      }),
    )

  /** Auth piggybacks on the engineer's `gh` login for that host. */
  static readonly layer = GitHub.layerWith((host) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const token = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make('gh', ['auth', 'token', '--hostname', host]))
          const [out, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], { concurrency: 'unbounded' })
          return code === 0 ? out.trim() : ''
        }),
      ).pipe(Effect.orElseSucceed(() => ''))
      if (!token) return yield* new GitHubError({ status: 401, message: `No GitHub token for ${host}. Run \`gh auth login --hostname ${host}\`.` })
      return new Octokit({ auth: token, baseUrl: apiUrlFor(host) })
    }),
  )
}
