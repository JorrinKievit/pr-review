import { type FileStat, GitError, type RepoNotConfigured } from '@pr-review/domain'
import { Cache, Context, Effect, Exit, FileSystem, Layer, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { dirname, join } from 'node:path'
import { Config } from './Config.ts'

export interface PrShas {
  readonly headSha: string
  readonly baseSha: string
  readonly mergeBase: string
}

/** Full bare clones owned by the companion; the reviewer's own working copy is never touched. */
/** `git diff --numstat -z -M`: `add\tdel\tpath\0`, or for a rename `add\tdel\t\0old\0new\0`. Binary files count 0. */
export function parseNumstat(out: string): FileStat[] {
  const fields = out.split('\0')
  const files: FileStat[] = []
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue
    const [add, del, path] = fields[i]!.split('\t')
    const counts = { additions: Number(add) || 0, deletions: Number(del) || 0 }
    if (path) files.push({ path, ...counts })
    else {
      files.push({ path: fields[i + 2]!, previous: fields[i + 1]!, ...counts })
      i += 2
    }
  }
  return files
}

export class Git extends Context.Service<
  Git,
  {
    dir(key: string): string
    ensureClone(key: string): Effect.Effect<void, GitError | RepoNotConfigured>
    /** Fetches the PR head, its base and the default branch; a head already fetched is not fetched again. */
    fetchPr(key: string, n: number, baseRef: string, headSha: string): Effect.Effect<PrShas, GitError | RepoNotConfigured>
    defaultBranch(key: string): Effect.Effect<string, GitError | RepoNotConfigured>
    numstat(key: string, from: string, to: string): Effect.Effect<ReadonlyArray<FileStat>, GitError>
    diff(key: string, from: string, to: string, paths?: ReadonlyArray<string>): Effect.Effect<string, GitError>
    show(key: string, sha: string, path: string): Effect.Effect<string, GitError>
    lsTree(key: string, ref: string, paths: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>, GitError>
  }
>()('pr-review/Git') {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const config = yield* Config
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const dir = (key: string) => join(config.cacheRoot, 'repos', `${key}.git`)
      const remoteUrl = (key: string) => config.repo(key).pipe(Effect.map((r) => r.remoteUrl))

      const text = (s: Stream.Stream<Uint8Array, unknown>) => Stream.mkString(Stream.decodeText(s))
      const exec = (args: ReadonlyArray<string>, cwd?: string) =>
        Effect.gen(function* () {
          // No tty here: a missing credential must fail, not wait for a password prompt.
          const handle = yield* spawner.spawn(ChildProcess.make('git', args, { ...(cwd ? { cwd } : {}), env: { GIT_TERMINAL_PROMPT: '0' }, extendEnv: true }))
          const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: 'unbounded' })
          if (code !== 0) return yield* new GitError({ message: `git ${args[0]}: ${stderr.trim() || `exit ${code}`}` })
          return stdout
        }).pipe(
          Effect.scoped,
          Effect.mapError((e) => (e instanceof GitError ? e : new GitError({ message: String(e) }))),
        )
      const inRepo = (key: string, ...args: string[]) => exec(args, dir(key))
      const failuresExpire = (exit: Exit.Exit<unknown, unknown>) => (Exit.isSuccess(exit) ? Infinity : 0)

      const clones = yield* Cache.makeWith(
        (key: string) =>
          Effect.gen(function* () {
            const target = dir(key)
            if (yield* fs.exists(join(target, 'HEAD')).pipe(Effect.orElseSucceed(() => false))) return
            const url = yield* remoteUrl(key)
            const partial = `${target}.partial`
            yield* Effect.orDie(fs.makeDirectory(dirname(target), { recursive: true }))
            yield* Effect.orDie(fs.remove(partial, { recursive: true, force: true }))
            yield* exec(['clone', '--bare', '--quiet', url, partial])
            yield* exec(['config', 'gc.auto', '0'], partial)
            yield* exec(['config', 'maintenance.auto', 'false'], partial)
            yield* Effect.orDie(fs.rename(partial, target))
          }),
        { capacity: 64, timeToLive: failuresExpire },
      )
      const ensureClone = (key: string) => Cache.get(clones, key)
      // A bare clone's HEAD is the remote's default branch at clone time.
      const branchOf = (key: string) => Effect.andThen(ensureClone(key), inRepo(key, 'symbolic-ref', '--short', 'HEAD')).pipe(Effect.map((s) => s.trim()))

      const fetches = yield* Cache.makeWith(
        (spec: string) =>
          Effect.gen(function* () {
            const [key, n, baseRef, wanted] = JSON.parse(spec) as [string, number, string, string]
            yield* ensureClone(key)
            const defaultBranch = yield* branchOf(key)
            const refspecs = [`+pull/${n}/head:refs/pr/${n}`, `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`]
            if (baseRef !== defaultBranch) refspecs.push(`+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`)
            // A head already fetched (before a restart) needs no network: a base that moved on since leaves the merge-base where it was.
            const local = yield* inRepo(key, 'rev-parse', ...refspecs.map((r) => r.split(':')[1]!)).pipe(Effect.orElseSucceed(() => ''))
            if (local.split('\n')[0] !== wanted) yield* inRepo(key, 'fetch', '--quiet', yield* remoteUrl(key), ...refspecs)
            const headSha = (yield* inRepo(key, 'rev-parse', `refs/pr/${n}`)).trim()
            const baseSha = (yield* inRepo(key, 'rev-parse', `refs/remotes/origin/${baseRef}`)).trim()
            const mergeBase = (yield* inRepo(key, 'merge-base', baseSha, headSha)).trim()
            return { headSha, baseSha, mergeBase }
          }),
        { capacity: 256, timeToLive: failuresExpire },
      )

      return Git.of({
        dir,
        ensureClone,
        fetchPr: (key, n, baseRef, headSha) => Cache.get(fetches, JSON.stringify([key, n, baseRef, headSha])),
        defaultBranch: branchOf,
        numstat: (key, from, to) => inRepo(key, 'diff', '--numstat', '-z', '-M', from, to).pipe(Effect.map(parseNumstat)),
        // -M: a moved file diffs as a rename when both its paths are asked for.
        diff: (key, from, to, paths = []) => inRepo(key, 'diff', '--no-color', '--no-ext-diff', '-M', from, to, '--', ...paths),
        show: (key, sha, path) => inRepo(key, 'show', `${sha}:${path}`),
        lsTree: (key, ref, paths) => inRepo(key, 'ls-tree', '-r', '--name-only', ref, '--', ...paths).pipe(Effect.map((out) => out.split('\n').filter(Boolean))),
      })
    }),
  )
}
