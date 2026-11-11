import { AgentError, AgentStackOpinion, type Evidence, type Finding, type PrRef, repoSettings, type StackOpinion, type StackOverview } from '@pr-review/domain'
import { Context, Effect, Layer, Stream } from 'effect'
import { PersistedCache } from 'effect/persistence'
import { readFileSync } from 'node:fs'
import { Agent } from './Agent.ts'
import { checkFinding } from './citations.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { GitHub } from './GitHub.ts'
import { Opiner } from './Opiner.ts'
import { citationReader, describePr, guidanceSection, relatedSection, ticketSection } from './opinionContext.ts'
import { type SortError, Sorter } from './Sorter.ts'
import { buildStack } from './stack.ts'
import { makeSteps } from './steps.ts'
import { cacheOptions, OverviewKey, peek, StackOpinionKey, storeFailuresDie } from './Store.ts'
import { Tickets } from './Tickets.ts'

const instructions = readFileSync(new URL('../prompts/stack-opinion.md', import.meta.url), 'utf8')

const idOf = (k: StackOpinionKey) => `${k.host}/${k.owner}/${k.repo} stack ${k.heads.map((h) => `${h.number}@${h.headSha}`).join(' ')}`

const overviewText = (o: StackOverview) =>
  [o.summary, ...(['tables', 'modules', 'endpoints', 'sharedLayers'] as const).flatMap((k) => (o[k].length ? [`${k}: ${o[k].join(', ')}`] : []))].join('\n')

/** One opinion on a stack as a whole. It reads cached sorts and PR opinions, and never runs either. */
export class StackOpiner extends Context.Service<
  StackOpiner,
  {
    /** The opinion on the stack's current heads if one is cached, without running it. */
    cached(ref: PrRef): Effect.Effect<StackOpinion | undefined>
    /** Cached per set of heads. */
    opine(ref: PrRef): Effect.Effect<StackOpinion, SortError>
    /** As `Sorter.steps`. */
    steps(ref: PrRef): Stream.Stream<string>
  }
