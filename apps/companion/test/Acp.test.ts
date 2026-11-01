import * as acp from '@agentclientprotocol/sdk'
import { assert, describe, it } from '@effect/vitest'
import { type AgentAccount, AgentError } from '@pr-review/domain'
import { Effect, Stream } from 'effect'
import { Acp, type AcpSession, type AcpUpdate } from '../src/Acp.ts'

const account: AgentAccount = { id: 'a', name: 'Fake', agent: 'custom', command: 'unused', env: {}, concurrency: 2, enabled: true }

type Say = (update: acp.SessionUpdate) => Promise<void>
type Ask = (command: string) => Promise<boolean>

/** An ACP agent in-process: answers each prompt with `turn`, and records what the client asked of it. */
const fakeAgent = (o: { turn?: (say: Say, ask: Ask, text: string) => Promise<acp.StopReason>; needsLogin?: boolean } = {}) => {
  const seen = { modes: [] as string[], models: [] as string[], auth: [] as string[], resumed: [] as string[], prompts: [] as string[] }
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
    .onRequest(acp.methods.agent.session.new, () => {
      if (o.needsLogin && !loggedIn) throw acp.RequestError.authRequired()
      return { sessionId: 'S1', modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'read-only', name: 'Read only' }] } }
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
      const ask: Ask = async (command) => {
        const id = `t${++n}`
        await say({ sessionUpdate: 'tool_call', toolCallId: id, title: command, kind: 'execute', status: 'pending', rawInput: { command } })
        const r = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: id, title: command, kind: 'execute', rawInput: { command } },
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

const run = <A>(agent: ReturnType<typeof fakeAgent>, f: (s: AcpSession) => Effect.Effect<A, AgentError>, a: AgentAccount = account, resume?: string) =>
  Effect.gen(function* () {
    const session = yield* (yield* Acp).open(a, '/repo', resume)
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
