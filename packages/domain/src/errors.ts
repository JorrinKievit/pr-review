import { Schema } from 'effect'

export class RepoNotConfigured extends Schema.TaggedError<RepoNotConfigured>()('RepoNotConfigured', { key: Schema.String }) {
  override get message() {
    return `${this.key.split('/')[0]} is not one of the GitHub hosts in the settings`
  }
}

export class GitError extends Schema.TaggedError<GitError>()('GitError', { message: Schema.String }) {}

export class GitHubError extends Schema.TaggedError<GitHubError>()('GitHubError', { status: Schema.Number, message: Schema.String }) {}

/** GitHub refused the review, usually because a commented line is gone from the PR; the drafts stay. */
export class ReviewRejected extends Schema.TaggedError<ReviewRejected>()('ReviewRejected', { message: Schema.String }) {}

/** The reviewer stopped Claude's review of this PR; nothing runs for it until they start it again. */
export class ReviewStopped extends Schema.TaggedError<ReviewStopped>()('ReviewStopped', {}) {
  override get message() {
    return "You stopped Claude's review of this PR."
  }
}

export class AgentError extends Schema.TaggedError<AgentError>()('AgentError', { message: Schema.String }) {}

export class CompanionUnavailable extends Schema.TaggedError<CompanionUnavailable>()('CompanionUnavailable', {
  /** `mismatch`: the companion is from another release than the extension. */
  reason: Schema.Literals(['not-installed', 'disconnected', 'mismatch']),
}) {}
