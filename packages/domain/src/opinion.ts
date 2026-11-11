import { Schema } from 'effect'

const { Struct, String, Number, Boolean, NullOr, Array, Literals, Record, optionalKey, TaggedStruct, Union } = Schema

export const Severity = Literals(['blocks', 'should', 'ask'])
export type Severity = typeof Severity.Type

export const Axis = Literals(['standards', 'spec'])
export type Axis = typeof Axis.Type

export const FindingKind = Literals(['rule', 'reuse', 'framework', 'scope', 'design', 'spec', 'upstream'])
export type FindingKind = typeof FindingKind.Type

export const Evidence = Struct({
  ref: Literals(['base', 'head', 'docs', 'related']).annotate({
    description: 'base or head: a file at that ref. docs: a library and practice named, no path. related: a file in a related repo.',
  }),
  path: String,
  line: Number,
  quote: String.annotate({ description: 'Short exact quote from the cited file.' }),
  repo: optionalKey(String.annotate({ description: 'host/owner/repo, for related evidence.' })),
  pr: optionalKey(Number.annotate({ description: "Which PR's head the evidence is from, in stack opinions." })),
})
export type Evidence = typeof Evidence.Type

export const AgentFinding = Struct({
  severity: Severity.annotate({ description: 'blocks: blocks merge. should: should fix before merge. ask: worth asking.' }),
  axis: Axis.annotate({ description: 'standards: the code against rules, codebase and design. spec: the PR against what was asked.' }),
  kind: FindingKind,
  title: String,
  take: String.annotate({ description: 'At most three sentences, plain words.' }),
  evidence: Array(Evidence).annotate({ description: 'Citations with a short exact quote. Framework claims cite docs.' }),
  alternative: NullOr(String).annotate({ description: 'What to do instead, concretely.' }),
  comment: NullOr(String).annotate({ description: 'A PR comment the reviewer can post as is.' }),
  anchor: NullOr(Struct({ path: String, line: Number })).annotate({ description: 'The file and line the finding anchors to.' }),
  handledIn: NullOr(Number).annotate({ description: 'The stack PR that already resolves it, or null.' }),
})
export type AgentFinding = typeof AgentFinding.Type

export const Finding = Struct({
  ...AgentFinding.fields,
  id: String,
  pr: Number,
  decisionId: NullOr(String),
  verified: Boolean,
})
export type Finding = typeof Finding.Type

export const AgentDecisionOpinion = Struct({
  decisionId: String,
  authorCase: String.annotate({ description: "The author's best case for the decision." }),
  checked: NullOr(String).annotate({ description: 'What was checked, when there are no findings.' }),
  findings: Array(AgentFinding),
})
export type AgentDecisionOpinion = typeof AgentDecisionOpinion.Type

export const AgentOpinion = Struct({ decisions: Array(AgentDecisionOpinion) })
export type AgentOpinion = typeof AgentOpinion.Type

export const DecisionOpinion = Struct({
  decisionId: String,
  authorCase: String,
  checked: NullOr(String),
  findings: Array(Finding),
  deep: Boolean,
})
export type DecisionOpinion = typeof DecisionOpinion.Type

export const PrOpinion = Struct({
  headSha: String,
  ticket: NullOr(String),
  ticketNote: String,
  decisions: Array(DecisionOpinion),
  stackHeads: Record(String, String),
})
export type PrOpinion = typeof PrOpinion.Type

export const AgentStackOpinion = Struct({ findings: Array(Struct({ ...AgentFinding.fields, pr: Number })) })
export type AgentStackOpinion = typeof AgentStackOpinion.Type

export const StackOpinion = Struct({ heads: Record(String, String), findings: Array(Finding) })
export type StackOpinion = typeof StackOpinion.Type

export const FindingState = Literals(['posted', 'dismissed'])
export type FindingState = typeof FindingState.Type

export const FindingStates = Record(String, FindingState)
export type FindingStates = typeof FindingStates.Type

const Idle = TaggedStruct('Idle', {})
const Running = TaggedStruct('Running', { startedAt: String, step: optionalKey(String) })

export const OpinionEvent = Union([Idle, Running, TaggedStruct('Done', { opinion: PrOpinion, states: FindingStates })])
export type OpinionEvent = typeof OpinionEvent.Type

export const StackOpinionEvent = Union([Idle, Running, TaggedStruct('Done', { opinion: StackOpinion })])
export type StackOpinionEvent = typeof StackOpinionEvent.Type

export const DeeperEvent = Union([Running, TaggedStruct('Done', { opinion: DecisionOpinion })])
export type DeeperEvent = typeof DeeperEvent.Type

export const RuleDraft = Struct({
  path: String,
  text: String,
  old: NullOr(String),
  patch: String,
  branch: String,
  title: String,
})
export type RuleDraft = typeof RuleDraft.Type

const severityOrder: ReadonlyArray<Severity> = ['blocks', 'should', 'ask']

export const lowerSeverity = (s: Severity): Severity => severityOrder[Math.min(severityOrder.indexOf(s) + 1, 2)]!

export const rankFindings = (fs: ReadonlyArray<Finding>, prOrder: ReadonlyArray<number>): Finding[] => {
  const prRank = (pr: number) => {
    const i = prOrder.indexOf(pr)
    return i === -1 ? prOrder.length : i
  }
  return fs
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        (a.f.handledIn !== null ? 1 : 0) - (b.f.handledIn !== null ? 1 : 0) ||
        severityOrder.indexOf(a.f.severity) - severityOrder.indexOf(b.f.severity) ||
        prRank(a.f.pr) - prRank(b.f.pr) ||
        a.i - b.i,
    )
    .map((x) => x.f)
}
