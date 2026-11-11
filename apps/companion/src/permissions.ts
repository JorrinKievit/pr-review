// ponytail: a name heuristic for tools the agent reports as `other` (MCP tools); a per-agent read-only tool list if a tracker write tool slips through.
const WRITES = /create|update|delete|remove|add|edit|transition|assign|post|send|write|comment|move|archive|save/i

/** The ticket session may read and search, never change anything. */
export const ticketPermission = (toolCall: { kind?: string | null; title?: string | null; rawInput?: unknown }): boolean =>
  toolCall.kind === 'read' || toolCall.kind === 'search' || toolCall.kind === 'fetch' || (toolCall.kind === 'other' && !!toolCall.title && !WRITES.test(toolCall.title))
