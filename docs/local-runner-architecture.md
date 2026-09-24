# X-Pilot Local Runner — Architecture

> Status: implemented on `feature/local-runner-headless`. Scope: Windows-first.

## Overview

X-Pilot can execute the X publishing flow through one of two **execution backends**:

```text
X-Pilot Side Panel (React)
        ↓ runtime messages
Service Worker (automation-engine.ts — owns ALL publish code)
        ↓ ExecutionBackend dispatch (pinned per session)
   ┌────────────────────┴──────────────────────┐
CHROME_TAB (existing)                    LOCAL_RUNNER (new)
   automation tab + content script           chrome.runtime.connectNative()
   in the user's daily Chrome                        ↓
        ↓                                   com.so7ob.x_pilot_runner (Native Host)
   x-provider-adapter.ts                            ↓
   (content script)                          X-Pilot Local Runner (Node + TS)
                                                    ↓
                                       Playwright — dedicated persistent-context
                                       Chromium, HEADLESS (full browser, new
                                       headless mode), separate profile dir
                                                    ↓
                                       x.com intent page + composer + Post button
```

In **LOCAL_RUNNER** mode the extension never opens, activates, or focuses an X
tab in the user's daily Chrome for publish, preflight, dry-run, or diagnostics
(guarded by `tests/local-runner-routing.test.mjs` and live integration tests).
The only visible exception is the login-setup window, opened **exclusively** by
an explicit user action (Settings → Local Runner → Set up login).

Not accepted as implementations of this design: `active: false` tabs,
minimized windows, off-screen tabs, iframes, or `chrome.offscreen`. None are
used.

## Execution backend layer

- `src/domain/execution.ts` (pure): `ExecutionBackend = 'CHROME_TAB' | 'LOCAL_RUNNER'`,
  normalization, and `resolveSessionBackend(session, settings)`.
- The backend is **pinned on the session** at START/SCHEDULE time. Changing the
  setting while a session is active never switches the engine of the running
  item; `UPDATE_SETTINGS` explicitly strips `executionBackend` from the fields
  applied to a live session.
- **No implicit fallback.** If LOCAL_RUNNER is selected and the host is
  missing or the channel dies, the operation fails with an explicit
  `RUNNER_*` code. Falling back to CHROME_TAB is a user decision made after
  the current operation is settled.
- Why the CHROME_TAB implementation stays inside `automation-engine.ts`: the
  repository's contract tests pin the tab lifecycle and publish invariants in
  that module (see `tests/contracts.test.mjs`). The unification happens at the
  dispatch boundary (`ExecutionBackend` + pinned resolution + the shared
  runner protocol) instead of moving contract-pinned code, which would weaken
  the existing safety contracts.
- The extension remains the **single owner** of Queue, scheduling, state, and
  workspaces. The runner receives one operation at a time and keeps only a
  local ledger for duplicate prevention and result recovery. It has no
  scheduler and no second queue.

## Native Messaging

- Host name: `com.so7ob.x_pilot_runner`, registered per-user (HKCU) by
  `local-runner/install/install.ps1`.
