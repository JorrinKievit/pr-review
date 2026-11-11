import { assert, describe, it } from 'vitest'
import { ticketRefs } from '../src/ticketRefs.ts'

describe('ticketRefs', () => {
  it('finds a Jira-style key in the branch name', () => {
    assert.deepStrictEqual(ticketRefs('feat/CORE-650-planning', 'github.com'), [{ kind: 'other', ref: 'CORE-650' }])
  })

  it('finds a Linear URL', () => {
    assert.deepStrictEqual(ticketRefs('Fixes https://linear.app/acme/issue/ENG-12/fix-x.', 'github.com'), [{ kind: 'other', ref: 'https://linear.app/acme/issue/ENG-12/fix-x' }])
  })

  it('finds GitHub issue refs in Closes #45 and issue URLs', () => {
    assert.deepStrictEqual(ticketRefs('Closes #45, see https://ghe.io/o/r/issues/9 and https://ghe.io/o/r/pull/3#issuecomment-1 and a#7', 'ghe.io'), [
      { kind: 'github', number: 45 },
      { kind: 'github', owner: 'o', repo: 'r', number: 9 },
    ])
  })

  it('a key linked to its own ticket URL is one ref; other hosts without a ticket path are not tickets', () => {
    assert.deepStrictEqual(ticketRefs('[CORE-650](https://acme.atlassian.net/browse/CORE-650) https://example.com/docs/page', 'github.com'), [
      { kind: 'other', ref: 'https://acme.atlassian.net/browse/CORE-650' },
    ])
  })

  it('UTF-8 and SHA-256 are not tickets', () => {
    assert.deepStrictEqual(ticketRefs('Encode as UTF-8, hash with SHA-256 per RFC-7231 over HTTP-2, ISO-8601 dates, for CORE-1', 'github.com'), [{ kind: 'other', ref: 'CORE-1' }])
  })

  it('deduplicates and caps', () => {
    const refs = ticketRefs('#1 #1 #2 #3 #4 AB-1 AB-1 BC-2 CD-3 DE-4', 'github.com')
    assert.deepStrictEqual(refs, [
      { kind: 'github', number: 1 },
      { kind: 'github', number: 2 },
      { kind: 'github', number: 3 },
      { kind: 'other', ref: 'AB-1' },
      { kind: 'other', ref: 'BC-2' },
      { kind: 'other', ref: 'CD-3' },
    ])
  })
})
