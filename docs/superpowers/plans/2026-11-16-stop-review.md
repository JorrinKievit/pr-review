# Stop Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the loading screen two buttons:
- **Open on GitHub**, which leaves the run going.
- **Open on GitHub and stop review**, which stops the run and keeps the PR stopped until the reviewer clicks "Start review" on a stopped page.

**Architecture:**
- The companion's `Reviewer` owns the stop:
  - a persisted per-PR mark in `Store`;
  - `stop` interrupts the PR's running fibers;
  - `prepare` skips stopped PRs.
- `GetPr` reports `stopped`. The extension's `Loaded` shows a stopped page instead of subscribing to `Review`.

**Tech Stack:** Effect 4 (services, RPC, KeyValueStore), React, @effect/atom-react, vitest / @effect/vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-stop-review-design.md`

## Global Constraints

- Stopped is per PR (`host/owner/repo#number`), not per head. It survives pushes and companion restarts, because it is persisted in `Store`.
- Nothing may start a run for a stopped PR except an explicit "Start review":
  - `Prepare`;
  - `prepareAbove` (in the `Review` handler);
  - the bottom-PR prepare in `Stack`.
- The `Review` handler's `prepareAbove` must not fire after this PR was stopped.
- Button copy, exactly:
  - "Open on GitHub"
  - "Open on GitHub and stop review"
  - "Start review"
  - "You stopped Claude's review of this PR."
- Both GitHub buttons navigate to `githubFilesUrl(ref)` from `apps/extension/src/Setup.tsx`.

## Review Focus

- **Stop during a run that another tab is watching.** That tab's `Review` stream fails with an interrupt. It must show the stopped page, not "sort failed". This is covered in Task 3 by refreshing the PR atom when the review stream fails while `GetPr` now reports `stopped`.
- **Stop clicked twice, or when no run is going.** `stop` must succeed, and still mark the PR. Task 1 has a test for this.
- **Stop then immediately a `Prepare` from the GitHub page.** The mark is written before the interrupt, and navigation waits for the `StopReview` call. Task 2 has a test: StopReview, then Prepare, gives no new agent call.
- **Resume when a sort is already cached for the head.** It must reuse the cache and not re-run. This is existing `Reviewer` behaviour, which `ensure` already handles, so no new test.
- **Stopping the bottom PR of a stack must not prepare the PR above.** Task 2 has a test.

---

### Task 1: Reviewer can stop, resume and report stopped PRs

**Files:**
- Modify: `apps/companion/src/Store.ts`. Add `stopped` to the `Store` service: `KeyValueStore.SchemaStore<typeof Schema.Boolean>`, with prefix `'stopped/'`.
- Modify: `apps/companion/src/Reviewer.ts`
- Test: `apps/companion/test/Reviewer.test.ts`

**Interfaces:**
- Produces, on `Reviewer`:
  - `stop(ref: PrRef): Effect.Effect<void>`. Sets `store.stopped[prKey] = true` first, then interrupts every run whose key starts with `${prKey}@`, and waits for those interrupts.
  - `resume(ref: PrRef): Effect.Effect<void>`. Removes the mark.
  - `isStopped(ref: PrRef): Effect.Effect<boolean>`
  - `prepare(ref, headSha)`. Now a no-op when the PR is stopped.
  - `result` is unchanged. It still runs when called, because the page only calls `Review` when the PR is not stopped.
- `prKey(ref)` = `` `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}` ``. Store failures die (`Effect.orDie`), like the other store reads.

- [ ] **Step 1: Write the failing tests** in `describe('Reviewer')`.
  - `'stop interrupts the running review and marks the PR'`:
    - The sort agent blocks on a `Deferred` that is never completed.
    - Call `prepare(ref,'HEAD1')`, wait until the agent has one call, then call `stop(ref)`.
    - Assert the `progress` stream for that head is empty after the stop (`Stream.runHead` gives `None`, so the `runs` entry is gone), and that `isStopped(ref)` is `true`.
  - `'a stopped PR is not prepared, and resume lets it run'`:
    - Call `stop(ref)` with nothing running, which must succeed, then `prepare(ref,'HEAD1')`, then sleep 20 ms. Assert agent calls is 0.
    - Then call `resume(ref)` and `result(ref,'HEAD1')`. Assert the agent was called and `isStopped(ref)` is `false`.
