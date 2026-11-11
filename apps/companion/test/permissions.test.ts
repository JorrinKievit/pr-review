import { assert, describe, it } from 'vitest'
import { ticketPermission } from '../src/permissions.ts'

describe('ticketPermission', () => {
  it('allows MCP lookups', () => {
    for (const title of ['mcp__jira__getIssue', 'mcp__linear__list_issues', 'mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql'])
      for (const kind of ['other', 'search']) assert.isTrue(ticketPermission({ kind, title }), `${kind} ${title}`)
  })

  it('rejects writes, fetches, non-MCP tools and other kinds', () => {
    for (const t of [
      {},
      { kind: 'other' },
      { kind: 'search' },
      { kind: 'other', title: 'mcp__github__merge_pull_request' },
      { kind: 'other', title: 'mcp__github__push_files' },
      { kind: 'other', title: 'mcp__fetch__fetch' },
      { kind: 'other', title: 'mcp__linear__save_issue' },
      { kind: 'other', title: 'mcp__linear__save_comment' },
      { kind: 'other', title: 'mcp__jira__transitionIssue' },
      { kind: 'other', title: 'mcp__github__fork_repository' },
      { kind: 'other', title: 'mcp__jira__getter' },
      { kind: 'other', title: 'mcp__jira__getIssueLinks' },
      { kind: 'other', title: 'Read' },
      { kind: 'search', title: 'Grep' },
      { kind: 'read', title: 'mcp__jira__getIssue' },
      { kind: 'fetch', title: 'mcp__jira__getIssue' },
      { kind: 'execute', title: 'mcp__jira__getIssue' },
      { kind: 'edit', title: 'mcp__jira__getIssue' },
    ])
      assert.isFalse(ticketPermission(t), JSON.stringify(t))
  })
})
