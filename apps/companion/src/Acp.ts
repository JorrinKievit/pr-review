import * as acp from '@agentclientprotocol/sdk'
import { AgentError, type AgentAccount } from '@pr-review/domain'
import { Context, Effect, Fiber, Layer, Queue, type Scope, Stream } from 'effect'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { safeGhCommand, safeGitCommand } from './gitOnly.ts'
import { loginPath } from './shellPath.ts'
import { ticketPermission } from './permissions.ts'
import { describeTool } from './steps.ts'

export type AcpUpdate = { readonly _tag: 'Text'; readonly delta: string } | { readonly _tag: 'Step'; readonly step: string }

/** One agent session on one account. Each prompt streams until the agent ends its turn. */
export interface AcpSession {
  readonly sessionId: string
  prompt(text: string): Stream.Stream<AcpUpdate, AgentError>
}

/** How to reach an account's agent: a spawned ACP server in the companion, an in-process fake in tests. */
export type Launch = (account: AgentAccount, cwd: string) => Effect.Effect<{ target: acp.Stream | acp.AgentApp; output: () => string }, AgentError, Scope.Scope>

// Claude Code's own settings could allow tools past the gate; its ACP adapter takes SDK options here.
const disallowedTools = ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']
const claudeOptions = { claudeCode: { options: { settingSources: [], disallowedTools } } }
// The ticket session loads the user's own config so their tracker MCP servers are there; it never sees PR code, and can't read files or fetch URLs.
const ticketOptions = { claudeCode: { options: { settingSources: ['user'], disallowedTools: [...disallowedTools, 'Read', 'Glob', 'Grep', 'Bash'] } } }
const READ_ONLY_MODES = [/read.?only/i, /^ask$/i, /^plan$/i, /^default$/i, /manual/i]

const agentError = (e: unknown, output = '') =>
  new AgentError({ message: [e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String(e.message) : String(e), output.trim().split('\n').slice(-3).join(' ')].filter(Boolean).join(': ') })

/** Answer text, and each shell command once as a step for the loading line. */
const toUpdate = (u: acp.SessionUpdate, seen: Set<string>): AcpUpdate | undefined => {
  if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') return { _tag: 'Text', delta: u.content.text }
  if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return undefined
  const command = (u.rawInput as { command?: unknown } | undefined)?.command
  if (typeof command !== 'string' || seen.has(u.toolCallId)) return undefined
  seen.add(u.toolCallId)
  return { _tag: 'Step', step: describeTool('Bash', { command }) }
}

const expandHome = (v: string) => (v === '~' || v.startsWith('~/') ? homedir() + v.slice(1) : v)

/** Starts `account.command` through the shell, on the user's own PATH. Keys that would bill an API instead of the login are left out. */
export const spawnAgent: Launch = (account, cwd) =>
  Effect.gen(function* () {
    const PATH = (yield* Effect.promise(loginPath)) ?? process.env.PATH
    const env: NodeJS.ProcessEnv = { ...process.env, PATH, ...Object.fromEntries(Object.entries(account.env).map(([k, v]) => [k, expandHome(v)])) }
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) if (!(key in account.env)) delete env[key]
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => spawn(account.command, { shell: true, cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })),
      (c) => Effect.sync(() => void c.kill()),
    )
    let output = ''
    child.stderr.on('data', (d: Buffer) => (output = (output + d.toString()).slice(-4000)))
    child.on('error', (e) => (output += `\n${e.message}`))
    const target = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
    return { target, output: () => output }
  })

