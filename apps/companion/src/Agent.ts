import { type AccountStatus, type AgentAccount, AgentError, type AskEvent } from '@pr-review/domain'
import { Clock, Context, Effect, FileSystem, Layer, Result, Schema, type Scope, Stream } from 'effect'
import { dirname, join } from 'node:path'
import { Acp } from './Acp.ts'
import { Config } from './Config.ts'

export type RunLog = { kind: 'sort' | 'ask' | 'chat' | 'overview' | 'opinion' | 'deeper' | 'stack-opinion' | 'ticket' | 'rule'; owner: string; repo: string; number: number; headSha: string }
type Run = { prompt: string; cwd: string; related?: ReadonlyArray<string>; log: RunLog; onStep?: (step: string) => Effect.Effect<void> }


const LIMITED = /usage limit|rate.?limit|quota|too many requests|\b429\b|limit reached|hit your limit|resets? (at|in)/i
const LOGIN = /not logged in|authenticat|log ?in/i
// ponytail: a fixed sit-out; parse the agent's own "resets at" time if it proves too long or short
const LIMITED_FOR = 30 * 60_000
const LOGIN_FOR = 5 * 60_000

/** Agents get the schema in the prompt and answer with JSON; their own structured-output modes differ per agent. */
const jsonInstruction = (schema: Schema.Top) =>
  `\n\n# Answer format\nReply with one JSON object and nothing else (no prose, no code fence), matching this JSON Schema:\n${JSON.stringify(Schema.toJsonSchemaDocument(schema).schema)}`

