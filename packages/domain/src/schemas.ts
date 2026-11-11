import { Schema } from 'effect'
import { FindingStates, PrOpinion } from './opinion.ts'

export const FileStat = Schema.Struct({
  path: Schema.String,
  /** The path before the PR, when it moved the file. */
  previous: Schema.optionalKey(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
})
export type FileStat = typeof FileStat.Type

export const Checks = Schema.Literals(['pass', 'fail', 'pending', 'none'])
export type Checks = typeof Checks.Type

export const PrRef = Schema.Struct({ host: Schema.String, owner: Schema.String, repo: Schema.String, number: Schema.Number })
export type PrRef = typeof PrRef.Type

export const PrMeta = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  author: Schema.String,
  body: Schema.String,
  baseRef: Schema.String,
  headRef: Schema.String,
  headSha: Schema.String,
  state: Schema.String,
})
export type PrMeta = typeof PrMeta.Type

export const StackEntry = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  /** The opening paragraph of the PR body, when it has one. */
  description: Schema.optionalKey(Schema.String),
  headRef: Schema.String,
  baseRef: Schema.String,
  headSha: Schema.String,
  /** Whether the PR body has anything in it, so the stack can offer its description. */
  hasBody: Schema.optionalKey(Schema.Boolean),
})
export type StackEntry = typeof StackEntry.Type

export const Side = Schema.Literals(['LEFT', 'RIGHT'])

export const Thread = Schema.Struct({
  id: Schema.Number,
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  side: Side,
  author: Schema.String,
  body: Schema.String,
  inReplyTo: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
})
export type Thread = typeof Thread.Type

/** A review comment not sent yet; the whole set goes to GitHub as one review. */
export const Draft = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  line: Schema.Number,
  startLine: Schema.optionalKey(Schema.Number),
  side: Side,
  body: Schema.String,
})
export type Draft = typeof Draft.Type

/** Files nobody needs to read. Rule groups are `tests`, `generated`, `translations` and `lockfiles`; Claude names its own. */
export const TrustedGroup = Schema.Struct({
  group: Schema.String.annotate({ description: 'short name for the group, such as "Tests", "Generated API client", "Translations"' }),
  why: Schema.String.annotate({ description: 'one sentence: why nobody needs to read these files' }),
  files: Schema.Array(Schema.String),
})
export type TrustedGroup = typeof TrustedGroup.Type

export const Lens = Schema.Literals(['architecture', 'quality', 'ui'])
export type Lens = typeof Lens.Type

export const Reason = Schema.Literals(['departs', 'shared-layer', 'duplicate', 'convention', 'permissions', 'data-model', 'dependency', 'config'])
export type Reason = typeof Reason.Type

export const LineRange = Schema.Struct({ start: Schema.Number, end: Schema.Number })
export type LineRange = typeof LineRange.Type

export const Decision = Schema.Struct({
  id: Schema.String.annotate({ description: 'short kebab-case slug, unique in this PR' }),
  title: Schema.String,
  lens: Lens,
  reason: Reason,
  theme: Schema.String,
  note: Schema.String,
  existing: Schema.NullOr(Schema.Struct({ path: Schema.String, why: Schema.String })),
  authorWhy: Schema.NullOr(Schema.String),
  files: Schema.Array(Schema.Struct({ path: Schema.String, ranges: Schema.Array(LineRange) })),
})
export type Decision = typeof Decision.Type

const highImpactReasons: ReadonlyArray<Reason> = ['shared-layer', 'data-model', 'permissions', 'departs', 'duplicate', 'dependency']

export const impact = (d: Decision): 'high' | 'low' => (d.lens === 'architecture' || highImpactReasons.includes(d.reason) ? 'high' : 'low')

export const SkimArea = Schema.Struct({ area: Schema.String, summary: Schema.String, files: Schema.Array(Schema.String) })
export type SkimArea = typeof SkimArea.Type

export const AuthorClaim = Schema.Struct({ text: Schema.String, decisionIds: Schema.Array(Schema.String) })
export type AuthorClaim = typeof AuthorClaim.Type

/** What the sort agent returns; the companion normalizes it into a SortResult. */
export const AgentSort = Schema.Struct({
  summary: Schema.optionalKey(Schema.String.annotate({ description: 'one sentence: what this PR does, for someone who has not opened it' })),
  decisions: Schema.Array(Decision),
  skim: Schema.Array(SkimArea),
  trusted: Schema.optionalKey(Schema.Array(TrustedGroup)),
  claims: Schema.Array(AuthorClaim),
})
export type AgentSort = typeof AgentSort.Type

export const SortResult = Schema.Struct({
  headSha: Schema.String,
  /** Absent on sorts cached before re-review compared against the merge base. */
  mergeBase: Schema.optionalKey(Schema.String),
  /** Absent on sorts cached before summaries existed. */
  summary: Schema.optionalKey(Schema.String),
  decisions: Schema.Array(Decision),
  skim: Schema.Array(SkimArea),
  trusted: Schema.Array(TrustedGroup),
  claims: Schema.Array(AuthorClaim),
  unclaimedDecisionIds: Schema.Array(Schema.String),
  lines: Schema.Struct({ decision: Schema.Number, skim: Schema.Number, trusted: Schema.Number }),
  /** Set on the quick pass of a small PR; the full sort replaces it. */
  quick: Schema.optionalKey(Schema.Boolean),
})
export type SortResult = typeof SortResult.Type

export const DecisionState = Schema.Literals(['accepted', 'pushed-back'])
export type DecisionState = typeof DecisionState.Type