- [ ] **Step 2: Run** `pnpm --filter companion exec vitest run test/Reviewer.test.ts -t "stop"`. Expect FAIL: `stop` is not a function.
- [ ] **Step 3: Implement.**
  - Keep the fiber returned by `Effect.forkIn` on the run object (`run.fiber`). The run is set in `runs` before the fork, so assign it right after the fork.
  - `stop` collects the matching runs' fibers and calls `Fiber.interruptAll`.
- [ ] **Step 4: Run** the whole Reviewer test file. Expect PASS.
- [ ] **Step 5: Commit** `feat(companion): a review can be stopped per PR and resumed`.

### Task 2: RPCs and handlers honour the stop

**Files:**
- Modify: `packages/domain/src/rpcs.ts`. Add these two after `Prepare`:
  - `Rpc.make('StopReview', { payload: { ref: PrRef }, error: CompanionUnavailable })`
  - `Rpc.make('ResumeReview', { payload: { ref: PrRef }, error: CompanionUnavailable })`
  - Both get a one-line doc comment.
- Modify: `packages/domain/src/schemas.ts`. Add `stopped: Schema.Boolean` to `PrView`, with a doc comment ("the reviewer stopped Claude's review of this PR; nothing runs until they start it again").
- Modify: `apps/companion/src/handlers.ts`:
  - `StopReview` calls `reviewer.stop`.
  - `ResumeReview` calls `reviewer.resume`.
  - `GetPr` adds `stopped: yield* reviewer.isStopped(ref)`.
  - `prepareAbove(ref)` returns early when `reviewer.isStopped(ref)`.
  - `Prepare` and `Stack` already go through `reviewer.prepare`, so they need no change.
- Modify: `apps/extension/test/companion.ts`. Add defaults `StopReview: () => Effect.void` and `ResumeReview: () => Effect.void`.
- Modify: the fixtures in `apps/extension/test/{ReviewPage,StackPage,OpenPage}.test.tsx`. Add `stopped: false` to each `PrView`.
- Test: `apps/companion/test/handlers.test.ts`

**Interfaces:**
- Consumes: Task 1's `stop`, `resume`, `isStopped`.
- Produces the `StopReview` and `ResumeReview` RPCs, and `PrView.stopped`.

- [ ] **Step 1: Write the failing tests.**
  - `'GetPr says whether the review was stopped'`: assert `stopped` is false, then after `StopReview` it is true, then after `ResumeReview` it is false.
  - `'after StopReview, Prepare starts nothing'` (`it.live`, `requestedReviewers` includes `'Me'`): call `StopReview({ ref })`, then `Prepare({ ref })`, then sleep 30 ms. Assert the agent has no calls.
  - `'stopping a stacked PR does not prepare the one above'` (`it.live`; stack 7 → 8; sort delay 100):
    - Fork `Stream.runDrain(c.Review({ ref, headSha: 'HEAD1' }))`, then sleep 20 ms, then call `StopReview({ ref })`, then sleep 150 ms.
    - Assert the agent calls' `log.number` values are exactly `[7]`.
- [ ] **Step 2: Run** `pnpm --filter companion exec vitest run test/handlers.test.ts -t "Stop|stopped|stopping"`. Expect FAIL.
- [ ] **Step 3: Implement** the domain, handler and fixture changes listed above.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expect everything to pass.
- [ ] **Step 5: Commit** `feat: StopReview and ResumeReview, and GetPr says when a review is stopped`.

### Task 3: Loading screen buttons and the stopped page

