import { assert, describe, it } from '@effect/vitest'
import { GitHubError, ReviewRejected } from '@pr-review/domain'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { Octokit } from 'octokit'
import { apiUrlFor, makeClient } from '../src/GitHub.ts'

type Req = { method: string; url: string; body: unknown }

const fakeOctokit = (reply: (r: Req) => { status: number; body: unknown }) => {
  const reqs: Req[] = []
  const fetch = async (url: string, init: RequestInit) => {
    const r = { method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined }
    reqs.push(r)
    const { status, body } = reply(r)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { reqs, octokit: new Octokit({ baseUrl: 'https://h/api/v3', request: { fetch, retries: 0 }, retry: { enabled: false }, throttle: { enabled: false } }) }
}

const threadJson = { id: 5, path: 'a.ts', line: 12, side: 'RIGHT', user: { login: 'me' }, body: 'hi', in_reply_to_id: null, created_at: 't' }
const prJson = { number: 7, title: 'T', user: { login: 'me' }, body: null, base: { ref: 'master' }, head: { ref: 'feat', sha: 's7' }, state: 'open' }

describe('GitHub', () => {
  it('apiUrlFor maps github.com and enterprise hosts', () => {
    assert.strictEqual(apiUrlFor('github.com'), 'https://api.github.com')
    assert.strictEqual(apiUrlFor('git.example.com'), 'https://git.example.com/api/v3')
  })

  it.effect('getPr maps the pull request', () =>
    Effect.gen(function* () {
      const gh = yield* makeClient(fakeOctokit(() => ({ status: 200, body: prJson })).octokit)
      assert.deepStrictEqual(yield* gh.getPr('o', 'r', 7), {
        number: 7, title: 'T', author: 'me', body: '', baseRef: 'master', headRef: 'feat', headSha: 's7', state: 'open',
      })
    }))

  it.effect('getIssue reads an issue; a pull request or a missing issue is null', () =>
    Effect.gen(function* () {
      const gh = yield* makeClient(
        fakeOctokit((r) =>
          r.url.endsWith('/issues/1') ? { status: 200, body: { title: 'Bug', body: null } } : r.url.endsWith('/issues/2') ? { status: 200, body: { title: 'PR', body: '', pull_request: {} } } : { status: 404, body: { message: 'Not Found' } },
        ).octokit,
      )
      assert.deepStrictEqual(yield* gh.getIssue('o', 'r', 1), { title: 'Bug', body: '' })
      assert.isNull(yield* gh.getIssue('o', 'r', 2))
      assert.isNull(yield* gh.getIssue('o', 'r', 3))
    }))

  it.effect('getPr is cached for 30 seconds', () =>
    Effect.gen(function* () {
      const { reqs, octokit } = fakeOctokit(() => ({ status: 200, body: prJson }))
      const gh = yield* makeClient(octokit)
      yield* gh.getPr('o', 'r', 7)
      yield* gh.getPr('o', 'r', 7)
      assert.strictEqual(reqs.length, 1)
      yield* TestClock.adjust('31 seconds')
      yield* gh.getPr('o', 'r', 7)
      assert.strictEqual(reqs.length, 2)
    }))

  it.effect('submitReview sends the drafts as review comments', () =>
    Effect.gen(function* () {
      const { reqs, octokit } = fakeOctokit(() => ({ status: 200, body: {} }))
      const gh = yield* makeClient(octokit)
      yield* gh.submitReview('acme', 'core', 7, {
        event: 'REQUEST_CHANGES',
        body: 'b',
        commitId: 'abc',
        comments: [
          { id: '1', path: 'a.ts', line: 12, side: 'RIGHT', body: 'one' },
          { id: '2', path: 'b.ts', line: 5, startLine: 3, side: 'LEFT', body: 'two' },
        ],
      })
      const r = reqs[0]!
      assert.strictEqual(r.url, 'https://h/api/v3/repos/acme/core/pulls/7/reviews')
      assert.deepStrictEqual(r.body, {
        event: 'REQUEST_CHANGES',
        body: 'b',
        commit_id: 'abc',
        comments: [
          { path: 'a.ts', line: 12, side: 'RIGHT', body: 'one' },
          { path: 'b.ts', line: 5, side: 'LEFT', start_line: 3, start_side: 'LEFT', body: 'two' },
        ],
      })
    }))

  it.effect('a review GitHub refuses becomes ReviewRejected', () =>
    Effect.gen(function* () {
      const gh = yield* makeClient(fakeOctokit(() => ({ status: 422, body: { message: 'Validation Failed' } })).octokit)
      const e = yield* Effect.flip(gh.submitReview('acme', 'core', 7, { event: 'COMMENT', body: 'b', commitId: 'abc', comments: [] }))
      assert.instanceOf(e, ReviewRejected)
      assert.match(e.message, /Validation Failed/)
    }))

  it.effect('a sent review shows in the threads at once, not after the cache expires', () =>
    Effect.gen(function* () {
      const { reqs, octokit } = fakeOctokit((r) => ({ status: 200, body: r.url.includes('/comments') ? [threadJson] : {} }))
      const gh = yield* makeClient(octokit)
      yield* gh.listThreads('acme', 'core', 7)
      yield* gh.submitReview('acme', 'core', 7, { event: 'COMMENT', body: 'b', commitId: 'abc', comments: [] })
      yield* gh.listThreads('acme', 'core', 7)
      assert.strictEqual(reqs.filter((r) => r.url.includes('/comments')).length, 2)
    }))

  it.effect('description is the body GitHub rendered, read fresh so its media links have not expired', () =>
    Effect.gen(function* () {
      const { reqs, octokit } = fakeOctokit(() => ({ status: 200, body: { ...prJson, body_html: '<p>Hi</p>' } }))
      const gh = yield* makeClient(octokit)
      assert.strictEqual(yield* gh.description('o', 'r', 7), '<p>Hi</p>')
      yield* gh.description('o', 'r', 7)
      assert.strictEqual(reqs.length, 2)
    }))

  it.effect('viewer is the login the token belongs to', () =>
    Effect.gen(function* () {
      const gh = yield* makeClient(fakeOctokit(() => ({ status: 200, body: { login: 'jorrin' } })).octokit)
      assert.strictEqual(yield* gh.viewer(), 'jorrin')
    }))

  it.effect('requestedReviewers lists the requested users, cached', () =>
    Effect.gen(function* () {
      const { reqs, octokit } = fakeOctokit(() => ({ status: 200, body: { users: [{ login: 'jorrin' }, { login: 'ann' }], teams: [{ slug: 'core' }] } }))
      const gh = yield* makeClient(octokit)
      assert.deepStrictEqual(yield* gh.requestedReviewers('o', 'r', 7), ['jorrin', 'ann'])
      yield* gh.requestedReviewers('o', 'r', 7)
      assert.strictEqual(reqs.length, 1)
      assert.match(reqs[0]!.url, /pulls\/7\/requested_reviewers/)
    }))

  it.effect('other failures become GitHubError with the status', () =>
    Effect.gen(function* () {
      const gh = yield* makeClient(fakeOctokit(() => ({ status: 404, body: { message: 'Not Found' } })).octokit)
      const e = yield* Effect.flip(gh.getPr('o', 'r', 7))
      assert.instanceOf(e, GitHubError)
      assert.strictEqual(e.status, 404)
    }))

  it.effect('getChecks maps a failed check run to fail', () =>
    Effect.gen(function* () {
      const gh = yield* makeClient(fakeOctokit(() => ({ status: 200, body: { total_count: 2, check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }] } })).octokit)
      assert.strictEqual(yield* gh.getChecks('o', 'r', 'sha'), 'fail')
    }))

  it.effect('getChecks maps incomplete to pending and none to none', () =>
    Effect.gen(function* () {
      const pending = yield* makeClient(fakeOctokit(() => ({ status: 200, body: { total_count: 1, check_runs: [{ status: 'in_progress', conclusion: null }] } })).octokit)
      assert.strictEqual(yield* pending.getChecks('o', 'r', 'sha'), 'pending')
      const none = yield* makeClient(fakeOctokit(() => ({ status: 200, body: { total_count: 0, check_runs: [] } })).octokit)
      assert.strictEqual(yield* none.getChecks('o', 'r', 'sha'), 'none')
    }))

  it.effect('listOpenPrs reads every page over GraphQL and maps head and base refs', () =>
    Effect.gen(function* () {
      const page = (nodes: unknown[], endCursor: string | null) => ({ data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } } } })
      const { reqs, octokit } = fakeOctokit((r) => ({
        status: 200,
        body: (r.body as { variables: { after: string | null } }).variables.after
          ? page([{ number: 4, title: 'u', body: '', headRefName: 'c', baseRefName: 'b', headRefOid: 's4' }], null)
          : page([{ number: 3, title: 't', body: '## What\n\nAdds a thing.', headRefName: 'b', baseRefName: 'master', headRefOid: 's3' }], 'c1'),
      }))
      const gh = yield* makeClient(octokit)
      assert.deepStrictEqual(yield* gh.listOpenPrs('o', 'r'), [
        { number: 3, title: 't', headRef: 'b', baseRef: 'master', headSha: 's3', hasBody: true, description: 'Adds a thing.' },
        { number: 4, title: 'u', headRef: 'c', baseRef: 'b', headSha: 's4', hasBody: false },
      ])
      assert.deepStrictEqual(reqs.map((r) => r.url), ['https://h/api/graphql', 'https://h/api/graphql'])
    }))
})
