# pr-review

A Firefox and Chrome extension that replaces a pull request's "Files changed" page with a review sorted by an AI agent: decisions to make, areas to skim, and files you can trust. A local companion does the git and agent work through the subscriptions you already have (Claude Code, Codex, Cursor, Gemini CLI and others, over the [Agent Client Protocol](https://agentclientprotocol.com)); nothing runs while no review tab is open.

- `apps/extension`: the extension (WXT, React).
- `apps/companion`: the native messaging host and `pr-review` CLI (Effect, ACP, Octokit).
- `packages/domain`: schemas and RPCs shared by both.
- `packages/native-messaging`: the Effect RPC transport over Chrome native messaging.

## Requirements

- Node 24.18 or later and pnpm.
- `gh auth login --hostname <host>` and `gh auth setup-git --hostname <host>` for every GitHub host you review on. The companion reads the token from `gh` and clones over HTTPS.
- At least one coding agent logged in with its own CLI (`claude`, `codex login`, `cursor-agent login`, …). The companion uses those logins and drops `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from the agent's environment unless an account sets them.

## Install

```sh
pnpm i
apps/companion/bin/pr-review install   # registers the native messaging host with Firefox, Chrome and Chromium
pnpm turbo build                       # builds .output/firefox-mv2 and .output/chrome-mv3
```

Firefox: open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on…" and pick `apps/extension/.output/firefox-mv2/manifest.json`. A temporary add-on is removed when Firefox restarts; load it again after a restart. To keep it installed, sign it as an unlisted add-on (`npx web-ext sign --channel unlisted --source-dir .output/firefox-mv2` with AMO API keys) or use Firefox Developer Edition with `xpinstall.signatures.required` set to `false`.

Chrome: open `chrome://extensions`, turn on developer mode, and load `apps/extension/.output/chrome-mv3` unpacked.

Both extension ids are pinned (`pr-review@jorrinkievit` in Firefox, a fixed key in Chrome), so `install` and the extension always agree.

Store builds (see Release) get their ids from the Chrome Web Store and Edge Add-ons. Allow them with `pr-review install --extension-id <chrome-id>,<edge-id>`; the unpacked build stays allowed.

## Settings

Open the add-on's preferences. The extension keeps the settings in its own storage and hands them to the companion, which keeps a copy in `~/.config/pr-review/settings.json` so a reinstalled add-on gets them back.

- **GitHub hosts.** github.com by default. Add a GitHub Enterprise host and the browser asks for permission to open its PR pages. Any repo on a listed host works; it is cloned on first review.
- **AI accounts.** The pool. Add an account per agent login: a second Claude subscription is a second Claude account with its own `CLAUDE_CONFIG_DIR`, a second Codex one gets its own `CODEX_HOME`. Work goes to the least busy account; one that hits its usage limit sits out until it resets and the run moves to another. Agents run in a read-only mode and may only run git commands.
- **Review.** Which repo files hold review rules (`AGENTS.md`, `CLAUDE.md`, `.agents`, …), globs the agent is told are probably safe to trust, globs that always need a human, the largest diff sent along, and the time limit per run.

### WSL

Run everything inside WSL and use the Windows browser. `install` notices WSL and writes a `.bat` launcher and one manifest per browser under `%LOCALAPPDATA%\pr-review`, registered through `reg.exe` (`HKCU\Software\Mozilla\NativeMessagingHosts` and `HKCU\Software\Google\Chrome\NativeMessagingHosts`). Windows Firefox loads the add-on most reliably from a Windows path, so copy `.output/firefox-mv2` to `C:\` first.

## Use

Open a PR's "Files changed" page. The extension redirects to the review page. "Open on GitHub" goes back without redirecting (`?native=1`). For a stacked PR, the stack pill in the top bar opens the stack view.

Keys: `j`/`k` move, `a` accepts, `p` pushes back, `⌘J` discusses, `⌘K` jumps, `esc` closes. Select lines in a diff to ask about them. Nothing is posted to GitHub until you press a button.

## Files

| Path | What |
| --- | --- |
| `~/.config/pr-review/settings.json` | The companion's copy of the settings |
| `~/.cache/pr-review/repos/<host>/<owner>/<repo>.git` | Bare clones |
| `~/.cache/pr-review/store` | Cached sorts, overviews, patches, decision states, chat sessions |
| `~/.cache/pr-review/usage.jsonl` | One line per agent run: account, agent, duration |
| `~/.cache/pr-review/host.log` | Companion log |

Sorts are cached per head commit, so a new push sorts again. To clear the cache, delete `~/.cache/pr-review/store` (this also clears decision states and chat sessions). Deleting a clone makes the next review clone it again.

## Develop

Live reload in Firefox: run the dev build into a folder Firefox can read, load it once as a temporary add-on, and leave it running. Saving a file rebuilds; the extension and open review pages reload themselves (Alt+R reloads by hand).

```sh
cd apps/extension
WXT_OUT_DIR=/mnt/c/Users/<you>/pr-review-dev pnpm dev:firefox   # under WSL; elsewhere plain `pnpm dev:firefox`
```

Load `<WXT_OUT_DIR>/firefox-mv2-dev/manifest.json` from `about:debugging`. Companion changes need no reload: the browser starts a fresh host when it reconnects.

`node apps/companion/scripts/probe-host.ts <host/owner/repo> <pr>` (or `… <pr> stack`) drives the real host over stdio the way the browser does, without a browser.

```sh
pnpm test
pnpm typecheck
```

## Release

Push a `v*` tag (`git tag v0.2.0 && git push origin v0.2.0`). The Extension workflow tests, zips Chrome, Firefox (plus a sources zip for AMO) and Edge, attaches them to a GitHub release, and submits each to its store when that store's secrets are set:

| Store | Secrets |
| --- | --- |
| Chrome Web Store | `CHROME_EXTENSION_ID`, `CHROME_PUBLISHER_ID`, `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL`, `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` |
| Firefox Add-ons | `FIREFOX_JWT_ISSUER`, `FIREFOX_JWT_SECRET` (repo variable `FIREFOX_CHANNEL=unlisted` to self-distribute instead of listing) |
| Edge Add-ons | `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY` |

The first upload to each store is manual; the workflow handles updates. Running the workflow by hand builds a given version and submits only when asked.
