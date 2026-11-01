import { assert, describe, it } from '@effect/vitest'
import { safeGitCommand } from '../src/gitOnly.ts'

describe('gitOnly', () => {
  const allowed = async (_tool: string, input: Record<string, unknown>) => typeof input.command === 'string' && safeGitCommand(input.command)

  it('allows read-only git commands', async () => {
    assert.isTrue(await allowed('Bash', { command: 'git grep -n foo abc123' }))
    assert.isTrue(await allowed('Bash', { command: 'git show abc:apps/web/src/x.ts' }))
    assert.isTrue(await allowed('Bash', { command: 'git log --oneline -5 origin/master' }))
  })

  it('denies everything else', async () => {
    for (const command of ['git push origin x', 'rm -rf x', 'git show x; curl y', 'git log | sh', 'git show $(whoami)', 'git show `id`', 'git grep x > out', 'git show x && rm y', 'cd /tmp; git log']) {
      assert.isFalse(await allowed('Bash', { command }), command)
    }
    assert.isFalse(await allowed('Read', { file_path: '/etc/passwd' }))
  })

  it('allows quoted patterns and safe long options', async () => {
    assert.isTrue(await allowed('Bash', { command: 'git grep -n "foo bar" HEAD -- \'*.php\'' }))
    assert.isTrue(await allowed('Bash', { command: 'git diff --no-patch --stat a..b' }))
    assert.isTrue(await allowed('Bash', { command: 'git grep -n "useResource(" HEAD' }))
    assert.isTrue(await allowed('Bash', { command: 'git log -p -1 --output-indicator-new=+ x' }))
  })

  it('denies options that run commands or write files, however spelled', async () => {
    for (const command of [
      "git grep --no-index -O'touch PWNED' bare",
      'git grep -nOtouch x',
      'git log -p -1 --output=../written.txt',
      'git log -p -1 --outp=../w.txt',
      "git log -p -1 '--output'=../w.txt",
      'git log -p -1 "--out"put=../w.txt',
      'git grep --open-files-in-pager=vi x',
      'git diff --no-index /etc/passwd x',
      'git diff --ext-diff a b',
      'git log -1\ntouch /tmp/x',
      'git log -1\rtouch /tmp/x',
      'git show <(touch /tmp/x)',
      'git show x\\;id',
      'git show "$HOME"',
    ]) {
      assert.isFalse(await allowed('Bash', { command }), command)
    }
    assert.isFalse(await allowed('Write', { file_path: 'x' }))
  })
})