export const DecisionStates = Schema.Record(Schema.String, DecisionState)
export type DecisionStates = typeof DecisionStates.Type

export const StackOverview = Schema.Struct({
  summary: Schema.String,
  tables: Schema.Array(Schema.String),
  modules: Schema.Array(Schema.String),
  endpoints: Schema.Array(Schema.String),
  sharedLayers: Schema.Array(Schema.String),
})
export type StackOverview = typeof StackOverview.Type

export const AskTarget = Schema.Union([
  /** `commit` holds the lines: the head for RIGHT, the merge base for LEFT (removed lines). */
  Schema.TaggedStruct('Lines', { path: Schema.String, start: Schema.Number, end: Schema.Number, side: Side, commit: Schema.String }),
  Schema.TaggedStruct('Decision', { decision: Decision }),
])
export type AskTarget = typeof AskTarget.Type

/** Names a conversation: one per line range and side, or per decision. */
export const targetKey = (t: AskTarget) => (t._tag === 'Lines' ? `${t.path}:${t.side}:${t.start}-${t.end}` : `decision:${t.decision.id}`)

export const ChatTurn = Schema.Struct({ question: Schema.String, answer: Schema.String })
export type ChatTurn = typeof ChatTurn.Type

/** A conversation with Claude about some lines or a decision, oldest turn first. */
export const Chat = Schema.Struct({ target: AskTarget, turns: Schema.Array(ChatTurn) })
export type Chat = typeof Chat.Type

export const PrView = Schema.Struct({
  ...PrMeta.fields,
  host: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  baseSha: Schema.String,
  mergeBase: Schema.String,
  defaultBranch: Schema.String,
  files: Schema.Array(FileStat),
  threads: Schema.Array(Thread),
  checks: Checks,
  stack: Schema.Array(StackEntry),
  /** Who is reviewing: GitHub doesn't let authors approve or request changes on their own PR. */
  viewer: Schema.String,
})
export type PrView = typeof PrView.Type

/** Items judged on an earlier head whose files changed since: the head they were judged on, and the verdict then. */
export const Rereview = Schema.Record(Schema.String, Schema.Struct({ since: Schema.String, was: DecisionState }))
export type Rereview = typeof Rereview.Type

export const SortEvent = Schema.Union([
  /** Sent again whenever the step changes: what the sort is doing right now. */
  Schema.TaggedStruct('Running', { startedAt: Schema.String, step: Schema.optionalKey(Schema.String) }),
  Schema.TaggedStruct('Done', { result: SortResult, state: DecisionStates, rereview: Schema.optionalKey(Rereview) }),
])
export type SortEvent = typeof SortEvent.Type

export const AskEvent = Schema.Union([
  Schema.TaggedStruct('Text', { delta: Schema.String }),
  Schema.TaggedStruct('Done', { sessionId: Schema.String }),
])
export type AskEvent = typeof AskEvent.Type

export const StackEntryStatus = Schema.Struct({
  pr: StackEntry,
  status: Schema.Literals(['queued', 'running', 'done', 'failed']),
  result: Schema.NullOr(SortResult),
  error: Schema.NullOr(Schema.String),
  /** Saved verdicts for this PR's head, so the stack view can show and change them. */
  state: DecisionStates,
  rereview: Schema.optionalKey(Rereview),
  /** While running: what the sort is doing right now. */
  step: Schema.optionalKey(Schema.String),
  /** The PR opinion cached for this head, if one ran. */
  opinion: Schema.optionalKey(PrOpinion),
  /** What the reviewer did with that opinion's findings. */
  opinionStates: Schema.optionalKey(FindingStates),
})
export type StackEntryStatus = typeof StackEntryStatus.Type

export const StackEvent = Schema.Struct({
  entries: Schema.Array(StackEntryStatus),
  overview: Schema.NullOr(StackOverview),
  /** Set when the overview could not be written; the stream ends without one. */
  overviewError: Schema.optional(Schema.String),
  /** The stack opinion that starts by itself once every PR is sorted (automatic mode). */
  stackOpinion: Schema.optionalKey(Schema.Struct({ running: Schema.Boolean, step: Schema.optionalKey(Schema.String), error: Schema.optionalKey(Schema.String) })),
})
export type StackEvent = typeof StackEvent.Type

export const Phase = Schema.Struct({
  id: Schema.Literals(['fetch', 'sort', 'quick', 'opinion']),
  /** Names a count or the thing being worked on, such as "Sorting 42 files". */
  label: Schema.String,
  state: Schema.Literals(['waiting', 'running', 'done', 'failed']),
  startedAt: Schema.optionalKey(Schema.String),
  endedAt: Schema.optionalKey(Schema.String),
  workers: Schema.Array(
    Schema.Struct({
      account: Schema.String,
      /** Such as "Judging 3 of 6: <title>". */
      current: Schema.optionalKey(Schema.String),
      /** The last tool step. */
      step: Schema.optionalKey(Schema.String),
      /** Up to 4 earlier steps. */
      recent: Schema.Array(Schema.String),
    }),
  ),
})
export type Phase = typeof Phase.Type

/** A prepared review: progress while it is built, then everything the review page renders. */
export const ReviewEvent = Schema.Union([
  Schema.TaggedStruct('Preparing', { phases: Schema.Array(Phase) }),
  Schema.TaggedStruct('Done', {
    sort: SortResult,
    state: DecisionStates,
    rereview: Schema.optionalKey(Rereview),
    opinion: Schema.NullOr(PrOpinion),
    opinionError: Schema.optionalKey(Schema.String),
    findingStates: FindingStates,
  }),
])
export type ReviewEvent = typeof ReviewEvent.Type
