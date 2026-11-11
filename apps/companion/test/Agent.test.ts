import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { type AgentAccount, AgentError, defaultSettings } from '@pr-review/domain'
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Acp } from '../src/Acp.ts'
import { Agent } from '../src/Agent.ts'
import { Config } from '../src/Config.ts'
import { tmp } from './helpers.ts'

const log = { kind: 'sort' as const, owner: 'o', repo: 'r', number: 7, headSha: 'abc' }
const account = (id: string, concurrency = 1): AgentAccount => ({ id, name: `Agent ${id}`, agent: 'custom', command: 'x', env: {}, concurrency, enabled: true })

type Answer = (a: AgentAccount, prompt: string) => Effect.Effect<string, AgentError>

/** An Acp whose sessions answer each prompt with `answer`, after one step. */
const setup = (answer: Answer, accounts = [account('a'), account('b')]) => {
  const opened: Array<{ account: string; resume: string | undefined; cwd: string; tickets?: boolean }> = []
  const prompts: string[] = []
  const acp = Layer.succeed(
    Acp,
    Acp.of({
      open: (a, cwd, resume, o) =>
        Effect.sync(() => {
          opened.push({ account: a.id, resume, cwd, ...(o?.tickets ? { tickets: true } : {}) })
          return {
            sessionId: resume ?? `S-${a.id}`,
            prompt: (text) =>
              Stream.unwrap(Effect.map(Effect.suspend(() => (prompts.push(text), answer(a, text))), (t) => Stream.make({ _tag: 'Step' as const, step: 'Reading a.ts' }, { _tag: 'Text' as const, delta: t }))),
          }
        }),
    }),
  )
  const cacheRoot = tmp()
  const config = Config.layerTest({ cacheRoot, settings: { ...defaultSettings, accounts } })
  const layer = Agent.layer.pipe(Layer.provide([acp, config, NodeServices.layer]))
  return { layer, opened, prompts, usagePath: join(cacheRoot, 'usage.jsonl') }
}

const Ok = Schema.Struct({ ok: Schema.Boolean })
const structured = (steps: string[] = []) =>
  Effect.gen(function* () {
    return yield* (yield* Agent).structured({ prompt: 'Sort this', schema: Ok, cwd: '/repo', log, onStep: (s) => Effect.sync(() => void steps.push(s)) })
  })

describe('Agent.structured', () => {
  it.live('asks for JSON in the schema and decodes the answer, fenced or not', () =>
    Effect.gen(function* () {
      const { layer, prompts } = setup(() => Effect.succeed('Here you go:\n```json\n{"ok": true}\n```'))
      const steps: string[] = []
      assert.deepStrictEqual(yield* structured(steps).pipe(Effect.provide(layer)), { ok: true })
      assert.match(prompts[0]!, /^Sort this[\s\S]*JSON Schema[\s\S]*"ok"/)
      assert.deepStrictEqual(steps, ['Agent a is reading the PR', 'Reading a.ts'])
    }))

  it.live('gives the agent one chance to fix an answer that does not match', () =>
    Effect.gen(function* () {
      const fixed = setup((_a, p) => Effect.succeed(p.startsWith('That answer') ? '{"ok": false}' : '{"ok": "yes"}'))
      assert.deepStrictEqual(yield* structured().pipe(Effect.provide(fixed.layer)), { ok: false })
      assert.strictEqual(fixed.opened.length, 1)
      const broken = setup(() => Effect.succeed('no json here'))
      const e = yield* Effect.flip(structured().pipe(Effect.provide(broken.layer)))
      assert.match(e.message, /Agent a returned output that does not match the schema/)
      assert.strictEqual(broken.prompts.length, 2)
    }))

  it.live('spreads runs over the accounts, and waits when all are busy', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { layer, opened } = setup(() => Effect.as(Deferred.await(gate), '{"ok": true}'))
      yield* Effect.gen(function* () {
        const steps: string[] = []
        const runs = yield* Effect.forEach([[], [], steps], (s) => Effect.forkChild(structured(s)))
        yield* Effect.sleep('100 millis')
        assert.deepStrictEqual(opened.map((o) => o.account).sort(), ['a', 'b'])
        assert.include(steps, 'Waiting for a free AI account')
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.joinAll(runs)
        assert.strictEqual(opened.length, 3)
      }).pipe(Effect.provide(layer))
    }))

  it.live('prefer deep picks a deep account', () =>
    Effect.gen(function* () {
      const { layer, opened } = setup(() => Effect.succeed('{"ok": true}'), [account('a'), { ...account('b'), deep: true }])
      const agent = yield* Agent.pipe(Effect.provide(layer))
      yield* agent.structured({ prompt: 'x', schema: Ok, cwd: '/repo', log, prefer: 'deep' })
      yield* agent.structured({ prompt: 'x', schema: Ok, cwd: '/repo', log, prefer: 'deep' })
      assert.deepStrictEqual(opened.map((o) => o.account), ['b', 'b'])
    }))

  it.live('prefer deep falls back to the pool', () =>
    Effect.gen(function* () {
      const { layer, opened } = setup(() => Effect.succeed('{"ok": true}'), [account('a'), { ...account('b'), deep: true, enabled: false }])
      const agent = yield* Agent.pipe(Effect.provide(layer))
      yield* agent.structured({ prompt: 'x', schema: Ok, cwd: '/repo', log, prefer: 'deep' })
      assert.deepStrictEqual(opened.map((o) => o.account), ['a'])
    }))

  it.live('an account at its usage limit sits out, and the run moves to another', () =>
    Effect.gen(function* () {
      const { layer, opened } = setup((a) => (a.id === 'a' ? Effect.fail(new AgentError({ message: "You've hit your usage limit" })) : Effect.succeed('{"ok": true}')))
      yield* Effect.gen(function* () {
        const steps: string[] = []
        assert.deepStrictEqual(yield* structured(steps), { ok: true })
        assert.include(steps, 'Agent a is at its limit; trying another account')
        yield* structured()
        // a sat out the second run.
        assert.deepStrictEqual(opened.map((o) => o.account), ['a', 'b', 'b'])
        const status = yield* (yield* Agent).status
        assert.match(status.find((s) => s.id === 'a')!.error ?? '', /usage limit/)
      }).pipe(Effect.provide(layer))
    }))

  it.live('says when every account is sitting out', () =>
    Effect.gen(function* () {
      const { layer } = setup(() => Effect.fail(new AgentError({ message: 'rate limit reached' })))
      yield* Effect.gen(function* () {
        assert.match((yield* Effect.flip(structured())).message, /rate limit/)
        assert.match((yield* Effect.flip(structured())).message, /Every AI account is sitting out until/)
      }).pipe(Effect.provide(layer))
    }))

  it.live('other failures are the answer, not a reason to try another account', () =>
    Effect.gen(function* () {
      const { layer, opened } = setup(() => Effect.fail(new AgentError({ message: 'Agent a stopped: refusal' })))
      const e = yield* Effect.flip(structured().pipe(Effect.provide(layer)))
      assert.match(e.message, /refusal/)
      assert.strictEqual(opened.length, 1)
    }))

  it.live('without an account in the pool it says where to add one', () =>
    Effect.gen(function* () {
      const { layer } = setup(() => Effect.succeed('{}'), [{ ...account('a'), enabled: false }])
      const e = yield* Effect.flip(structured().pipe(Effect.provide(layer)))
      assert.match(e.message, /Add or enable one in the settings/)
    }))

  it.effect('stops at the time limit from the settings', () =>
    Effect.gen(function* () {
      const { layer } = setup(() => Effect.never)
      const run = yield* Effect.forkChild(structured().pipe(Effect.provide(layer), Effect.flip))
      yield* TestClock.adjust('10 minutes')
      assert.match((yield* Fiber.join(run)).message, /took longer than 10 minutes/)
    }))

  it.live('logs each run with its account', () =>
    Effect.gen(function* () {
      const { layer, usagePath } = setup(() => Effect.succeed('{"ok": true}'))
      yield* structured().pipe(Effect.provide(layer))
      const line = JSON.parse(readFileSync(usagePath, 'utf8').trim())
      assert.strictEqual(line.account, 'Agent a')
      assert.strictEqual(line.kind, 'sort')
    }))
})

