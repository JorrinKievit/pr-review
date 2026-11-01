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

export class AgentError extends Schema.TaggedError<AgentError>()('AgentError', { message: Schema.String }) {}

export class CompanionUnavailable extends Schema.TaggedError<CompanionUnavailable>()('CompanionUnavailable', {
  reason: Schema.Literals(['not-installed', 'disconnected']),
}) {}