**Files:**
- Modify: `apps/extension/src/atoms.ts`:
  - `stopReviewAtom: client.runtime.fn((ref: PrRef) => …c('StopReview', { ref }))`. No refresh is needed, because the page navigates away.
  - `resumeReviewAtom: client.runtime.fn((ref: PrRef, get) => …c('ResumeReview', { ref }) then get.refresh(pr(refKey(ref))))`
- Modify: `apps/extension/src/review/Preparing.tsx`. Takes `prRef: PrRef`. Below the phase list, it shows:
  - `Button variant="outline"` "Open on GitHub", which sets `location.href = githubFilesUrl(prRef)`;
  - `Button variant="ghost"` "Open on GitHub and stop review", which awaits `stopReview(prRef)` (via `useAtomSet(…, { mode: 'promise' })`) and then navigates.
- Create: `apps/extension/src/review/Stopped.tsx`. `Stopped({ prRef, pr })` renders:
  - the same header as `Preparing` (`owner/repo #n`, then the title);
  - the line "You stopped Claude's review of this PR.";
  - `Button` "Start review", which calls `resumeReview(prRef)`;
  - `Button variant="outline"` "Open on GitHub".
- Modify: `apps/extension/src/review/ReviewPage.tsx`:
  - In `ReviewPage`, before `<Loaded>`: when `pr.value.stopped`, return `<Stopped …/>`. `Loaded` then never mounts, so `reviewAtom` is never subscribed.
  - In `Loaded`, when the review result is a failure that is an interrupt (the run was stopped elsewhere), refresh `prAtom(prRef)` so the stopped page takes over. Check with `Cause.hasInterruptsOnly` on the failure's cause, or by re-reading the PR on any failure. Pick whichever the `AsyncResult` API makes a one-liner.
- Test: `apps/extension/test/ReviewPage.test.tsx`. Extend `renderPage` with `stopped?: boolean`, which is passed into the `GetPr` fixture and flips when `StopReview` or `ResumeReview` is called. It also records `stopCalls` and `resumeCalls`.

**Interfaces:**
- Consumes `StopReview`, `ResumeReview` and `PrView.stopped` (Task 2), and `githubFilesUrl` (`apps/extension/src/Setup.tsx`).

- [ ] **Step 1: Write the failing tests.** Stub `location` with `vi.stubGlobal` or `Object.defineProperty(window, 'location', …)` to capture `href`.
  - `'the loading screen opens GitHub, leaving the review running'`: the review stays `Preparing`. Click "Open on GitHub". Expect `href` to be `https://github.com/acme/core/pull/7/files?native=1` and `stopCalls` to be 0.
  - `'the loading screen can stop the review on the way to GitHub'`: click "Open on GitHub and stop review". Expect `stopCalls` to be 1, then the same `href`.
  - `'a stopped PR shows the stopped page and runs nothing until Start review'`:
    - With `stopped: true`, expect the text "You stopped Claude's review of this PR." and `reviewCalls()` to be 0.
    - Click "Start review". Expect `resumeCalls` to be 1, then the list "Preparing the review" or the review itself to appear, and `reviewCalls()` to be 1.
- [ ] **Step 2: Run** `pnpm --filter extension exec vitest run test/ReviewPage.test.tsx -t "stop|loading screen"`. Expect FAIL.
- [ ] **Step 3: Implement** the atoms, `Preparing` buttons, `Stopped`, and the `ReviewPage` gate.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expect everything to pass.
- [ ] **Step 5: Commit** `feat(extension): stop a review from the loading screen, start it again from the stopped page`.

### Task 4: Docs

**Files:** `README.md`, in the "Use" section.

- [ ] **Step 1:** Add one sentence: while a review is preparing, the loading screen can open GitHub and leave the run going, or open GitHub and stop it. A stopped PR stays stopped, across pushes too, until "Start review" on its page.
- [ ] **Step 2: Commit** `docs: stopping a review`.
