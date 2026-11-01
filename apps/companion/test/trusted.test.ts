import { test } from '@effect/vitest'
import { defaultSettings } from '@pr-review/domain'
import assert from 'node:assert/strict'
import { buildTrusted, trustedGroup } from '../src/trusted.ts'

const { likelyTrusted, neverTrust } = defaultSettings.review

const cases: [string, string | null][] = [
  ['src/settings/__tests__/access.test.ts', 'tests'],
  ['tests/Unit/AccountTest.php', 'tests'],
  ['src/routeTree.gen.ts', 'generated'],
  ['web/locales/nl/common.json', 'translations'],
  ['pnpm-lock.yaml', 'lockfiles'],
  ['services/api/go.sum', 'lockfiles'],
  ['db/migrations/20261013_create_usage.sql', null],
  ['tests/migrations/VersionTest.php', null],
  ['.github/workflows/ci.yml', null],
  ['src/settings/page.tsx', null],
]

for (const [path, group] of cases) {
  test(`trustedGroup ${path} → ${group}`, () => assert.equal(trustedGroup(path, likelyTrusted, neverTrust), group))
}

test('your own rules decide, and never-trust wins over them', () => {
  const rules = [{ group: 'fixtures', patterns: ['fixtures/**'] }]
  assert.equal(trustedGroup('fixtures/users.json', rules, []), 'fixtures')
  assert.equal(trustedGroup('fixtures/users.json', rules, ['fixtures/users.json']), null)
})

test('buildTrusted groups candidates with the CI state and leaves the rest', () => {
  const f = (path: string) => ({ path, additions: 1, deletions: 0 })
  const { groups, rest } = buildTrusted([f('x/__tests__/y.test.ts'), f('pnpm-lock.yaml'), f('src/page.tsx')], 'pass', likelyTrusted, neverTrust)
  assert.deepEqual(groups, [
    { group: 'tests', why: 'CI checks: pass', files: ['x/__tests__/y.test.ts'] },
    { group: 'lockfiles', why: 'CI checks: pass', files: ['pnpm-lock.yaml'] },
  ])
  assert.deepEqual(rest.map((r) => r.path), ['src/page.tsx'])
})
