// Drives the real host over stdio like the browser does: node scripts/probe-host.ts <host/owner/repo> <number> [stack|ask|stack-pr <other>]
import { NodeServices } from '@effect/platform-node'
import { ReviewRpcs } from '@pr-review/domain'
import { makePortClient } from '@pr-review/native-messaging'
import { streamPort } from '@pr-review/native-messaging/node'
import { Cause, Effect, Stream } from 'effect'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const [repoKey = '', number, mode, other] = process.argv.slice(2)
const [host = '', owner = '', repo = ''] = repoKey.split('/')
const ref = { host, owner, repo, number: Number(number) }
const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))

Effect.gen(function* () {
  // PROBE_BAT=C:\\…\\pr-review-host.bat starts the host the way Windows browsers do (through wsl.exe).
  const bat = process.env.PROBE_BAT
  const child = bat ? spawn('cmd.exe', ['/c', bat], { stdio: ['pipe', 'pipe', 'inherit'] }) : spawn(process.execPath, [main, 'host'], { stdio: ['pipe', 'pipe', 'inherit'] })
  child.on('exit', (code, sig) => console.log('host exited', code, sig))
  child.stdin.on('error', (e) => console.log('stdin error', e.message))
  yield* Effect.addFinalizer(() => Effect.sync(() => child.kill()))
  const client = yield* makePortClient(ReviewRpcs, Effect.sync(() => streamPort(child.stdout, child.stdin)))
  console.log('client ready')
  const t = Date.now()
  const log = (m: string) => console.log(`${((Date.now() - t) / 1000).toFixed(1)}s ${m}`)
  if (mode === 'ask') {
    const pr = yield* client.GetPr({ ref })
    const done = yield* Stream.runLast(client.Sort({ ref, headSha: pr.headSha }))
    const decision = done._tag === 'Some' && done.value._tag === 'Done' ? done.value.result.decisions[0]! : undefined
    if (!decision) return log('no decision')
    log(`asking about: ${decision.title}`)
    yield* client.Ask({ ref, headSha: pr.headSha, target: { _tag: 'Decision', decision }, question: 'why', followUp: false }).pipe(
      Stream.runForEach((e) => Effect.sync(() => (e._tag === 'Done' ? log(`done ${e.sessionId}`) : process.stdout.write(e.delta)))),
    )
    return
  }
  if (mode === 'stack-pr') {
    // The stack page: the stack streams while a PR in it is opened.
    yield* Effect.forkChild(client.Stack({ ref }).pipe(Stream.runForEach((e) => Effect.sync(() => log(e.entries.map((x) => `#${x.pr.number}:${x.status}`).join(' '))))))
    yield* Effect.sleep('1 second')
    const second = { ...ref, number: Number(other) }
    log(`GetPr #${second.number}`)
    const pr = yield* client.GetPr({ ref: second })
    return log(`GetPr ok: ${pr.title}`)
  }
  if (mode === 'stack') {
    let events = 0
    let bytes = 0
    yield* client.Stack({ ref }).pipe(
      Stream.runForEach((e) =>
        Effect.sync(() => {
          events++
          bytes += JSON.stringify(e).length
          log(e.entries.map((x) => `#${x.pr.number}:${x.status}${x.error ? `(${x.error})` : ''}`).join(' '))
        }),
      ),
    )
    return log(`${events} events, ${(bytes / 1e6).toFixed(1)} MB`)
  }
  const pr = yield* client.GetPr({ ref })
  log(`GetPr ok: ${pr.title}, ${pr.files.length} files, head ${pr.headSha}`)
  yield* client.Sort({ ref, headSha: pr.headSha }).pipe(Stream.runForEach((e) => Effect.sync(() => log(`Sort ${e._tag}${e._tag === 'Done' ? ` ${e.result.decisions.length} decisions` : ''}`))))
}).pipe(
  Effect.tapCause((c) => Effect.sync(() => console.log('FAILED', Cause.pretty(c)))),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  Effect.runPromise,
).then(() => console.log('probe done'), (e) => (console.log('probe rejected', e), process.exit(1)))
