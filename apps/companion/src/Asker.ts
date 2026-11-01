import type { AgentError, AskEvent, AskTarget, GitError, PrRef, RepoNotConfigured } from '@pr-review/domain'
import { Context, Effect, Layer, Stream } from 'effect'
import { readFileSync } from 'node:fs'
import { Agent } from './Agent.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'

const instructions = readFileSync(new URL('../prompts/ask.md', import.meta.url), 'utf8')

const ranges = (rs: ReadonlyArray<{ start: number; end: number }>) => (rs.length ? rs.map((r) => `${r.start}-${r.end}`).join(',') : 'whole file')

export class Asker extends Context.Service<
  Asker,
  {
    /** A first question carries the context; a follow-up (with `sessionId`) resumes the session with the question alone. */
    ask(ref: PrRef, headSha: string, target: AskTarget, question: string, sessionId?: string): Stream.Stream<AskEvent, AgentError | GitError | RepoNotConfigured>
  }
>()('pr-review/Asker') {
  static readonly layer = Layer.effect(
    Asker,
    Effect.gen(function* () {
      const git = yield* Git
      const agent = yield* Agent
      const config = yield* Config

      const context = (repoKey: string, headSha: string, t: AskTarget) =>
        Effect.gen(function* () {
          if (t._tag === 'Lines') {
            const lines = (yield* git.show(repoKey, t.commit, t.path)).split('\n')
            const excerpt = lines.slice(t.start - 1, t.end).map((l, i) => `${t.start + i}: ${l}`).join('\n')
            const which = t.side === 'LEFT' ? ` (removed by this PR; as of ${t.commit})` : ''
            return `# Selected lines${which}: ${t.path}:${t.start}-${t.end}\n\`\`\`\n${excerpt}\n\`\`\``
          }
          const d = t.decision
          return [
            `# Decision: ${d.title} (${d.lens}, ${d.reason})`,
            d.note,
            d.existing ? `Existing way: ${d.existing.path}: ${d.existing.why}` : '',
            d.authorWhy ? `Author's reason: ${d.authorWhy}` : '',
            `Files: ${d.files.map((f) => `${f.path}:${ranges(f.ranges)}`).join(', ')}`,
          ]
            .filter(Boolean)
            .join('\n')
        })

      return Asker.of({
        ask: (ref, headSha, target, question, sessionId) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const repoKey = `${ref.host}/${ref.owner}/${ref.repo}`
              yield* config.repo(repoKey)
              const defaultBranch = yield* git.defaultBranch(repoKey)
              const prompt = sessionId
                ? question
                : [
                    instructions,
                    `# Refs\nPR #${ref.number} head: ${headSha}\nDefault branch: origin/${defaultBranch}`,
                    yield* context(repoKey, headSha, target),
                    `# Question\n${question}`,
                  ].join('\n\n')
              return agent.streaming({
                prompt,
                cwd: git.dir(repoKey),
                ...(sessionId ? { resume: sessionId } : {}),
                log: { kind: target._tag === 'Decision' ? 'chat' : 'ask', owner: ref.owner, repo: ref.repo, number: ref.number, headSha },
              })
            }),
          ),
      })
    }),
  )
}
