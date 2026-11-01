// Usage: node scripts/eval-sort.ts <host> <owner> <repo> <n> <reviewer>
// Sorts a real PR and reports how many files the reviewer commented on landed in the decision pile.
import { NodeServices } from '@effect/platform-node'
import { defaultSettings } from '@pr-review/domain'
import { Effect, Layer } from 'effect'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Acp } from '../src/Acp.ts'
import { Agent } from '../src/Agent.ts'
import { Config, defaultCacheRoot } from '../src/Config.ts'
import { Git } from '../src/Git.ts'
import { GitHub } from '../src/GitHub.ts'
import { Sorter } from '../src/Sorter.ts'
import { Store } from '../src/Store.ts'

const [host, owner, repo, n, reviewer] = process.argv.slice(2)
if (!host || !owner || !repo || !n || !reviewer) throw new Error('usage: eval-sort.ts <host> <owner> <repo> <n> <reviewer>')
const repoKey = `${host}/${owner}/${repo}`
const ref = { host, owner, repo, number: Number(n) }

const program = Effect.gen(function* () {
  const gh = yield* (yield* GitHub).forHost(host)
  const pr = yield* gh.getPr(owner, repo, ref.number)
  console.error('cloning / fetching…')
  let started = Date.now()
  yield* (yield* Git).ensureClone(repoKey)
  console.error(`clone ready in ${Math.round((Date.now() - started) / 1000)}s`)
  started = Date.now()
  const result = yield* (yield* Sorter).sort(ref, pr.headSha)
  const seconds = Math.round((Date.now() - started) / 1000)

  const commented = [...new Set((yield* gh.listThreads(owner, repo, ref.number)).filter((t) => t.author === reviewer).map((t) => t.path))]
  const inDecision = new Set(result.decisions.flatMap((d) => d.files.map((f) => f.path)))
  const hits = commented.filter((p) => inDecision.has(p))
  const usage = readFileSync(join(defaultCacheRoot, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1)

  console.log(`decisions: ${result.decisions.length}`)
  for (const d of result.decisions) console.log(`  [${d.lens}/${d.reason}] ${d.title}: ${d.files.map((f) => f.path.split('/').pop()).join(', ')}`)
  console.log(`skim areas: ${result.skim.map((s) => `${s.area} (${s.files.length})`).join(', ')}`)
  console.log(`trusted: ${result.trusted.map((t) => `${t.group} (${t.files.length})`).join(', ')}`)
  console.log(`lines: ${JSON.stringify(result.lines)}`)
  console.log(`recall: ${hits.length}/${commented.length} commented files in decisions`)
  for (const p of commented.filter((p) => !inDecision.has(p))) console.log(`  missed: ${p}`)
  console.log(`ran on ${usage.account}, ${seconds}s`)
})

const config = Config.layerTest({ cacheRoot: defaultCacheRoot, settings: { ...defaultSettings, hosts: [host] } })
const layer = Layer.mergeAll(Sorter.layer, Git.layer, GitHub.layer).pipe(
  Layer.provide([Agent.layer.pipe(Layer.provide(Acp.layer)), Git.layer, GitHub.layer, Store.layer]),
  Layer.provide(config),
  Layer.provide(NodeServices.layer),
)
await Effect.runPromise(program.pipe(Effect.provide(layer)))
