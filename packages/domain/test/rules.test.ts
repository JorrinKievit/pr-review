import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { appendPatch, inGuidance } from '../src/rules.ts'

const applied = (old: string | null, rule: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, input: undefined })
  git('init', '-q')
  if (old !== null) writeFileSync(join(dir, 'AGENTS.md'), old)
  const patch = join(dir, '..', `${dir.split('/').pop()}.patch`)
  writeFileSync(patch, appendPatch('AGENTS.md', old, rule))
  git('apply', '--check', patch)
  git('apply', patch)
  return readFileSync(join(dir, 'AGENTS.md'), 'utf8')
}

it('appendPatch applies with git apply', () => {
  expect(applied('# Rules\n\n- one\n- two\n', '- three\n')).toBe('# Rules\n\n- one\n- two\n\n- three\n')
  expect(applied('- one\n\n', '- two')).toBe('- one\n\n- two\n')
  expect(applied('- one', '- two')).toBe('- one\n\n- two\n')
  expect(applied('', '- two')).toBe('- two\n')
})

it('appendPatch creates a missing file', () => {
  expect(applied(null, '- first\n- second')).toBe('- first\n- second\n')
})

it('inGuidance accepts files under a guidance folder and rejects others', () => {
  const g = ['AGENTS.md', '.cursor/rules', '.agents/']
  expect(inGuidance('AGENTS.md', g)).toBe(true)
  expect(inGuidance('.cursor/rules/api.mdc', g)).toBe(true)
  expect(inGuidance('.agents/x/y.md', g)).toBe(true)
  expect(inGuidance('.cursor/rulesets/a.md', g)).toBe(false)
  expect(inGuidance('src/AGENTS.md', g)).toBe(false)
  expect(inGuidance('README.md', g)).toBe(false)
})
