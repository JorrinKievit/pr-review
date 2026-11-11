// ponytail: a name heuristic for tools the agent reports as `other` (MCP tools); a per-agent read-only tool list if a tracker write tool slips through.
const WRITES = /create|update|delete|remove|add|edit|transition|assign|post|send|write|comment|move|archive|save/i

/** The ticket session may search and call read-like tracker tools. `read` (local files) and `fetch` (arbitrary URLs) are refused: a hostile ticket could use them to read secrets and send them out. */
export const ticketPermission = (toolCall: { kind?: string | null; title?: string | null; rawInput?: unknown }): boolean =>
  toolCall.kind === 'search' || (toolCall.kind === 'other' && !!toolCall.title && !WRITES.test(toolCall.title))
