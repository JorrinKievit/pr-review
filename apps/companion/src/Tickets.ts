import type { PrMeta, PrRef } from '@pr-review/domain'
import { Cache, Context, Effect, Exit, Layer } from 'effect'
import { readFileSync } from 'node:fs'
import { Agent } from './Agent.ts'
import { GitHub } from './GitHub.ts'
import { MAX, ticketRefs } from './ticketRefs.ts'

const ticketPrompt = readFileSync(new URL('../prompts/ticket.md', import.meta.url), 'utf8')

export type TicketSummary = { text: string | null; note: string }

export class Tickets extends Context.Service<
  Tickets,
  {
    /** The tickets a PR names, summarized: GitHub issues through the API, anything else through the ticket session. Never fails. */
    summary(ref: PrRef, pr: PrMeta): Effect.Effect<TicketSummary>
  }
>()('pr-review/Tickets') {
  static readonly layer = Layer.effect(
    Tickets,
    Effect.gen(function* () {
      const github = yield* GitHub
      const agent = yield* Agent

      const lookup = (ref: PrRef, pr: PrMeta) =>
        Effect.gen(function* () {
          const refs = ticketRefs([pr.title, pr.headRef, pr.body].join('\n'), ref.host)
          const texts: string[] = []
          const notes: string[] = []
          const gh = yield* github.forHost(ref.host).pipe(Effect.option)
          let issues = 0
          for (const r of refs) {
            if (r.kind !== 'github' || issues === MAX) continue
            const name = r.owner ? `${r.owner}/${r.repo}#${r.number}` : `#${r.number}`
            const issue = gh._tag === 'Some' ? yield* gh.value.getIssue(r.owner ?? ref.owner, r.repo ?? ref.repo, r.number).pipe(Effect.option) : undefined
            if (issue?._tag === 'Some' && issue.value) {
              issues++
              texts.push(`## GitHub issue ${name}: ${issue.value.title}\n\n${issue.value.body || '(no description)'}`)
              notes.push(`Read ${name} from GitHub`)
            } else if (issue?._tag !== 'Some') notes.push(`Could not fetch ${name}`)
          }
          const others = refs.flatMap((r) => (r.kind === 'other' ? [r.ref] : []))
          if (others.length) {
            const answer = yield* agent
              .ticket({
                prompt: `${ticketPrompt}\n# Tickets\n${others.map((r) => `- ${r}`).join('\n')}`,
                log: { kind: 'ticket', owner: ref.owner, repo: ref.repo, number: ref.number, headSha: pr.headSha },
              })
              .pipe(Effect.result)
            if (answer._tag === 'Success' && answer.success.trim()) {
              texts.push(answer.success.trim())
              notes.push(`Fetched ${others.join(', ')} through the ticket session`)
            } else notes.push(`Could not fetch ${others.join(', ')}${answer._tag === 'Failure' ? `: ${answer.failure.message}` : ''}`)
          }
          return { text: texts.length ? texts.join('\n\n') : null, note: notes.join('; ') || 'No ticket reference found' } satisfies TicketSummary
        })

      // Only summaries with text are kept, so a newly flagged ticket account or a tracker that was down gets another try.
      const cache = yield* Cache.makeWith(
        (key: string) => {
          const { ref, pr } = JSON.parse(key) as { ref: PrRef; pr: PrMeta }
          return lookup(ref, pr)
        },
        { capacity: 256, timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value.text !== null ? '30 minutes' : 0) },
      )
      return Tickets.of({
        summary: (ref, pr) => Cache.get(cache, JSON.stringify({ ref, pr })),
      })
    }),
  )
}
