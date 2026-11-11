import { assert, describe, it } from 'vitest'
import { ticketPermission } from '../src/permissions.ts'

describe('ticketPermission', () => {
  it('allows reads and read-like tools', () => {
    for (const t of [{ kind: 'read' }, { kind: 'search' }, { kind: 'fetch' }, { kind: 'other', title: 'mcp__jira__getIssue' }]) assert.isTrue(ticketPermission(t), JSON.stringify(t))
  })

  it('rejects anything that could change something', () => {
    for (const t of [
      {},
      { kind: 'execute' },
      { kind: 'edit' },
      { kind: 'other' },
      { kind: 'other', title: 'mcp__jira__transitionIssue' },
      { kind: 'other', title: 'mcp__linear__save_comment' },
      { kind: 'other', title: 'mcp__linear__save_issue' },
    ])
      assert.isFalse(ticketPermission(t), JSON.stringify(t))
  })
})
