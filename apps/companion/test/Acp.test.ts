import * as acp from '@agentclientprotocol/sdk'
import { assert, describe, it } from '@effect/vitest'
import { type AgentAccount, AgentError } from '@pr-review/domain'
import { Effect, Stream } from 'effect'
import { Acp, type AcpSession, type AcpUpdate } from '../src/Acp.ts'

const account: AgentAccount = { id: 'a', name: 'Fake', agent: 'custom', command: 'unused', env: {}, concurrency: 2, enabled: true }

type Say = (update: acp.SessionUpdate) => Promise<void>
type Ask = (command: string, kind?: acp.ToolKind) => Promise<boolean>

/** An ACP agent in-process: answers each prompt with `turn`, and records what the client asked of it. */
const fakeAgent = (o: { turn?: (say: Say, ask: Ask, text: string) => Promise<acp.StopReason>; needsLogin?: boolean } = {}) => {
  const seen = { modes: [] as string[], models: [] as string[], auth: [] as string[], resumed: [] as string[], prompts: [] as string[], meta: [] as unknown[] }
  let loggedIn = false
  const app = acp
    .agent({ name: 'fake' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      authMethods: [{ id: 'api-key', name: 'API key' }, { id: 'own-login', name: 'Existing login' }],
    }))
    .onRequest(acp.methods.agent.authenticate, (ctx) => {
      seen.auth.push(ctx.params.methodId)
      loggedIn = true
      return {}
    })
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      seen.meta.push(ctx.params._meta)
      if (o.needsLogin && !loggedIn) throw acp.RequestError.authRequired()
      return {
        sessionId: 'S1',
        modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'read-only', name: 'Read only' }] },
        configOptions: [{ type: 'select', id: 'model', name: 'Model', currentValue: 'default', options: [{ value: 'default', name: 'Default' }] }],
      }
    })
    .onRequest(acp.methods.agent.session.resume, (ctx) => {
      seen.resumed.push(ctx.params.sessionId)
      return {}
    })
    .onRequest(acp.methods.agent.session.setMode, (ctx) => {
      seen.modes.push(ctx.params.modeId)
      return {}
    })
    .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
      seen.models.push(String(ctx.params.value))
      return { configOptions: [] }
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const text = ctx.params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')
      seen.prompts.push(text)
      const say: Say = (update) => ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update })
      let n = 0
      const ask: Ask = async (command, kind = 'execute') => {
        const id = `t${++n}`
        await say({ sessionUpdate: 'tool_call', toolCallId: id, title: command, kind, status: 'pending', rawInput: { command } })
        const r = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: id, title: command, kind, rawInput: { command } },
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        })
        return r.outcome.outcome === 'selected' && r.outcome.optionId === 'yes'
      }
      return { stopReason: o.turn ? await o.turn(say, ask, text) : 'end_turn' }
    })
  return { app, seen }
}

const run = <A>(agent: ReturnType<typeof fakeAgent>, f: (s: AcpSession) => Effect.Effect<A, AgentError>, a: AgentAccount = account, resume?: string, o?: { related?: ReadonlyArray<string>; tickets?: boolean }) =>
  Effect.gen(function* () {
    const session = yield* (yield* Acp).open(a, '/repo', resume, o)
    return yield* f(session)
  }).pipe(Effect.scoped, Effect.provide(Acp.layerWith(() => Effect.succeed({ target: agent.app, output: () => '' }))))

const collect = (s: Stream.Stream<AcpUpdate, AgentError>) => Effect.map(Stream.runCollect(s), (c) => [...c])

