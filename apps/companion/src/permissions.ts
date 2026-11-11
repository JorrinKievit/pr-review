const READ_VERB = /^(get|read|search|list|find|query|view|show|lookup|describe)(?=[A-Z_]|$)/
const WRITE_OR_NETWORK =
  /merge|push|create|update|delete|remove|add|edit|transition|assign|post|send|write|comment|move|archive|save|set|close|reopen|link|upload|download|publish|invite|approve|fetch|http|url|web|browse|request|curl/i

/**
 * The ticket session may only call MCP tools whose name reads as a lookup (`mcp__server__getIssue`). Everything else is
 * refused, including local reads and URL fetches: a hostile ticket could use them to read secrets and send them out.
 */
export const ticketPermission = (toolCall: { kind?: string | null; title?: string | null; rawInput?: unknown }): boolean => {
  const name = toolCall.title ?? ''
  if ((toolCall.kind !== 'search' && toolCall.kind !== 'other') || !name.startsWith('mcp__') || WRITE_OR_NETWORK.test(name)) return false
  return READ_VERB.test(name.split('__').at(-1)!)
}
