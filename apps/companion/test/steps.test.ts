import { describe, expect, it } from 'vitest'
import { describeTool } from '../src/steps.ts'

describe('describeTool', () => {
  it('names what a git command reads', () => {
    expect(describeTool('Bash', { command: 'git show abc123:apps/web/src/cohesion/select-field.tsx' })).toBe('Reading select-field.tsx')
    expect(describeTool('Bash', { command: 'git grep -n "useResource(" HEAD -- apps/web' })).toBe('Searching for "useResource("')
    expect(describeTool('Bash', { command: "git grep -nF 'NoFourByteChars' origin/master" })).toBe('Searching for "NoFourByteChars"')
    expect(describeTool('Bash', { command: 'git log --oneline -5 origin/master -- src/Usage/Event.php' })).toBe('Reading the history of Event.php')
    expect(describeTool('Bash', { command: 'git diff MB HEAD -- src/a.ts' })).toBe('Comparing a.ts')
    expect(describeTool('Bash', { command: 'git ls-tree -r --name-only origin/master apps/core/src' })).toBe('Listing apps/core/src')
    expect(describeTool('Bash', { command: 'git grep -n "findNotDeleted\\|function findOnline" HEAD' })).toBe('Searching for "findNotDeleted" or "function findOnline"')
    expect(describeTool('Bash', { command: 'git grep -nE "class (Foo|Bar)" HEAD' })).toBe('Searching for "class (Foo|Bar)"')
  })

  it('names the other tools and falls back to the tool name', () => {
    expect(describeTool('Read', { file_path: '/repo/src/Billing/Grant.php' })).toBe('Reading Grant.php')
    expect(describeTool('Grep', { pattern: 'CreditGrant' })).toBe('Searching for "CreditGrant"')
    expect(describeTool('Glob', { pattern: '**/*.php' })).toBe('Listing **/*.php')
    expect(describeTool('StructuredOutput', {})).toBe('Writing up the decisions')
    expect(describeTool('TodoWrite', {})).toBe('Using TodoWrite')
  })
})
