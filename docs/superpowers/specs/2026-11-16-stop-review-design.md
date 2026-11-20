# Stop a review from the loading screen

## Why

While a review is being prepared, the reviewer sometimes decides they don't want Claude on this PR at all, or not yet, and wants GitHub's own page. Today the only way out is the browser's back button. That leaves the run going, still using agent quota, and later visits start it again on their own.

## Goals

- The loading screen (`Preparing.tsx`) gets two buttons:
  - **Open on GitHub** goes to `githubFilesUrl(ref)` (`…/files?native=1`). The run keeps going in the companion, as it does today when the tab closes, so the review is ready on return.
  - **Open on GitHub and stop review** stops the run, marks the PR as stopped, then goes to the same URL.
- **Stopped is sticky per PR, not per head.** It holds across new pushes and companion restarts until the reviewer opts back in.
- **Opting back in is a "stopped" page.** Opening the review page of a stopped PR (the normal "Files changed" redirect, or the stack view) shows the following instead of running anything:

  ```
  owner/repo #123 · Fix invoice rounding
  You stopped Claude's review of this PR.
  [ Start review ]   [ Open on GitHub ]
  ```

  **Start review** clears the mark and starts the review as usual. Cached sorts and opinions for the head are reused.

## Non-goals

- A stop button anywhere other than the loading screen, such as the top bar of a finished review.
- A list or settings page of stopped PRs.
- Stopping individual phases (sort only, or opinion only).

## Anti-goals

- A stopped PR starting a run anyway:
  - through `Prepare` from GitHub's PR pages;
  - through `prepareAbove` after the PR below it finishes;
  - through the stack view preparing its bottom PR;
  - or through the `Review` handler's own `prepareAbove`, which fires when the interrupted fiber ends.
- Losing the mark when the companion exits 5 minutes after the last tab.

## Approaches

- **A. A "stopped" page on the existing redirect. Chosen.** It is the simplest option and lives entirely in our own page. The cost is one extra hop on stopped PRs.
- **B. No redirect for stopped PRs, plus a "Review with Claude" button injected into GitHub's PR header.** Rejected because the injected button breaks on GitHub and GHE DOM changes.
- **C. No redirect, plus a toolbar popup with "Start review".** Rejected because nobody would find it.

## The how

### Companion

- **`Reviewer.ts`:**
  - Keep each run's fiber in `runs`.
  - Add `stop(ref)`, which interrupts every run of that PR (any head). Interrupting already kills the agent child, because `Acp.ts` acquireRelease kills the process.
- **Store:**
  - Add a persisted "stopped PRs" set, keyed `host/owner/repo#number`.
  - Add `StopReview { ref }`, which marks the PR and calls `reviewer.stop`.
  - Add `ResumeReview { ref }`, which clears the mark.
- **Who checks the mark:**
  - `Prepare`, `prepareAbove` and the stack bottom prepare (`handlers.ts` ~422) skip stopped PRs.
  - `prepareAbove` in the `Review` handler must not run after a stop. Checking the mark covers that, because the mark is written before the interrupt.
- **`PrView` gains `stopped: boolean`** so the page knows without a second call. This is my call; a separate RPC would also work.

### Extension

- **`Loaded` in `ReviewPage.tsx`:** when `pr.stopped`, render the stopped page and don't subscribe to `reviewAtom`.
- **"Start review"** calls `ResumeReview`, then refreshes the PR atom.
- **The stop button** calls `StopReview`, then navigates. Navigation waits for the RPC so that a fast click can't race a `Prepare` from the GitHub page.
- **Other open tabs:** a `Review` stream in another tab that gets interrupted by a stop shows the stopped page, not a sort error. This is a builder detail; matching on the failure or re-reading `pr.stopped` both work.

### Tests

- **Companion:**
  - Stop interrupts a running review.
  - `Prepare` skips a stopped PR.
  - The PR above is not prepared after a stop.
  - Resume lets `Review` run.
  - The mark survives a fresh layer over the same store.
- **Extension:**
  - Both buttons render on the loading screen and navigate to the native GitHub URL.
  - The stop button calls `StopReview`.
  - A stopped PR renders the stopped page, and "Start review" calls `ResumeReview` and then shows the loading screen.

## Left to the builder

- Button styling and placement under the phase list.
- Exact RPC and store names.