describe('Agent.ticket', () => {
  const ticket = Effect.gen(function* () {
    return yield* (yield* Agent).ticket({ prompt: 'Fetch ABC-1', log: { ...log, kind: 'ticket' } })
  })

  it.live('runs on an account set to read tickets, in an empty temp dir removed after', () =>
    Effect.gen(function* () {
      const { layer, opened } = setup((_a, p) => Effect.succeed(`summary of ${p}`), [account('a'), { ...account('b'), tickets: true }])
      assert.strictEqual(yield* ticket.pipe(Effect.provide(layer)), 'summary of Fetch ABC-1')
      assert.deepInclude(opened[0], { account: 'b', tickets: true })
      assert.notStrictEqual(opened[0]!.cwd, '/repo')
      assert.isFalse(existsSync(opened[0]!.cwd))
    }))

  it.live('without such an account it says so', () =>
    Effect.gen(function* () {
      const { layer } = setup(() => Effect.succeed('x'), [account('a'), { ...account('b'), tickets: true, enabled: false }])
      const e = yield* Effect.flip(ticket.pipe(Effect.provide(layer)))
      assert.strictEqual(e.message, 'No AI account is set to read tickets')
    }))
})

describe('Agent.streaming', () => {
  const ask = (resume?: string) =>
    Effect.gen(function* () {
      return [...(yield* Stream.runCollect((yield* Agent).streaming({ prompt: 'why?', cwd: '/repo', log, ...(resume ? { resume } : {}) })))]
    })

  it.live('streams the answer, then Done with a session id that names the account', () =>
    Effect.gen(function* () {
      const { layer } = setup(() => Effect.succeed('Because.'))
      assert.deepStrictEqual(yield* ask().pipe(Effect.provide(layer)), [
        { _tag: 'Text', delta: 'Because.' },
        { _tag: 'Done', sessionId: 'a:S-a' },
      ])
    }))

  it.live('a follow-up resumes the session on the account it ran on', () =>
    Effect.gen(function* () {
      const { layer, opened } = setup(() => Effect.succeed('More.'))
      const events = yield* ask('b:S-old').pipe(Effect.provide(layer))
      assert.deepStrictEqual(opened, [{ account: 'b', resume: 'S-old', cwd: '/repo' }])
      assert.deepStrictEqual(events.at(-1), { _tag: 'Done', sessionId: 'b:S-old' })
    }))
})
