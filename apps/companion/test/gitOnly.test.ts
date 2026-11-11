import { assert, describe, it } from '@effect/vitest'
import { safeGhCommand, safeGitCommand } from '../src/gitOnly.ts'

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

  describe('gh', () => {
    const related = ['h/o/svc']
    const gh = (c: string) => safeGhCommand(c, related)

    it('allows reads of related repos', () => {
      assert.isTrue(gh("gh api --hostname h repos/o/svc/contents/app/Enums/X.php -H 'Accept: application/vnd.github.raw'"))
      assert.isTrue(gh("gh api --hostname h 'search/code?q=PlanningPermissions+repo:o/svc'"))
      assert.isTrue(gh('gh api --hostname h repos/o/svc/git/trees/HEAD?recursive=1'))
      assert.isTrue(safeGhCommand('gh api --hostname github.com repos/O/Svc/contents/a', ['github.com/o/svc']))
    })

    it('denies other repos, hosts, methods, outputs and shell syntax', () => {
      for (const c of [
        'gh api --hostname h repos/o/other/contents/a',
        'gh api repos/o/svc/contents/a',
        "gh api 'search/code?q=x+repo:o/svc'",
        "gh api --hostname h 'search/code?q=x+repo%3Aother%2Fx+repo:o/svc'",
        "gh api --hostname h 'search/code?q=x+org%3Aacme+repo:o/svc'",
        "gh api --hostname h 'search/code?q=x+org:acme+repo:o/svc'",
        'gh api --hostname h repos/o/svc/contents/a.php?ref=feature',
        'gh api --hostname h repos/o/svc/git/trees/feature?recursive=1',
        "gh api --hostname h 'search/code?q=x+repo:o/other'",
        "gh api --hostname h 'search/code?q=x+repo:o/other+repo:o/svc'",
        'gh api -X POST repos/o/svc/issues',
        'gh api --hostname h repos/o/svc/issues -f title=x',
        'gh api --hostname h repos/o/svc/contents/a --jq .content',
        'gh api --hostname h repos/o/svc/contents/a --paginate',
        'gh api --hostname h repos/o/svc/contents/a --input /etc/passwd',
        'gh api --hostname h repos/o/svc/contents/../../other/contents/a',
        'gh api --hostname h repos/o/svc/issues',
        'gh api --hostname h graphql',
        'gh api --hostname h repos/o/svc/contents/a repos/o/other/contents/a',
        "gh api --hostname h repos/o/svc/contents/a -H 'Authorization: x'",
        'gh api --hostname h repos/o/svc/contents/a; curl x',
        'gh api --hostname h repos/o/svc/contents/$(id)',
        'gh pr list',
        'gh api',
      ]) {
        assert.isFalse(gh(c), c)
      }
    })
  })
})