>()('pr-review/StackOpiner') {
  static readonly layer = Layer.effect(
    StackOpiner,
    Effect.gen(function* () {
      const git = yield* Git
      const github = yield* GitHub
      const agent = yield* Agent
      const config = yield* Config
      const sorter = yield* Sorter
      const opiner = yield* Opiner
      const tickets = yield* Tickets
      const steps = yield* makeSteps

      const keyFor = Effect.fnUntraced(function* (ref: PrRef) {
        const repoKey = `${ref.host}/${ref.owner}/${ref.repo}`
        yield* config.repo(repoKey)
        const defaultBranch = yield* git.defaultBranch(repoKey)
        const gh = yield* github.forHost(ref.host)
        const stack = buildStack([...(yield* gh.listOpenPrs(ref.owner, ref.repo))], ref.number, defaultBranch)
        return new StackOpinionKey({ host: ref.host, owner: ref.owner, repo: ref.repo, heads: stack.map((e) => ({ number: e.number, headSha: e.headSha })) })
      })

      const readOverview = yield* peek('overview')

      const run = Effect.fn('StackOpiner.run')(function* (key: StackOpinionKey) {
        const { host, owner, repo, heads } = key
        const repoKey = `${host}/${owner}/${repo}`
        const report = steps.report(idOf(key))
        yield* report('Reading the stack')
        const settings = yield* config.settings
        const gh = yield* github.forHost(host)
        const open = yield* gh.listOpenPrs(owner, repo)
        const stack = heads.flatMap((h) => open.filter((p) => p.number === h.number).map((p) => ({ ...p, headSha: h.headSha })))
        const top = stack.at(-1)
        if (!top) return yield* new AgentError({ message: 'This stack has no open PRs' })

        const prs = yield* Effect.forEach(
          stack,
          (entry) =>
            Effect.gen(function* () {
              const prRef = { host, owner, repo, number: entry.number }
              const { mergeBase } = yield* git.fetchPr(repoKey, entry.number, entry.baseRef, entry.headSha)
              const [files, sort, opinion] = yield* Effect.all([git.numstat(repoKey, mergeBase, entry.headSha), sorter.cached(prRef, entry.headSha), opiner.cached(prRef, entry.headSha)], {
                concurrency: 3,
              })
              return { entry, mergeBase, files, sort, opinion }
            }),
          { concurrency: 4 },
        )
        const master = `origin/${yield* git.defaultBranch(repoKey)}`
        const { related } = repoSettings(settings, repoKey)
        const { review } = settings
        const [guidance, ticket, overview] = yield* Effect.all(
          [
            review.guidance.length ? git.lsTree(repoKey, master, review.guidance) : Effect.succeed([]),
            Effect.flatMap(gh.getPr(owner, repo, top.number), (pr) => tickets.summary({ host, owner, repo, number: top.number }, pr)),
            // Keyed like the Stack handler keys it: the sorted PRs, bottom first; only their numbers and heads make the key.
            readOverview(new OverviewKey({ host, owner, repo, entries: prs.flatMap((p) => (p.sort ? [{ number: p.entry.number, headSha: p.entry.headSha, sort: p.sort, files: p.files }] : [])) })),
          ],
          { concurrency: 3 },
        )

        const existing = prs.flatMap((p) => {
          const findings = p.opinion?.decisions.flatMap((d) => d.findings) ?? []
          return findings.length ? [[`#${p.entry.number}`, ...findings.map((f) => `- [${f.severity}] ${f.title}`)].join('\n')] : []
        })
        const prompt = [
          instructions,
          `# Refs\nDefault branch: ${master}\n${prs.map((p) => `#${p.entry.number} head ${p.entry.headSha}, merge base ${p.mergeBase}`).join('\n')}`,
          guidanceSection(master, guidance),
          relatedSection(related),
          ticketSection(ticket, 'skip the Spec axis'),
          `# Stack overview\n${overview ? overviewText(overview) : '(none)'}`,
          `# PRs (bottom first)\n${prs.map((p) => describePr(p.entry, p.sort, p.files)).join('\n\n')}`,
          `# Existing PR opinions (already reported; don't repeat them)\n${existing.join('\n\n') || '(none)'}`,
        ].join('\n\n')

        const answer = yield* agent.structured({
          prompt,
          schema: AgentStackOpinion,
          cwd: git.dir(repoKey),
          related: related.map((r) => r.repo),
          log: { kind: 'stack-opinion', owner, repo, number: stack[0]!.number, headSha: top.headSha },
          onStep: report,
        })

        yield* report('Checking the citations')
        const byPr = new Map(prs.map((p) => [p.entry.number, p]))
        const order = prs.map((p) => p.entry.number)
        const findings = yield* Effect.forEach(
          answer.findings.filter((f) => byPr.has(f.pr)),
          (f, i) => {
            const pr = byPr.get(f.pr)!
            const at = (e: Evidence) => {
              const p = byPr.get(e.pr ?? f.pr)
              return p && (e.ref === 'head' ? p.entry.headSha : p.mergeBase)
            }
            return Effect.map(
              checkFinding(f, citationReader(git, github, repoKey, related, at)),
              (checked): Finding => ({
                ...checked,
                id: `stack:${i}`,
                pr: f.pr,
                decisionId: null,
                anchor: checked.anchor && pr.files.some((x) => x.path === checked.anchor!.path) ? checked.anchor : null,
                handledIn: checked.handledIn !== null && order.indexOf(checked.handledIn) > order.indexOf(f.pr) ? checked.handledIn : null,
              }),
            )
          },
        )
        return { heads: Object.fromEntries(heads.map((h) => [h.number, h.headSha])), findings } satisfies StackOpinion
      })

      const cache = yield* PersistedCache.make(run, { storeId: 'stack-opinion', ...cacheOptions })
      const read = yield* peek('stack-opinion')
      return StackOpiner.of({
        cached: (ref) => keyFor(ref).pipe(Effect.flatMap(read), Effect.orElseSucceed(() => undefined)),
        opine: (ref) => Effect.flatMap(keyFor(ref), (key) => storeFailuresDie(cache.get(key))),
        steps: (ref) => Stream.unwrap(keyFor(ref).pipe(Effect.map((key) => steps.follow(idOf(key))), Effect.orElseSucceed(() => Stream.never))),
      })
    }),
  )
}
