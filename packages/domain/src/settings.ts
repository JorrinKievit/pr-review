import { Schema } from 'effect'

/** One login of one coding agent, spoken to over the Agent Client Protocol. Several make up the pool. */
export const AgentAccount = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The preset it started from (`claude`, `codex`, …) or `custom`. */
  agent: Schema.String,
  /** Starts the agent's ACP server, such as `npx -y @agentclientprotocol/claude-agent-acp`. */
  command: Schema.String,
  /** Extra environment; a login directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) makes a second account of the same agent. */
  env: Schema.Record(Schema.String, Schema.String),
  /** The session mode it runs in; read-only by default. */
  mode: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  /** Runs at once on this account. */
  concurrency: Schema.Number,
  enabled: Schema.Boolean,
  /** May run the ticket session. */
  tickets: Schema.optionalKey(Schema.Boolean),
  /** Strongest model, used for Dig deeper. */
  deep: Schema.optionalKey(Schema.Boolean),
  /** Cheaper model for low-impact decisions and ticket reads. */
  fastModel: Schema.optionalKey(Schema.String),
})
export type AgentAccount = typeof AgentAccount.Type

/** How an account in the pool is doing: runs in progress, and until when (epoch ms) it sits out and why. */
export const AccountStatus = Schema.Struct({ id: Schema.String, busy: Schema.Number, until: Schema.Number, error: Schema.NullOr(Schema.String) })
export type AccountStatus = typeof AccountStatus.Type

/** Paths Claude is told are probably safe to skip, by group. */
export const TrustRule = Schema.Struct({ group: Schema.String, patterns: Schema.Array(Schema.String) })
export type TrustRule = typeof TrustRule.Type

/** Another repo the agent may read for context, with what it is for. */
export const RelatedRepo = Schema.Struct({ repo: Schema.String, note: Schema.String })
export type RelatedRepo = typeof RelatedRepo.Type

export const RepoSettings = Schema.Struct({
  related: Schema.Array(RelatedRepo),
  /** Path in that repo, read at its default branch. */
  reviewSkill: Schema.optionalKey(Schema.String),
})
export type RepoSettings = typeof RepoSettings.Type

export const Settings = Schema.Struct({
  /** GitHub hosts whose PR pages open in the review. Tokens come from `gh auth token --hostname <host>`. */
  hosts: Schema.Array(Schema.String),
  accounts: Schema.Array(AgentAccount),
  review: Schema.Struct({
    /** Files and folders in the repo with review rules, read from the default branch when they exist. */
    guidance: Schema.Array(Schema.String),
    /** Globs offered to the agent as probably trusted. */
    likelyTrusted: Schema.Array(TrustRule),
    /** Globs that always need a human, whatever the agent says. */
    neverTrust: Schema.Array(Schema.String),
    /** Above this many kilobytes the diff is left out and the agent reads files itself. */
    maxDiffKb: Schema.Number,
    timeoutMinutes: Schema.Number,
    /** Whether Claude's opinion runs with the review (default automatic) or only when asked. */
    opinions: Schema.optionalKey(Schema.Literals(['automatic', 'on-demand'])),
    /** Under this many changed lines (rule-trusted files not counted) a PR is small; default 200. */
    smallPrLines: Schema.optionalKey(Schema.Number),
  }),
  /** Per-repo review settings, keyed `host/owner/repo`. */
  repos: Schema.optionalKey(Schema.Record(Schema.String, RepoSettings)),
})
export type Settings = typeof Settings.Type

export const repoSettings = (s: Settings, repoKey: string): RepoSettings => s.repos?.[repoKey] ?? { related: [] }

export const opinionsMode = (s: Settings): 'automatic' | 'on-demand' => s.review.opinions ?? 'automatic'

export const smallPrLines = (s: Settings): number => s.review.smallPrLines ?? 200

/** Ready-made agents from the ACP registry. Agents without an npx package need their CLI installed. */
export const agentPresets = [
  { agent: 'claude', name: 'Claude', command: 'npx -y @agentclientprotocol/claude-agent-acp@0.99.1', loginEnv: 'CLAUDE_CONFIG_DIR', mode: 'default' },
  { agent: 'codex', name: 'Codex', command: 'npx -y @agentclientprotocol/codex-acp@2.5.0', loginEnv: 'CODEX_HOME', mode: 'read-only' },
  { agent: 'cursor', name: 'Cursor', command: 'cursor-agent acp', loginEnv: undefined, mode: 'plan' },
  { agent: 'gemini', name: 'Gemini CLI', command: 'npx -y @google/gemini-cli@0.66.0 --acp', loginEnv: undefined, mode: undefined },
  { agent: 'grok', name: 'Grok Build', command: 'npx -y @xai-official/grok@1.0.73 agent stdio', loginEnv: undefined, mode: undefined },
  { agent: 'copilot', name: 'GitHub Copilot', command: 'npx -y @github/copilot@1.0.105 --acp', loginEnv: undefined, mode: undefined },
  { agent: 'opencode', name: 'OpenCode', command: 'opencode acp', loginEnv: undefined, mode: undefined },
] as const

export const defaultSettings: Settings = {
  hosts: ['github.com'],
  accounts: [{ id: 'claude', name: 'Claude', agent: 'claude', command: agentPresets[0].command, env: {}, mode: 'default', concurrency: 2, enabled: true }],
  review: {
    guidance: ['AGENTS.md', 'CLAUDE.md', '.agents', '.cursor/rules', '.github/copilot-instructions.md'],
    likelyTrusted: [
      { group: 'tests', patterns: ['**/__tests__/**', '**/tests/**', '**/*.test.*', '**/*.spec.*'] },
      { group: 'generated', patterns: ['**/*.gen.*', '**/*.generated.*', '**/__generated__/**'] },
      { group: 'translations', patterns: ['**/locales/**/*.json', '**/translations/**/*.json', '**/i18n/**/*.json'] },
      {
        group: 'lockfiles',
        patterns: ['**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock', '**/bun.lock', '**/composer.lock', '**/Cargo.lock', '**/go.sum', '**/Gemfile.lock', '**/poetry.lock', '**/uv.lock'],
      },
    ],
    neverTrust: ['**/migrations/**', '.github/**', '.agents/**', 'AGENTS.md', 'CLAUDE.md'],
    maxDiffKb: 300,
    timeoutMinutes: 10,
  },
}