describe('Acp', () => {
  it.live('streams the answer and each shell command as a step, then ends with the turn', () =>
    Effect.gen(function* () {
      const agent = fakeAgent({
        turn: async (say, ask) => {
          await ask('git log -1')
          await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } })
          await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } })
          return 'end_turn'
        },
      })
      const updates = yield* run(agent, (s) => collect(s.prompt('hi')))
      assert.deepStrictEqual(updates, [
        { _tag: 'Step', step: 'Reading the history' },
        { _tag: 'Text', delta: 'Hel' },
        { _tag: 'Text', delta: 'lo' },
      ])
      assert.deepStrictEqual(agent.seen.prompts, ['hi'])
    }))

  it.live('lets the agent read the repo through git, and refuses everything else', () =>
    Effect.gen(function* () {
      const answers: boolean[] = []
      const agent = fakeAgent({
        turn: async (_say, ask) => {
          for (const c of ['git show HEAD:a.ts', 'cat ~/.ssh/id_rsa', 'git push origin x']) answers.push(await ask(c))
          return 'end_turn'
        },
      })
      yield* run(agent, (s) => collect(s.prompt('go')))
      assert.deepStrictEqual(answers, [true, false, false])
    }))

  it.live('a related gh read is allowed in a review session, other gh calls are not', () =>
    Effect.gen(function* () {
      const answers: boolean[] = []
      const agent = fakeAgent({
        turn: async (_say, ask) => {
          for (const c of ['gh api --hostname h repos/o/svc/contents/a.php', 'gh api --hostname h repos/o/other/contents/a.php', 'gh api -X DELETE repos/o/svc/contents/a.php', 'gh pr merge 1']) answers.push(await ask(c))
          return 'end_turn'
        },
      })
      yield* run(agent, (s) => collect(s.prompt('go')), account, undefined, { related: ['h/o/svc'] })
      assert.deepStrictEqual(answers, [true, false, false, false])
      answers.length = 0
      yield* run(agent, (s) => collect(s.prompt('go')))
      assert.deepStrictEqual(answers, [false, false, false, false])
    }))

  it.live('ticket mode loads user settings and allows reads only', () =>
    Effect.gen(function* () {
      const answers: boolean[] = []
      const agent = fakeAgent({
        turn: async (_say, ask) => {
          answers.push(await ask('git log -1'), await ask('cat a', 'read'), await ask('https://evil.example', 'fetch'), await ask('Grep', 'search'), await ask('mcp__tracker__searchIssues', 'search'), await ask('mcp__tracker__getIssue', 'other'), await ask('mcp__tracker__addComment', 'other'))
          return 'end_turn'
        },
      })
      yield* run(agent, (s) => collect(s.prompt('go')), account, undefined, { tickets: true })
      assert.deepStrictEqual(answers, [false, false, false, false, true, true, false])
      const options = (i: number) => (agent.seen.meta[i] as { claudeCode: { options: { settingSources: string[]; disallowedTools: string[] } } }).claudeCode.options
      assert.deepStrictEqual(options(0).settingSources, ['user'])
      for (const tool of ['Edit', 'Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch']) assert.include(options(0).disallowedTools, tool)
      yield* run(agent, () => Effect.void)
      assert.deepStrictEqual(options(1).settingSources, [])
      assert.notInclude(options(1).disallowedTools, 'Read')
    }))

  it.live('picks a read-only mode the agent offers, or the account mode, and the account model', () =>
    Effect.gen(function* () {
      const offered = fakeAgent()
      yield* run(offered, () => Effect.void)
      assert.deepStrictEqual(offered.seen.modes, ['read-only'])
      const chosen = fakeAgent()
      yield* run(chosen, () => Effect.void, { ...account, mode: 'agent', model: 'big' })
      assert.deepStrictEqual(chosen.seen.modes, [])
      assert.deepStrictEqual(chosen.seen.models, ['big'])
    }))

  it.live('switches model only when it changes, and knows the agent default', () =>
    Effect.gen(function* () {
      const agent = fakeAgent()
      const defaults = yield* run(agent, (s) => Effect.as(Effect.all([s.setModel('big'), s.setModel('quick'), s.setModel('quick'), s.setModel('big')]), s.defaultModel), { ...account, model: 'big' })
      assert.strictEqual(defaults, 'default')
      assert.deepStrictEqual(agent.seen.models, ['big', 'quick', 'big'])
    }))

  it.live('logs in with the agent’s own login when it asks, never with an API key', () =>
    Effect.gen(function* () {
      const agent = fakeAgent({ needsLogin: true })
      yield* run(agent, () => Effect.void)
      assert.deepStrictEqual(agent.seen.auth, ['own-login'])
    }))

  it.live('resumes an earlier session', () =>
    Effect.gen(function* () {
      const agent = fakeAgent()
      const id = yield* run(agent, (s) => Effect.succeed(s.sessionId), account, 'S0')
      assert.strictEqual(id, 'S0')
      assert.deepStrictEqual(agent.seen.resumed, ['S0'])
    }))

  it.live('a turn that does not end normally fails', () =>
    Effect.gen(function* () {
      const agent = fakeAgent({ turn: async () => 'refusal' })
      const e = yield* Effect.flip(run(agent, (s) => collect(s.prompt('x'))))
      assert.instanceOf(e, AgentError)
      assert.match(e.message, /Fake stopped: refusal/)
    }))

  it.live('an agent error fails the turn with its message', () =>
    Effect.gen(function* () {
      const agent = fakeAgent({
        turn: async () => {
          throw new acp.RequestError(-32000, "You've hit your usage limit. Resets 5pm")
        },
      })
      const e = yield* Effect.flip(run(agent, (s) => collect(s.prompt('x'))))
      assert.match(e.message, /usage limit/)
    }))
})