export class Acp extends Context.Service<Acp, { open(account: AgentAccount, cwd: string, resume?: string, o?: { related?: ReadonlyArray<string>; tickets?: boolean }): Effect.Effect<AcpSession, AgentError, Scope.Scope> }>()(
  'pr-review/Acp',
) {
  static readonly layerWith = (launch: Launch) =>
    Layer.succeed(
      Acp,
      Acp.of({
        open: (account, cwd, resume, o) =>
          Effect.gen(function* () {
            const { target, output } = yield* launch(account, cwd)
            const updates = yield* Queue.unbounded<acp.SessionNotification | 'stop'>()
            const fail = (e: unknown) => agentError(e, output())
            const call = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: fail })

            const app = acp
              .client({ name: 'pr-review' })
              .onNotification(acp.methods.client.session.update, (ctx) => void Queue.offerUnsafe(updates, ctx.params))
              .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
                const raw = ctx.params.toolCall.rawInput as { command?: unknown } | undefined
                const allowed = o?.tickets
                  ? ticketPermission(ctx.params.toolCall)
                  : ctx.params.toolCall.kind === 'execute' && typeof raw?.command === 'string' && (safeGitCommand(raw.command) || safeGhCommand(raw.command, o?.related ?? []))
                const option = ctx.params.options.find((o) => o.kind === (allowed ? 'allow_once' : 'reject_once')) ?? ctx.params.options.find((o) => o.kind.startsWith(allowed ? 'allow' : 'reject'))
                return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
              })
            const connection = yield* Effect.acquireRelease(
              Effect.sync(() => (typeof (target as acp.AgentApp).onRequest === 'function' ? app.connect(target as acp.AgentApp) : app.connect(target as acp.Stream))),
              (c) => Effect.sync(() => c.close()),
            )
            const agent = connection.agent

            const init = yield* call(() => agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }))
            const caps = init.agentCapabilities
            const _meta = o?.tickets ? ticketOptions : claudeOptions
            const start = () =>
              resume
                ? caps?.sessionCapabilities?.resume
                  ? agent.request(acp.methods.agent.session.resume, { sessionId: resume, cwd, mcpServers: [], _meta })
                  : agent.request(acp.methods.agent.session.load, { sessionId: resume, cwd, mcpServers: [], _meta })
                : agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [], _meta })
            // Agents that keep their own login (Cursor, Gemini) want it named first; an API key is never offered.
            const login = init.authMethods?.find((m) => m.id !== 'api-key' && !('type' in m && m.type === 'terminal'))
            const session = yield* call(start).pipe(
              Effect.catch((e) =>
                login && /auth/i.test(e.message)
                  ? Effect.andThen(
                      call(() => agent.request(acp.methods.agent.authenticate, { methodId: login.id })),
                      call(start),
                    )
                  : Effect.fail(e),
              ),
              Effect.mapError((e) => (/auth/i.test(e.message) ? new AgentError({ message: `${account.name} is not logged in: ${e.message}` }) : e)),
            )
            const sessionId = resume ?? (session as acp.NewSessionResponse).sessionId
            // Replayed history from a load is not part of the next answer.
            yield* Queue.clear(updates)

            const modes = 'modes' in session ? session.modes?.availableModes : undefined
            const mode = account.mode ?? READ_ONLY_MODES.map((r) => modes?.find((m) => r.test(m.id))?.id).find(Boolean)
            if (mode && mode !== ('modes' in session ? session.modes?.currentModeId : undefined))
              yield* call(() => agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: mode }))
            if (account.model) yield* call(() => agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'model', value: account.model! }))

            const steps = new Set<string>()
            return {
              sessionId,
              prompt: (text) =>
                Stream.unwrap(
                  Effect.gen(function* () {
                    const turn = yield* Effect.forkScoped(
                      call(() => agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] })).pipe(
                        Effect.flatMap((r) => (r.stopReason === 'end_turn' ? Effect.void : Effect.fail(new AgentError({ message: `${account.name} stopped: ${r.stopReason}` })))),
                        Effect.ensuring(Queue.offer(updates, 'stop')),
                      ),
                    )
                    return Stream.fromQueue(updates).pipe(
                      Stream.takeWhile((u): u is acp.SessionNotification => u !== 'stop'),
                      Stream.map((u) => toUpdate(u.update, steps)),
                      Stream.filter((u): u is AcpUpdate => u !== undefined),
                      Stream.concat(Stream.fromEffect(Fiber.join(turn)).pipe(Stream.drain)),
                    )
                  }),
                ),
            } satisfies AcpSession
          }),
      }),
    )

  static readonly layer = Acp.layerWith(spawnAgent)
}

