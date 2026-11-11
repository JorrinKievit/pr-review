export type TicketRef = { kind: 'github'; owner?: string; repo?: string; number: number } | { kind: 'other'; ref: string }

const MAX = 3
const TOKENS = /(https?:\/\/[^\s<>()[\]]+)|(?<![\w/&])#(\d+)\b|\b([A-Z][A-Z0-9]+-\d+)\b/g
const TICKET_PATH = /\/(browse|issues?)\//

/** Ticket references in PR text, in order of appearance: GitHub issues on `host`, tracker URLs elsewhere, and `ABC-123` keys. */
export const ticketRefs = (text: string, host: string): TicketRef[] => {
  const github: TicketRef[] = []
  const other: string[] = []
  const add = (list: unknown[], r: unknown, key = JSON.stringify(r)) => list.some((x) => JSON.stringify(x) === key) || list.push(r)
  for (const [, rawUrl, number, key] of text.matchAll(TOKENS)) {
    if (number) add(github, { kind: 'github', number: Number(number) })
    else if (key) add(other, key)
    else if (rawUrl) {
      const url = rawUrl.replace(/[.,;:!?'"]+$/, '')
      let u: URL
      try {
        u = new URL(url)
      } catch {
        continue
      }
      if (u.host === host) {
        const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/)
        if (m) add(github, { kind: 'github', owner: m[1], repo: m[2], number: Number(m[3]) })
      } else if (TICKET_PATH.test(u.pathname)) add(other, url)
    }
  }
  // A key that is also part of a ticket URL is that ticket.
  const segments = new Set(other.filter((r) => r.includes('://')).flatMap((r) => r.split(/[^A-Za-z0-9-]/)))
  const others = other.filter((r) => r.includes('://') || !segments.has(r))
  return [...github.slice(0, MAX), ...others.slice(0, MAX).map((ref): TicketRef => ({ kind: 'other', ref }))]
}