- Manifest `path` points at the compiled `x-pilot-runner.exe` (v1.5.3, issue
  #9): Chrome launches `.exe` hosts through its direct-launch path
  (CreateProcess with inherited pipe handles). The exe is compiled at install
  time from `install/x-pilot-runner.cs` with the .NET Framework `csc.exe` that
  ships with Windows; it spawns `node dist\index.js` with stdin/stdout passed
  through untouched (they are the protocol pipes) and stderr pumped to
  `host-stderr.log`. A `.cmd` launcher remains as the fallback when csc.exe
  is unavailable (Chrome then uses the legacy cmd.exe pipe-redirection path).
- Manifest `allowed_origins` contains the **exact** extension id (no
  wildcards).
- Launch observability: the host logs a `host process context` line per
  session (raw argv, the `chrome-extension://<id>/` caller origin Chrome
  passes, stdio fd kinds), a `request received`/`response sent` pair per
  message, and `framesReceived`/`responsesSent` counters on shutdown — so
  runner.log alone distinguishes a Chrome launch from a manual/doctor launch
  and proves whether any message was delivered before the pipe died.
- Wire format per Chrome's spec: UTF-8 JSON framed with a 4-byte length header
  in native byte order. The length counts **bytes**, not characters — verified
  with Arabic and emoji payloads on both sides (`tests/runner-protocol.test.mjs`,
  `local-runner/tests/protocol.test.mjs`), including fragmentation and
  coalescing.
- Host→Chrome messages are capped at 1 MiB; oversized frames are rejected.
- The runner's **stdout speaks only the protocol**; all logs go to stderr and
  `%LOCALAPPDATA%\X-Pilot\Runner\logs`.
- Message contract (`src/runner/protocol.ts` ⇄ `local-runner/src/protocol.ts`,
  kept in sync by `protocol-sync` tests):

```ts
{ protocolVersion, requestId, command, workspaceId, profileId, operationId?, payload?, issuedAt }
```

Commands are an explicit allowlist: `PING, GET_INFO, INSPECT, PUBLISH,
GET_OPERATION, CANCEL, OPEN_LOGIN, CLOSE_LOGIN, CLEANUP`. There is **no**
channel for arbitrary JavaScript, shell commands, or reading files chosen by
the message sender. Requests are schema-validated; protocol version mismatch
is reported, never guessed.

Responses distinguish `ACK` (request received), `EVENT` (progress/login
window lifecycle), and `RESULT` (terminal outcome) with statuses
`OK | DUPLICATE | REJECTED | ERROR` and distinct codes (`RUNNER_LOGIN_REQUIRED`,
`RUNNER_ACCOUNT_MISMATCH`, `RUNNER_PROFILE_LOCKED`, `RUNNER_PROTOCOL_MISMATCH`, …).

Reconnect policy: the SW bridge reconnects with bounded attempts. It **never
re-sends a publish** implicitly — a PUBLISH in flight when the port dies is
rejected (`RUNNER_DISCONNECTED`), the engine's conservative uncertain path
quarantines the item, and the outcome is settled explicitly through
`GET_OPERATION` reconciliation.

## Browser and profiles

- `local-runner/src/browser.ts` launches **one persistent context per profile**
  via `chromium.launchPersistentContext` with `channel: 'chromium'` (the full
  Chromium binary in new-headless mode — the minimal headless shell does not
  persist cookies, which would break login persistence; verified by test).
- **Anti-automation launch profile (v1.5.4, issue #12):** Playwright's
  default `--enable-automation` switch is dropped (`ignoreDefaultArgs`) and
  `--disable-blink-features=AutomationControlled` is applied in **both**
  modes, plus one init script shadowing `navigator.webdriver` to `undefined`.
  Measured on real Chromium: the v1.5.3 login window exposed
  `navigator.webdriver === true`, which made X's login flow stall silently
  after the username step and made Google's sign-in page refuse with
  "This browser or app may not be secure". This is not a challenge bypass
  and not fingerprint spoofing (no fake UA/plugins/WebGL, no stealth
  dependencies): CAPTCHAs, challenges and daily limits still stop operations
  with explicit codes, and the login window stays 100% human-driven.
- **Login-window binary (v1.5.4):** the visible login window prefers the
  installed, branded Google Chrome (`channel: 'chrome'`) because Google's
  sign-in page — offered by X's login as "Continue with Google" — refuses
  generic Chromium builds. It still uses the runner's OWN dedicated
  user-data directory (never the user's daily Chrome profile or session) and
  falls back to bundled Chromium with a logged warning when no branded
  Chrome exists. Headless INSPECT/PUBLISH stay on bundled Chromium.
- Profile directories live under `%LOCALAPPDATA%\X-Pilot\Runner\profiles\<workspaceId>`
  — **outside the repository**, never in Git, not part of extension backups.
- A PID-based lockfile prevents two runner processes (or the visible login
  window and a headless session) from using the same profile simultaneously.
  Stale locks (dead PID) are recovered; locks of live processes are never
  deleted.
- Each workspace binds 1:1 to a runner profile and can declare an
  **expected account** (`Workspace.expectedAccount`, validated handle). The
  runner verifies the signed-in account before every publish and stops with
  `RUNNER_ACCOUNT_MISMATCH` on any difference. A workspace name alone is never
  accepted as account proof.
- The login-setup flow: explicit user action → visible browser on the profile
  → user signs in on X directly (the extension never sees credentials) →
  clean close → automatic **headless re-open of the same profile** to verify
  the session persisted → account reported back via GET_INFO/events.

## Idempotency — duplicate publish prevention

Two independent layers, both durable:

1. **Extension (pre-existing, unchanged):** `operationId` +
   `publishIntentId` persisted before submit, `PUBLISHED_UNVERIFIED`
   quarantine, `shouldNeverRepublish` gate on every attempt, START lock,
   single automation owner.
2. **Runner ledger (`local-runner/src/ledger.ts`):** a JSON journal keyed by
   `operationId`, bound to (workspace, profile, target URL, intended content,
   expected account) via SHA-256. Writes are atomic (tmp + fsync + rename +
   dir fsync). `markSubmitted` is an fsync'd write **immediately before the
   click**. On duplicate delivery the ledger answers with the recorded
   outcome; the same id with different content is rejected
   (`RUNNER_OPERATION_CONTENT_MISMATCH`).

Outcome classes (never collapsed):
- `FAILED_BEFORE_SUBMIT` — proven pre-click failure (login, challenge, limit,
  account mismatch, content mismatch, missing controls).
- `REJECTED` — X-side refusal proven by the page's own response.
- `CONFIRMED` — success proven by attempt-scoped evidence.
- `UNVERIFIED` — the submit may have landed; the extension quarantines the
  item as `PUBLISHED_UNVERIFIED` and **pauses** until settled.

Cleanup never deletes ledger evidence: only stale `CANCELLED` /
`FAILED_BEFORE_SUBMIT` records older than 30 days are pruned.

## Publish verification (no weak indicators)

The old condition that inferred success from composer disappearance was
removed. Verification is now attempt-scoped:

- Primary evidence: **passive observation** of the CreateTweet response the
  page itself generates when the Post button is clicked (the runner never
  re-creates or sends X API requests itself).
- Secondary evidence: a status link that did **not** exist before this click,
  plus the X confirmation toast.
- Composer disappearance, a toast alone, or a timeout are **never** success.
- The recorded post URL is only kept when it is provably from this attempt.
- No "verify by clicking Post again". Timeouts never become success.

## Interruption and lifecycle

- `recoverPersistedState()` first runs
  `reconcileInterruptedRunnerOperations()`: for every item left in PUBLISHING
  with a persisted operationId, the durable ledger is queried. Only
  ledger-proven states relax the conservative defaults
  (`src/domain/runner-reconciliation.ts`):
  - `CONFIRMED` → PUBLISHED (with the recorded post URL),
  - `RECEIVED / STARTED / CANCELLED / FAILED_BEFORE_SUBMIT` → PENDING (the
    click provably never happened),
  - `REJECTED` → FAILED,
  - `SUBMITTED / UNVERIFIED` or an unreachable runner → unchanged; domain
    recovery quarantines the item as `PUBLISHED_UNVERIFIED`. A lost channel is
    never treated as proof of publish failure.
- Pause/Stop immediately stop accepting new publishes and send an advisory
  `CANCEL` to the runner. Cancellation is effective only **before** the
  submit; afterwards the item settles via the ledger (recorded result or
  PUBLISHED_UNVERIFIED) — stop never claims a possibly-sent post was
  cancelled, and never returns the item to PENDING.
- On channel loss the runner never starts the next item on its own: it has no
  scheduler; the extension owns progression.
- Scheduling remains in the extension and requires Chrome to be running (no
  independent background service is claimed).

## X flow rules

- The runner reuses the **same selector/label recognition rules** as the
  content script (mirrored `x-selectors` modules, kept in sync by tests) —
  separated from any `chrome.*` dependency.
- Waits are **condition-based** with configurable, diagnosable timeouts; no
  fixed sleeps.
- Before publish: login, account, composer content (Arabic, links, newlines,
  emoji — compared through the intent URL `text` parameter), and an enabled
  Post button are all verified. Publishing never proceeds on the mere
  presence of text in a composer.
- Login pages, CAPTCHA/challenges, or daily-limit banners stop the operation
  with explicit codes. **No stealth tooling, no CAPTCHA bypass, no rate-limit
  evasion.**
- Dry Run and Preflight use `INSPECT` only — structurally isolated from the
  publish command (proven by tests: zero CreateTweet calls).

## Platform support (honest scope)

- Target: Windows 10/11 x64, Node.js ≥ 20 (tested on Node 24), Playwright
  1.49.1 with its bundled Chromium (full build, new headless).
- The Linux sandbox in which this branch was developed ran the full automated
  suite including real-Chromium integration tests; **Windows itself was not
  available for live verification** — the installer path and HKCU registration
  are delivered as scripts with explicit prerequisites (see
  local-runner-install-windows.md). Runtime verification against the real
  x.com site was NOT performed and is explicitly listed as untested.

## Compliance disclaimer

This path automates the X web UI. X's current rules prohibit automation
outside the official API and may lead to account suspension. This feature is
NOT platform-approved and carries no guarantee against enforcement actions.
