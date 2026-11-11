import { type AccountStatus, type AgentAccount, AgentError, type AskEvent } from '@pr-review/domain'
import { Clock, Context, Effect, FileSystem, Layer, Result, Schema, Scope, Stream } from 'effect'
import { dirname, join } from 'node:path'
import { Acp, type AcpSession } from './Acp.ts'
import { Config } from './Config.ts'

export type RunLog = { kind: 'sort' | 'ask' | 'chat' | 'overview' | 'opinion' | 'deeper' | 'stack-opinion' | 'ticket' | 'rule'; owner: string; repo: string; number: number; headSha: string }
type Opts = { cwd: string; related?: ReadonlyArray<string>; /** Only `deep` accounts when the pool has any, else the whole pool. */ prefer?: 'deep'; log: RunLog; onStep?: (step: string) => Effect.Effect<void> }
type Run = Opts & { prompt: string }
export type SessionOptions = Opts & { avoid?: ReadonlySet<string>; /** Each whole line of the agent's answer text as it streams. */ onText?: (line: string) => Effect.Effect<void> }
type Decodable = Schema.Top & { readonly DecodingServices: never }
/** Turns in one agent session. `fast` runs on the account's fastModel when it has one; `main` (the default) on its main model. */
export type AgentTurns = { structured<S extends Decodable>(prompt: string, schema: S, model?: 'fast' | 'main', turnKind?: RunLog['kind']): Effect.Effect<S['Type'], AgentError> }


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
    structured<S extends Decodable>(o: Run & { schema: S }): Effect.Effect<S['Type'], AgentError>
    /** One account, one agent session, as many turns as `use` takes. A benched account reruns `use` on another. */
    session<A>(o: SessionOptions, use: (s: AgentTurns, account: AgentAccount) => Effect.Effect<A, AgentError>): Effect.Effect<A, AgentError>
    /** Enabled accounts with free capacity that are not sitting out. */
    idle(): Effect.Effect<ReadonlyArray<AgentAccount>>
    /** `resume` is a Done event's sessionId; it names the account the conversation ran on. */
    streaming(o: Run & { resume?: string }): Stream.Stream<AskEvent, AgentError>
    /** One read-only turn on an account set to read tickets, in an empty temp dir; the answer text. `fast` as in session turns. */
    ticket(o: { prompt: string; log: RunLog; model?: 'fast' | 'main' }): Effect.Effect<string, AgentError>
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
      const step = (o: Opts, s: string) => (o.onStep ?? (() => Effect.void))(s)

      const eligible = (a: AgentAccount, tickets: boolean) => a.enabled && (!tickets || a.tickets === true)

      /** The least busy account with room, held until the scope closes. Waits while all are busy. */
      const acquire = (o: Opts, avoid: ReadonlySet<string>, only?: string, tickets = false) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            let waiting = false
            for (;;) {
              const all = (yield* config.settings).accounts.filter((a) => eligible(a, tickets) && !avoid.has(a.id) && (only === undefined || a.id === only))
              const deep = o.prefer === 'deep' ? all.filter((a) => a.deep === true) : []
              const pool = deep.length ? deep : all
              if (pool.length === 0)
                return yield* new AgentError({
                  message: only
                    ? 'The AI account this conversation ran on is not in the pool anymore. Ask a new question.'
                    : tickets
                      ? 'No AI account is set to read tickets'
                      : 'No AI account can take this. Add or enable one in the settings.',
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

      const logUsage = (log: RunLog, a: AgentAccount, startedAt: number) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const line = { at: new Date(now).toISOString(), ...log, account: a.name, agent: a.agent, durationMs: now - startedAt }
          yield* fs.makeDirectory(dirname(usagePath), { recursive: true })
          yield* fs.writeFileString(usagePath, JSON.stringify(line) + '\n', { flag: 'a' })
        }).pipe(Effect.ignore)

      /** One turn on an account: under the time limit, with a usage line. */
      const turn = <A, R>(log: RunLog, a: AgentAccount, effect: Effect.Effect<A, AgentError, R>) =>
        Effect.flatMap(Clock.currentTimeMillis, (startedAt) => timeLimit(a, effect).pipe(Effect.ensuring(logUsage(log, a, startedAt))))

      /** Runs on one account after another until one answers or none is left; an account that hits its limit sits out. */
      const withAccount = <A>(o: Opts, use: (a: AgentAccount) => Effect.Effect<A, AgentError, Scope.Scope>, tickets = false, avoid: ReadonlySet<string> = new Set()) => {
        const attempt = (avoid: ReadonlySet<string>): Effect.Effect<A, AgentError> =>
          Effect.gen(function* () {
            let account: AgentAccount | undefined
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const a = yield* acquire(o, avoid, undefined, tickets)
                account = a
                return yield* use(a)
              }),
            ).pipe(Effect.result)
            if (result._tag === 'Success') return result.success
            if (account && (yield* bench(account, result.failure))) {
              const tried = new Set([...avoid, account.id])
              const now = yield* Clock.currentTimeMillis
              const other = (yield* config.settings).accounts.some((a) => eligible(a, tickets) && !tried.has(a.id) && stateOf(a.id).until <= now)
              if (other) {
                yield* step(o, `${account.name} is at its limit; trying another account`)
                return yield* attempt(tried)
              }
            }
            return yield* result.failure
          })
        return attempt(avoid)
      }

      const session = <A>(o: SessionOptions, use: (s: AgentTurns, account: AgentAccount) => Effect.Effect<A, AgentError>) =>
        withAccount(
          o,
          (a) =>
            Effect.gen(function* () {
              const scope = yield* Effect.scope
              // Opened in the first turn, so a one-turn run's time limit and usage line cover the open as before.
              const open = yield* Effect.cached(
                acp.open(a, o.cwd, undefined, o.related ? { related: o.related } : undefined).pipe(Effect.tap(() => step(o, `${a.name} is reading the PR`)), Scope.provide(scope)),
              )
              let onFast = false
              const toModel = (s: AcpSession, model: 'fast' | 'main') => {
                if (model === 'fast') {
                  if (!a.fastModel) return Effect.void
                  onFast = true
                  return s.setModel(a.fastModel)
                }
                const main = a.model ?? s.defaultModel
                if (!onFast || !main) return Effect.void
                onFast = false
                return s.setModel(main)
              }
              const ask = (s: AcpSession, text: string) =>
                Effect.gen(function* () {
                  let partial = ''
                  const lines = (delta: string) => {
                    if (!o.onText) return Effect.void
                    const parts = (partial + delta).split('\n')
                    partial = parts.pop()!
                    return Effect.forEach(parts, o.onText, { discard: true })
                  }
                  const answer = yield* s.prompt(text).pipe(
                    Stream.runFoldEffect(() => '', (acc, u) => (u._tag === 'Text' ? Effect.as(lines(u.delta), acc + u.delta) : Effect.as(step(o, u.step), acc))),
                  )
                  if (partial && o.onText) yield* o.onText(partial)
                  return answer
                })
              const turns: AgentTurns = {
                structured: (prompt, schema, model = 'main', turnKind) =>
                  turn(
                    turnKind ? { ...o.log, kind: turnKind } : o.log,
                    a,
                    Effect.gen(function* () {
                      const s = yield* open
                      yield* toModel(s, model)
                      const decode = (text: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(jsonIn(text))
                      const first = yield* ask(s, prompt + jsonInstruction(schema))
                      return yield* decode(first).pipe(
                        // One chance to fix it, in the same session.
                        Effect.catch((e) =>
                          Effect.flatMap(ask(s, `That answer does not match the schema: ${e.message}\nReply with only the corrected JSON object.`), (second) =>
                            decode(second).pipe(Effect.mapError((e2) => new AgentError({ message: `${a.name} returned output that does not match the schema: ${e2.message}` }))),
                          ),
                        ),
                      )
                    }),
                  ),
              }
              return yield* use(turns, a)
            }),
          false,
          o.avoid,
        )

      return Agent.of({
        structured: (o) => session(o, (s) => s.structured(o.prompt, o.schema)),

        session,

        idle: () =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            return (yield* config.settings).accounts.filter((a) => a.enabled && stateOf(a.id).busy < a.concurrency && stateOf(a.id).until <= now)
          }),

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
                Stream.ensuring(logUsage(o.log, a, startedAt)),
              )
            }),
          ).pipe(Stream.scoped)
        },

        ticket: (o) =>
          Effect.scoped(
            Effect.gen(function* () {
              const cwd = yield* fs.makeTempDirectoryScoped({ prefix: 'pr-review-ticket-' }).pipe(Effect.mapError((e) => new AgentError({ message: e.message })))
              return yield* withAccount(
                { ...o, cwd },
                (a) =>
                  turn(
                    o.log,
                    a,
                    Effect.flatMap(acp.open(a, cwd, undefined, { tickets: true }), (session) =>
                      Effect.andThen(
                        o.model === 'fast' && a.fastModel ? session.setModel(a.fastModel) : Effect.void,
                        session.prompt(o.prompt).pipe(Stream.runFold(() => '', (acc, u) => (u._tag === 'Text' ? acc + u.delta : acc))),
                      ),
                    ),
                  ),
                true,
              )
            }),
          ),

        status: Effect.map(config.settings, (s) => s.accounts.map((a) => ({ id: a.id, ...stateOf(a.id) }))),
      })
    }),
  )
}