/** The JSON object in a reply, fenced or not. */
const jsonIn = (text: string) => {
  const unfenced = text.replace(/```(?:json)?/g, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  return start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced
}

export class Agent extends Context.Service<
  Agent,
  {
    structured<S extends Schema.Top & { readonly DecodingServices: never }>(o: Run & { schema: S }): Effect.Effect<S['Type'], AgentError>
    /** `resume` is a Done event's sessionId; it names the account the conversation ran on. */
    streaming(o: Run & { resume?: string }): Stream.Stream<AskEvent, AgentError>
    readonly status: Effect.Effect<ReadonlyArray<AccountStatus>>
  }
>()('pr-review/Agent') {
  static readonly layer = Layer.effect(
    Agent,
    Effect.gen(function* () {
      const acp = yield* Acp
      const config = yield* Config
      const fs = yield* FileSystem.FileSystem
      const usagePath = join(config.cacheRoot, 'usage.jsonl')
      const states = new Map<string, { busy: number; until: number; error: string | null }>()
      const stateOf = (id: string) => states.get(id) ?? states.set(id, { busy: 0, until: 0, error: null }).get(id)!
      const step = (o: Run, s: string) => (o.onStep ?? (() => Effect.void))(s)

      /** The least busy account with room, held until the scope closes. Waits while all are busy. */
      const acquire = (o: Run, avoid: ReadonlySet<string>, only?: string) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            let waiting = false
            for (;;) {
              const pool = (yield* config.settings).accounts.filter((a) => a.enabled && !avoid.has(a.id) && (only === undefined || a.id === only))
              if (pool.length === 0)
                return yield* new AgentError({
                  message: only ? 'The AI account this conversation ran on is not in the pool anymore. Ask a new question.' : 'No AI account can take this. Add or enable one in the settings.',
                })
              const now = yield* Clock.currentTimeMillis
              const ready = pool.filter((a) => stateOf(a.id).until <= now)
              if (ready.length === 0) {
                const next = Math.min(...pool.map((a) => stateOf(a.id).until))
                const reasons = [...new Set(pool.map((a) => stateOf(a.id).error).filter(Boolean))].join('; ')
                return yield* new AgentError({ message: `Every AI account is sitting out until ${new Date(next).toLocaleTimeString()}${reasons ? `: ${reasons}` : ''}` })
              }
              const load = (a: AgentAccount) => stateOf(a.id).busy / Math.max(1, a.concurrency)
              const free = ready.filter((a) => stateOf(a.id).busy < a.concurrency).sort((a, b) => load(a) - load(b))[0]
              if (free) {
                stateOf(free.id).busy++
                return free
              }
              if (!waiting) yield* step(o, 'Waiting for a free AI account')
              waiting = true
              yield* Effect.sleep('500 millis')
            }
          }),
          (a) => Effect.sync(() => void stateOf(a.id).busy--),
        )

      /** Usage limits and failed logins bench the account; other failures are the agent's answer. */
      const bench = (a: AgentAccount, e: AgentError) =>
        Effect.gen(function* () {
          const sitOut = LIMITED.test(e.message) ? LIMITED_FOR : LOGIN.test(e.message) ? LOGIN_FOR : 0
          if (!sitOut) return false
          const s = stateOf(a.id)
          s.until = (yield* Clock.currentTimeMillis) + sitOut
          s.error = `${a.name}: ${e.message}`
          return true
        })

      const timeLimit = <A, R>(a: AgentAccount, effect: Effect.Effect<A, AgentError, R>) =>
        Effect.flatMap(config.settings, ({ review }) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: `${review.timeoutMinutes} minutes`,
              orElse: () => Effect.fail(new AgentError({ message: `${a.name} took longer than ${review.timeoutMinutes} minutes` })),
            }),
          ),
        )

      const logUsage = (o: Run, a: AgentAccount, startedAt: number) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const line = { at: new Date(now).toISOString(), ...o.log, account: a.name, agent: a.agent, durationMs: now - startedAt }
          yield* fs.makeDirectory(dirname(usagePath), { recursive: true })
          yield* fs.writeFileString(usagePath, JSON.stringify(line) + '\n', { flag: 'a' })
        }).pipe(Effect.ignore)

      /** Runs on one account after another until one answers or none is left; an account that hits its limit sits out. */
      const withAccount = <A>(o: Run, use: (a: AgentAccount) => Effect.Effect<A, AgentError, Scope.Scope>) => {
        const attempt = (avoid: ReadonlySet<string>): Effect.Effect<A, AgentError> =>
          Effect.gen(function* () {
            let account: AgentAccount | undefined
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const a = yield* acquire(o, avoid)
                account = a
                const startedAt = yield* Clock.currentTimeMillis
                return yield* timeLimit(a, use(a)).pipe(Effect.ensuring(logUsage(o, a, startedAt)))
              }),
            ).pipe(Effect.result)
            if (result._tag === 'Success') return result.success
            if (account && (yield* bench(account, result.failure))) {
              const tried = new Set([...avoid, account.id])
              const now = yield* Clock.currentTimeMillis
              const other = (yield* config.settings).accounts.some((a) => a.enabled && !tried.has(a.id) && stateOf(a.id).until <= now)
              if (other) {
                yield* step(o, `${account.name} is at its limit; trying another account`)
                return yield* attempt(tried)
              }
            }
            return yield* result.failure
          })
        return attempt(new Set())
      }

      return Agent.of({
        structured: (o) =>
          withAccount(o, (a) =>
            Effect.gen(function* () {
              const session = yield* acp.open(a, o.cwd, undefined, o.related ? { related: o.related } : undefined)
              yield* step(o, `${a.name} is reading the PR`)
              const ask = (text: string) =>
                session.prompt(text).pipe(Stream.runFoldEffect(() => '', (acc, u) => (u._tag === 'Text' ? Effect.succeed(acc + u.delta) : Effect.as(step(o, u.step), acc))))
              const decode = (text: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(o.schema))(jsonIn(text))
              const first = yield* ask(o.prompt + jsonInstruction(o.schema))
              return yield* decode(first).pipe(
                // One chance to fix it, in the same session.
                Effect.catch((e) =>
                  Effect.flatMap(ask(`That answer does not match the schema: ${e.message}\nReply with only the corrected JSON object.`), (second) =>
                    decode(second).pipe(Effect.mapError((e2) => new AgentError({ message: `${a.name} returned output that does not match the schema: ${e2.message}` }))),
                  ),
                ),
              )
            }),
          ),

        streaming: (o) => {
          const at = o.resume?.indexOf(':') ?? -1
          const [owner, sessionId] = o.resume && at > 0 ? [o.resume.slice(0, at), o.resume.slice(at + 1)] : [undefined, undefined]
          return Stream.unwrap(
            Effect.gen(function* () {
              const a = yield* acquire(o, new Set(), owner)
              const session = yield* acp.open(a, o.cwd, sessionId)
              const startedAt = yield* Clock.currentTimeMillis
              return session.prompt(o.prompt).pipe(
                Stream.filterMapEffect((u) =>
                  u._tag === 'Text' ? Effect.succeed(Result.succeed<AskEvent>({ _tag: 'Text', delta: u.delta })) : Effect.as(step(o, u.step), Result.failVoid),
                ),
                Stream.concat(Stream.succeed<AskEvent>({ _tag: 'Done', sessionId: `${a.id}:${session.sessionId}` })),
                Stream.tapError((e) => bench(a, e)),
                Stream.ensuring(logUsage(o, a, startedAt)),
              )
            }),
          ).pipe(Stream.scoped)
        },

        status: Effect.map(config.settings, (s) => s.accounts.map((a) => ({ id: a.id, ...stateOf(a.id) }))),
      })
    }),
  )
}
