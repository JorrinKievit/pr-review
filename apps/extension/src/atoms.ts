import { type AskTarget, type DecisionState, type Draft, type FindingState, type PrRef, ReviewRpcs } from '@pr-review/domain'
import { portClientProtocol } from '@pr-review/native-messaging'
import { Effect, Layer, Stream } from 'effect'
import { Atom, AtomRpc } from 'effect/reactivity'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { createContext, useContext } from 'react'

/** Class factory: `class X extends makeReviewClient<X>()(protocol) {}`. */
export const makeReviewClient =
  <Self>() =>
  <ER>(protocol: Layer.Layer<RpcClient.Protocol, ER>) =>
    AtomRpc.Service<Self>()('ReviewClient', { group: ReviewRpcs, protocol })

/** Pages talk to the background worker, which relays to the native host. */
export const chromeProtocol = portClientProtocol(Effect.sync(() => chrome.runtime.connect({ name: 'rpc' }))).pipe(Layer.provide(RpcSerialization.layerNdjson))

export class ReviewClient extends makeReviewClient<ReviewClient>()(chromeProtocol) {}

type Client = ReturnType<ReturnType<typeof makeReviewClient<any>>>

const refKey = (ref: PrRef) => `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`
const parse = (key: string): PrRef => {
  const [, host, owner, repo, n] = /^([^/]+)\/([^/]+)\/([^#]+)#(\d+)$/.exec(key)!
  return { host: host!, owner: owner!, repo: repo!, number: Number(n) }
}

export const makeAtoms = (client: Client) => {
  const rpc = Effect.gen(function* () {
    return yield* client
  })
  const pr = Atom.family((key: string) => Atom.keepAlive(client.runtime.atom(Effect.flatMap(rpc, (c) => c('GetPr', { ref: parse(key) })))))
  const sort = Atom.family((key: string) => {
    const [ref, headSha] = key.split('@') as [string, string]
    return Atom.keepAlive(client.runtime.atom(Stream.unwrap(Effect.map(rpc, (c) => c('Sort', { ref: parse(ref), headSha })))))
  })
  const patch = Atom.family((key: string) => {
    const { ref, mergeBase, headSha, path, previous } = JSON.parse(key) as { ref: PrRef; mergeBase: string; headSha: string; path: string; previous?: string }
    return client.runtime
      .atom(Effect.flatMap(rpc, (c) => c('GetFilePatch', { ref, mergeBase, headSha, path, ...(previous ? { previous } : {}) })))
      .pipe(Atom.setIdleTTL('5 minutes'))
  })
  // Short-lived: its media links expire after five minutes, so opening it again reads it again.
  const descriptions = Atom.family((key: string) => client.runtime.atom(Effect.flatMap(rpc, (c) => c('GetDescription', { ref: parse(key) }))).pipe(Atom.setIdleTTL('10 seconds')))
  const recall = Atom.family((key: string) => client.runtime.atom(Effect.flatMap(rpc, (c) => c('Recall', { key }))).pipe(Atom.setIdleTTL('5 minutes')))
  const drafts = Atom.family((key: string) => client.runtime.atom(Effect.flatMap(rpc, (c) => c('GetDrafts', { ref: parse(key) }))).pipe(Atom.keepAlive))
  const chats = Atom.family((key: string) => {
    const [ref, headSha] = key.split('@') as [string, string]
    return client.runtime.atom(Effect.flatMap(rpc, (c) => c('GetChats', { ref: parse(ref), headSha }))).pipe(Atom.setIdleTTL('5 minutes'))
  })
  const chatsAtom = (ref: PrRef, headSha: string) => chats(`${refKey(ref)}@${headSha}`)
  const stack = Atom.family((key: string) => Atom.keepAlive(client.runtime.atom(Stream.unwrap(Effect.map(rpc, (c) => c('Stack', { ref: parse(key) }))))))
  const opinion = Atom.family((key: string) => {
    const [ref, headSha, run] = key.split('@') as [string, string, string]
    return Atom.keepAlive(
      client.runtime.atom((get) =>
        Stream.unwrap(Effect.map(rpc, (c) => c('Opinion', { ref: parse(ref), headSha, run: run === 'run' }))).pipe(
          Stream.tap((e) => (e._tag === 'Done' && run === 'run' ? Effect.sync(() => get.refresh(cachedOpinion(ref, headSha))) : Effect.void)),
        ),
      ),
    )
  })
  const cachedOpinion = (ref: string, headSha: string): Atom.Atom<unknown> => opinion(`${ref}@${headSha}@cached`)
  const deeper = Atom.family((key: string) => {
    const { ref, headSha, decisionId } = JSON.parse(key) as { ref: PrRef; headSha: string; decisionId: string }
    return Atom.keepAlive(
      client.runtime.atom((get) =>
        Stream.unwrap(Effect.map(rpc, (c) => c('DigDeeper', { ref, headSha, decisionId }))).pipe(
          Stream.tap((e) => (e._tag === 'Done' ? Effect.sync(() => get.refresh(cachedOpinion(refKey(ref), headSha))) : Effect.void)),
        ),
      ),
    )
  })

  return {
    prAtom: (ref: PrRef) => pr(refKey(ref)),
    /** Latest `SortEvent`: Running while the agent works, then Done. */
    sortAtom: (ref: PrRef, headSha: string) => sort(`${refKey(ref)}@${headSha}`),
    /** `previous` is the path before the PR moved the file. */
    patchAtom: (ref: PrRef, mergeBase: string, headSha: string, path: string, previous?: string) => patch(JSON.stringify({ ref, mergeBase, headSha, path, previous })),
    stackAtom: (ref: PrRef) => stack(refKey(ref)),
    stateAtom: client.runtime.fn((a: { ref: PrRef; headSha: string; decisionId: string; state: DecisionState | null }) =>
      Effect.flatMap(rpc, (c) => c('SetState', a)),
    ),
    /** Claude's opinion on the PR. With `run` false it only reads a cached one (`Idle` without); a finished run refreshes that one, which the page shows. */
    opinionAtom: (ref: PrRef, headSha: string, run: boolean) => opinion(`${refKey(ref)}@${headSha}@${run ? 'run' : 'cached'}`),
    /** One decision looked at again on the strongest model; when done the cached opinion carries it. */
    deeperAtom: (ref: PrRef, headSha: string, decisionId: string) => deeper(JSON.stringify({ ref, headSha, decisionId })),
    findingStateAtom: client.runtime.fn((a: { ref: PrRef; headSha: string; findingId: string; state: FindingState | null }, get) =>
      Effect.flatMap(rpc, (c) => c('SetFindingState', a)).pipe(Effect.tap(() => Effect.sync(() => get.refresh(cachedOpinion(refKey(a.ref), a.headSha))))),
    ),
    /** Saved conversations for a head; refreshed whenever an answer finishes. */
    chatsAtom,
    /** The question being answered for a key (a line range or a decision), with the answer so far. Kept alive so closing the panel doesn't abort a paid answer. */
    askAtom: Atom.family((_key: string) =>
      client.runtime
        .fn((a: { ref: PrRef; headSha: string; target: AskTarget; question: string; followUp: boolean }, get) =>
          Stream.unwrap(Effect.map(rpc, (c) => c('Ask', a))).pipe(
            Stream.tap((e) => (e._tag === 'Done' ? Effect.sync(() => get.refresh(chatsAtom(a.ref, a.headSha))) : Effect.void)),
            Stream.scan(
              () => ({ question: a.question, text: '', done: false }),
              (s, e) => (e._tag === 'Text' ? { ...s, text: s.text + e.delta } : { ...s, done: true }),
            ),
          ),
        )
        .pipe(Atom.keepAlive),
    ),
    /** The PR body as GitHub renders it. */
    descriptionAtom: (ref: PrRef) => descriptions(refKey(ref)),
    /** Page state saved between visits, by key; `null` when nothing was saved. */
    recallAtom: recall,
    rememberAtom: client.runtime.fn((a: { key: string; value: string }) => Effect.flatMap(rpc, (c) => c('Remember', a))),
    /** Review comments not sent yet, per PR. */
    draftsAtom: (ref: PrRef) => drafts(refKey(ref)),
    saveDraftsAtom: client.runtime.fn((a: { ref: PrRef; drafts: ReadonlyArray<Draft> }, get) =>
      Effect.flatMap(rpc, (c) => c('SetDrafts', a)).pipe(Effect.tap(() => Effect.sync(() => get.refresh(drafts(refKey(a.ref)))))),
    ),
    /** Sends the drafts with the verdict; afterwards the PR is read again so the sent comments show. */
    submitReviewAtom: client.runtime.fn((a: { ref: PrRef; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body: string; commitId: string }, get) =>
      Effect.flatMap(rpc, (c) => c('SubmitReview', a)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            get.refresh(drafts(refKey(a.ref)))
            get.refresh(pr(refKey(a.ref)))
          }),
        ),
      ),
    ),
  }
}

export type Atoms = ReturnType<typeof makeAtoms>

export const atoms = makeAtoms(ReviewClient)

export const AtomsContext = createContext<Atoms>(atoms)
export const useAtoms = () => useContext(AtomsContext)
