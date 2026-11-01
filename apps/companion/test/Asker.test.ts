import { assert, describe, it } from '@effect/vitest'
import type { AskTarget, Decision } from '@pr-review/domain'
import { Effect, Layer, Stream } from 'effect'
import { Asker } from '../src/Asker.ts'
import { configLayer, fakeAgent, fakeGit, ref } from './fakes.ts'

const setup = () => {
  const agent = fakeAgent()
  const git = fakeGit({ show: ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n') })
  const layer = Asker.layer.pipe(Layer.provide([agent.layer, git.layer, configLayer()]))
  const ask = (target: AskTarget, question: string, sessionId?: string) =>
    Effect.gen(function* () {
      return yield* Stream.runCollect((yield* Asker).ask(ref, 'HEAD1', target, question, sessionId))
    }).pipe(Effect.provide(layer))
  return { agent, git, ask }
}

const lines: AskTarget = { _tag: 'Lines', path: 'src/a.ts', start: 2, end: 3, side: 'RIGHT', commit: 'HEAD1' }

describe('Asker', () => {
  it.effect('first question includes selected lines', () =>
    Effect.gen(function* () {
      const { agent, ask } = setup()
      const events = yield* ask(lines, 'Where is this used?')
      const p = agent.calls[0]!.prompt
      assert.match(p, /src\/a\.ts:2-3/)
      assert.match(p, /2: l2\n3: l3/)
      assert.notMatch(p, /l4/)
      assert.match(p, /Where is this used\?/)
      assert.match(p, /HEAD1/)
      assert.match(p, /origin\/master/)
      assert.match(p, /never `cd`/)
      assert.deepStrictEqual(events, [{ _tag: 'Text', delta: 'Hi' }, { _tag: 'Done', sessionId: 'sess-1' }])
      assert.strictEqual(agent.calls[0]!.log.kind, 'ask')
    }))

  it.effect('deleted lines are quoted from the commit they belong to', () =>
    Effect.gen(function* () {
      const { agent, git, ask } = setup()
      yield* ask({ ...lines, side: 'LEFT', commit: 'MB1' }, 'Why removed?')
      assert.deepStrictEqual(git.shown, ['MB1'])
      assert.match(agent.calls[0]!.prompt, /removed/)
    }))

  it.effect('decision question includes title and note and logs as chat', () =>
    Effect.gen(function* () {
      const { agent, ask } = setup()
      const decision: Decision = {
        id: 'api-client', title: 'New Planning API client setup', lens: 'architecture', reason: 'departs', theme: 'API client',
        note: 'Patches the spec on generation.', existing: { path: 'packages/api-client-core/openapi-ts.config.ts', why: 'default setup' }, authorWhy: null,
        files: [{ path: 'packages/api-client-planning/openapi-ts.config.ts', ranges: [{ start: 3, end: 36 }] }],
      }
      yield* ask({ _tag: 'Decision', decision }, 'Why?')
      const p = agent.calls[0]!.prompt
      assert.match(p, /New Planning API client setup/)
      assert.match(p, /Patches the spec on generation\./)
      assert.match(p, /openapi-ts\.config\.ts:3-36/)
      assert.strictEqual(agent.calls[0]!.log.kind, 'chat')
    }))

  it.effect('follow-up sends only the question and resumes', () =>
    Effect.gen(function* () {
      const { agent, ask } = setup()
      yield* ask(lines, 'And in core?', 'sess-1')
      assert.strictEqual(agent.calls[0]!.prompt, 'And in core?')
      assert.strictEqual(agent.calls[0]!.resume, 'sess-1')
    }))

  it.effect('ask uses opus in the clone', () =>
    Effect.gen(function* () {
      const { agent, ask } = setup()
      yield* ask(lines, 'q')
      assert.strictEqual(agent.calls[0]!.cwd, '/cache/repo.git')
    }))
})
