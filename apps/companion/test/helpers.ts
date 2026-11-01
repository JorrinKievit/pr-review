import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const tmp = (prefix = 'prr-') => mkdtempSync(join(tmpdir(), prefix))

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
}

/** Remote with master (a.txt) and pull/7/head (a.txt changed, b.txt added). */
export function makeRemote(): string {
  const dir = tmp('prr-remote-')
  git(dir, 'init', '-q', '-b', 'master')
  git(dir, 'config', 'uploadpack.allowFilter', 'true')
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  git(dir, 'checkout', '-qb', 'feat')
  writeFileSync(join(dir, 'a.txt'), 'two\n')
  writeFileSync(join(dir, 'b.txt'), 'new\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'feat')
  git(dir, 'update-ref', 'refs/pull/7/head', 'feat')
  git(dir, 'checkout', '-q', 'master')
  return dir
}
