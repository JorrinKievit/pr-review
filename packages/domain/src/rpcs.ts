import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { AgentError, CompanionUnavailable, ReviewRejected, GitError, GitHubError, RepoNotConfigured } from './errors.ts'
import { AskEvent, AskTarget, Chat, DecisionState, Draft, PrRef, PrView, ReviewEvent, SortEvent, StackEvent } from './schemas.ts'
import { DeeperEvent, FindingState, OpinionEvent, RuleDraft, StackOpinionEvent } from './opinion.ts'
import { AccountStatus, Settings } from './settings.ts'

// CompanionUnavailable is raised by the extension's background when the native host is missing or gone.
const PrFailure = Schema.Union([RepoNotConfigured, GitError, GitHubError, CompanionUnavailable])

export class ReviewRpcs extends RpcGroup.make(
  Rpc.make('Health', { success: Schema.Struct({ version: Schema.String }), error: CompanionUnavailable }),
  /** The extension owns the settings; the companion runs on them and keeps a copy for a browser that lost its storage. */
  Rpc.make('Configure', { payload: { settings: Settings }, error: CompanionUnavailable }),
  Rpc.make('GetSettings', { success: Schema.NullOr(Settings), error: CompanionUnavailable }),
  Rpc.make('PoolStatus', { success: Schema.Array(AccountStatus), error: CompanionUnavailable }),
  Rpc.make('GetPr', { payload: { ref: PrRef }, success: PrView, error: PrFailure }),
  Rpc.make('GetFilePatch', {
    /** `previous` is the file's path before the PR moved it, so the patch shows the move. */
    payload: { ref: PrRef, mergeBase: Schema.String, headSha: Schema.String, path: Schema.String, previous: Schema.optionalKey(Schema.String) },
    success: Schema.String,
    error: Schema.Union([RepoNotConfigured, GitError, CompanionUnavailable]),
  }),
  Rpc.make('Sort', {
    payload: { ref: PrRef, headSha: Schema.String },
    success: SortEvent,
    error: Schema.Union([RepoNotConfigured, GitError, GitHubError, AgentError, CompanionUnavailable]),
    stream: true,
  }),
  /** The whole prepared review in one stream: `Preparing` progress, then `Done` with sort, opinion and states. */
  Rpc.make('Review', {
    payload: { ref: PrRef, headSha: Schema.String },
    success: ReviewEvent,
    error: Schema.Union([RepoNotConfigured, GitError, GitHubError, AgentError, CompanionUnavailable]),
    stream: true,
  }),
  /** Starts preparing a review early, so it is ready when the reviewer opens it. True when it started (or one was running). */
  Rpc.make('Prepare', { payload: { ref: PrRef }, success: Schema.Boolean, error: CompanionUnavailable }),
  Rpc.make('SetState', {
    payload: { ref: PrRef, headSha: Schema.String, decisionId: Schema.String, state: Schema.NullOr(DecisionState) },
    error: CompanionUnavailable,
  }),
  /** Claude's opinion on the PR's decisions: a cached one, `Idle` when there is none and `run` is false, else a run. */
  Rpc.make('Opinion', {
    payload: { ref: PrRef, headSha: Schema.String, run: Schema.Boolean },
    success: OpinionEvent,
    error: Schema.Union([RepoNotConfigured, GitError, GitHubError, AgentError, CompanionUnavailable]),
    stream: true,
  }),
  /** One decision's opinion re-run on the strongest model; its result replaces that decision's findings. */
  Rpc.make('DigDeeper', {
    payload: { ref: PrRef, headSha: Schema.String, decisionId: Schema.String },
    success: DeeperEvent,
    error: Schema.Union([RepoNotConfigured, GitError, GitHubError, AgentError, CompanionUnavailable]),
    stream: true,
  }),
  Rpc.make('SetFindingState', {
    payload: { ref: PrRef, headSha: Schema.String, findingId: Schema.String, state: Schema.NullOr(FindingState) },
    error: CompanionUnavailable,
  }),
  /** A review comment turned into a proposed rule for the repo's review guidance; nothing is written. */
  Rpc.make('DraftRule', {
    payload: { ref: PrRef, text: Schema.String },
    success: RuleDraft,
    error: Schema.Union([RepoNotConfigured, GitError, AgentError, CompanionUnavailable]),
  }),
  Rpc.make('Ask', {
    payload: { ref: PrRef, headSha: Schema.String, target: AskTarget, question: Schema.String, followUp: Schema.Boolean },
    success: AskEvent,
    error: Schema.Union([RepoNotConfigured, GitError, AgentError, CompanionUnavailable]),
    stream: true,
  }),
  /** The PR body as GitHub renders it. Its media links expire after minutes, so it is read when shown. */
  Rpc.make('GetDescription', { payload: { ref: PrRef }, success: Schema.String, error: PrFailure }),
  Rpc.make('GetChats', { payload: { ref: PrRef, headSha: Schema.String }, success: Schema.Array(Chat), error: CompanionUnavailable }),
  Rpc.make('Stack', { payload: { ref: PrRef }, success: StackEvent, error: PrFailure, stream: true }),
  /** One opinion on the whole stack (never a PR opinion per PR): a cached one, `Idle` when there is none and `run` is false, else a run. */
  Rpc.make('StackOpinion', {
    payload: { ref: PrRef, run: Schema.Boolean },
    success: StackOpinionEvent,
    error: Schema.Union([RepoNotConfigured, GitError, GitHubError, AgentError, CompanionUnavailable]),
    stream: true,
  }),
  /** Small page state kept between visits (where a review left off, unsent text), as JSON strings by key. */
  Rpc.make('Recall', { payload: { key: Schema.String }, success: Schema.NullOr(Schema.String), error: CompanionUnavailable }),
  Rpc.make('Remember', { payload: { key: Schema.String, value: Schema.String }, error: CompanionUnavailable }),
  Rpc.make('GetDrafts', { payload: { ref: PrRef }, success: Schema.Array(Draft), error: CompanionUnavailable }),
  Rpc.make('SetDrafts', { payload: { ref: PrRef, drafts: Schema.Array(Draft) }, error: CompanionUnavailable }),
  /** Sends the saved drafts with the verdict as one review, then clears them. */
  Rpc.make('SubmitReview', {
    payload: {
      ref: PrRef,
      event: Schema.Literals(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
      body: Schema.String,
      commitId: Schema.String,
    },
    error: Schema.Union([RepoNotConfigured, ReviewRejected, GitHubError, CompanionUnavailable]),
  }),
) {}
