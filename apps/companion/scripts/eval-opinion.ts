// Usage: node scripts/eval-opinion.ts <host> <owner> <repo> <n> <reviewer> [head]
// Runs Claude's opinion on a real PR and reports which of the reviewer's inline comments a finding matches.
// `head` pins an older head, e.g. the one the reviewer commented on once the PR is merged (its head is then on the base branch).
import { NodeServices } from '@effect/platform-node'
import { type Finding, type Severity } from '@pr-review/domain'
import { Effect, Layer } from 'effect'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Acp } from '../src/Acp.ts'
import { Agent } from '../src/Agent.ts'
import { Config, defaultCacheRoot } from '../src/Config.ts'
import { Git } from '../src/Git.ts'
import { GitHub } from '../src/GitHub.ts'
import { Opiner } from '../src/Opiner.ts'
import { Sorter } from '../src/Sorter.ts'
import { Store } from '../src/Store.ts'
import { Tickets } from '../src/Tickets.ts'

const [host, owner, repo, n, reviewer, head] = process.argv.slice(2)
if (!host || !owner || !repo || !n || !reviewer) throw new Error('usage: eval-opinion.ts <host> <owner> <repo> <n> <reviewer> [head]')
const ref = { host, owner, repo, number: Number(n) }
const short = (s: string, max = 100) => {
  const flat = s.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const program = Effect.gen(function* () {
  const gh = yield* (yield* GitHub).forHost(host)
  const pr = yield* gh.getPr(owner, repo, ref.number)
  yield* (yield* Git).ensureClone(`${host}/${owner}/${repo}`)
  const headSha = head ?? pr.headSha
  const sort = yield* (yield* Sorter).sort(ref, headSha)
  const started = Date.now()
  const opinion = yield* (yield* Opiner).opine(ref, headSha)
  const seconds = Math.round((Date.now() - started) / 1000)

  const filesOf = new Map(sort.decisions.map((d) => [d.id, new Set(d.files.map((f) => f.path))]))
  const findings = opinion.decisions.flatMap((d) => d.findings)
  console.log(`head ${opinion.headSha}, ${sort.decisions.length} decisions, ${findings.length} findings`)
  for (const s of ['blocks', 'should', 'ask'] satisfies ReadonlyArray<Severity>) {
    const of = findings.filter((f) => f.severity === s)
    console.log(`\n${s} (${of.length})`)
    for (const f of of) console.log(`  ${f.id} [${f.kind}${f.verified ? '' : ', unverified'}] ${f.title} @ ${f.anchor ? `${f.anchor.path}:${f.anchor.line}` : '-'}\n      ${short(f.take, 160)}`)
  }

  const matches = (f: Finding, path: string, line: number | null) =>
    (f.anchor?.path === path && line !== null && Math.abs(f.anchor.line - line) <= 15) || (f.decisionId !== null && filesOf.get(f.decisionId)?.has(path) === true)
  const comments = (yield* gh.listThreads(owner, repo, ref.number)).filter((t) => t.author === reviewer && t.inReplyTo === null)
  console.log(`\nreviewer comments (${comments.length})`)
  let matched = 0
  for (const c of comments) {
    const hits = findings.filter((f) => matches(f, c.path, c.line))
    if (hits.length) matched++
    console.log(`  ${hits.length ? 'HIT ' : 'miss'} ${c.path}:${c.line ?? '-'} "${short(c.body, 90)}"${hits.length ? `\n      <- ${hits.map((f) => f.id).join(', ')}` : ''}`)
  }
  console.log(`\nmatched: ${matched}/${comments.length} reviewer comments`)
  const usage = readFileSync(join(defaultCacheRoot, 'usage.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .findLast((u) => u.kind === 'opinion' && u.number === ref.number && u.headSha === opinion.headSha)
  console.log(usage ? `opinion ran on ${usage.account} in ${Math.round(usage.durationMs / 1000)}s` : `no usage entry (cached?), ${seconds}s`)
})

// Git.fetchPr always resolves the PR's current head; a pinned head gets its own merge base with the base branch.
const pinned = Layer.effect(
  Git,
  Effect.gen(function* () {
    const git = yield* Git
    return Git.of({
      ...git,
      fetchPr: (key, number, baseRef, wanted) =>
        number === ref.number && head
          ? Effect.map(git.fetchPr(key, number, baseRef, wanted), (s) => ({
              ...s,
              headSha: head,
              mergeBase: execFileSync('git', ['merge-base', s.baseSha, head], { cwd: git.dir(key), encoding: 'utf8' }).trim(),
            }))
          : git.fetchPr(key, number, baseRef, wanted),
    })
  }),
).pipe(Layer.provide(Git.layer))
const gitLayer = head ? pinned : Git.layer

const layer = Opiner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Sorter.layer, Tickets.layer)),
  Layer.provideMerge(Layer.mergeAll(gitLayer, GitHub.layer, Store.layer)),
  Layer.provideMerge(Agent.layer.pipe(Layer.provide(Acp.layer))),
  Layer.provideMerge(gitLayer),
  Layer.provide(Config.layer),
  Layer.provide(NodeServices.layer),
)
await Effect.runPromise(program.pipe(Effect.provide(layer)))
