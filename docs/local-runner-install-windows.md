# X-Pilot Local Runner — Windows Installation

> Scope: Windows 10/11 x64, per-user installation (HKCU, no admin required).

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Windows | 10 or 11, x64 | Install scripts run under Windows PowerShell 5.1 (`powershell.exe`). A v1.5.0 first-run crash on 5.1 was reported from a real machine and fixed in v1.5.1. |
| .NET Framework 4.x | included with Windows 10/11 | `install.ps1` compiles `x-pilot-runner.exe` with the bundled `csc.exe` (v1.5.3+). When absent it falls back to the `.cmd` launcher with a warning. |
| Node.js | ≥ 20 (LTS recommended) | `node --version` must work in PowerShell. |
| Playwright Chromium | bundled by `npm install` + `npx playwright install chromium` | ~100–170 MB download, first time only. |
| Chrome | stable with Side Panel support | The X-Pilot extension build (`dist/`) loaded unpacked. |

## Install

1. Build the extension:

   ```powershell
   cd <repo>
   npm install
   npm run build
   ```

2. Load it in Chrome (`chrome://extensions` → Developer mode → Load unpacked →
   select `dist/`) and **copy the extension ID** shown on the card (32 hex
   letters, `a–p`).

3. Install the runner host:

   ```powershell
   cd <repo>\local-runner\install
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -ExtensionId <YOUR_EXTENSION_ID>
   ```

   The installer:
   - verifies Node ≥ 20,
   - runs `npm install` + `npm run build` for the runner (produces
     `dist/index.js`),
   - downloads the Playwright Chromium build (skip with `-SkipBrowserDownload`
     if you manage browsers yourself),
   - **compiles `x-pilot-runner.exe`** from `install\x-pilot-runner.cs` using the
     .NET Framework `csc.exe` that ships with Windows, then self-tests it
     (issue #9): an `.exe` manifest makes Chrome use its **direct-launch path**
     with inherited pipe handles instead of the legacy
     `cmd.exe /d /s /c ... < pipe > pipe` redirection chain. Node is resolved
     via the `x-pilot-runner.node.txt` sidecar, well-known install locations,
     or PATH. If `csc.exe` is unavailable the installer falls back to the
     `.cmd` launcher with a warning,
   - renders `x-pilot-runner.cmd` (ASCII-only; resolves its own directory at
     runtime, so install paths with **spaces or Arabic characters** are safe)
     as the fallback launcher,
   - writes the native messaging manifest to
     `%LOCALAPPDATA%\X-Pilot\NativeMessagingHosts\com.so7ob.x_pilot_runner.json`
     with `allowed_origins` = your exact extension id (no wildcards) and
     `path` = the compiled `.exe`,
   - registers it under `HKCU:\Software\Google\Chrome\NativeMessagingHosts`.

   Re-run with `-RunnerHome <path>` if the runner package lives elsewhere.

4. In X-Pilot (Side Panel → Settings → Local Runner):
   1. Press **Test connection** — the runner version and protocol must show
      `Connected`.
   2. Press **Set up login** once — a visible browser window opens (it uses
      your installed Google Chrome on the runner's own profile directory,
      never your daily Chrome profile; since v1.5.4 it also no longer carries
      automation marks, so X's stepwise login and "Continue with Google"
      both work). Sign in to X inside it, then close it. The runner re-opens
      the profile headless and verifies the session persisted; the detected
      account appears in the card.
   3. Set the **expected account** for the workspace (handle without `@`).
      Publishing stops if the runner profile is signed in as a different
      account.
   4. Select **LOCAL_RUNNER** as the execution engine.

## Repair

```powershell
powershell -ExecutionPolicy Bypass -File .\repair.ps1 -ExtensionId <YOUR_EXTENSION_ID>
```

Use after reloading the extension with a new id, or after fixing a broken
build. Login profiles and the duplicate-prevention ledger are preserved.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Removes the HKCU registration, the manifest, the compiled launcher
(`x-pilot-runner.exe` + its node sidecar), and the rendered `.cmd` fallback.
**Login profiles and the operation ledger are preserved by default** under
`%LOCALAPPDATA%\X-Pilot\Runner`. Deleting them is a separate explicit action:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -PurgeData
```

## Where data lives

| Path | Content |
|---|---|
| `%LOCALAPPDATA%\X-Pilot\Runner\profiles\<workspaceId>` | Playwright user-data dirs (login sessions). Never inside the repo; never in extension backups. |
| `%LOCALAPPDATA%\X-Pilot\Runner\ledger\operations.json` | Durable duplicate-publish ledger. |
| `%LOCALAPPDATA%\X-Pilot\Runner\logs\runner.log` | Rotating runner logs (2 MB × 3). Since v1.5.3 every session records its `host process context` (argv + `callerOrigin`, so Chrome launches are identifiable) plus `request received` / `response sent` lines and `framesReceived`/`responsesSent` shutdown counters. |
| `%LOCALAPPDATA%\X-Pilot\Runner\logs\host-stderr.log` | stderr of the LAST host launch (bootstrap crashes such as `Cannot find module`; bounded at 512 KB, v1.5.2+). |
| `<local-runner>\x-pilot-runner.exe` | Compiled launcher Chrome launches directly (v1.5.3+). |
| `<local-runner>\x-pilot-runner.node.txt` | Sidecar with the absolute node.exe path for the compiled launcher. |

## Diagnosing with doctor.ps1 (v1.5.2+)

Run the bundled diagnostic any time, without opening Chrome:

```powershell
powershell -ExecutionPolicy Bypass -File .\local-runner\install\doctor.ps1
```

It checks Node.js, the runner files, the HKCU registration, the manifest bytes
(including a BOM check and whether the registered launcher is the compiled
`.exe` or a legacy `.cmd`), and then performs a **live framed PING** against
the real launch chain - three times: directly with `node dist\index.js`,
through `cmd.exe /c x-pilot-runner.cmd`, and through
`x-pilot-runner.exe chrome-extension://<id>/ --parent-window=0` with the exact
Chrome-style arguments. If all three pass, the launch chain is healthy and any
remaining failure is on the Chrome side (stale registration -> fully restart
Chrome via `chrome://restart`).

## Troubleshooting (distinct states, not a generic error)

| UI state / code | Meaning | Action |
|---|---|---|
| Chrome: `Error when communicating with the native messaging host.` | The host pipe broke after launch. Two known causes on Windows: (v1.5.0/v1.5.1) a **UTF-8 BOM** in the manifest (issue #6, fixed in v1.5.2), and (all versions ≤ v1.5.2) registering a **`.cmd` launcher**, which forces Chrome's legacy `cmd.exe` pipe-redirection launch path (issue #9, fixed in v1.5.3 by compiling and registering `x-pilot-runner.exe`) | **Install v1.5.3** (or re-run its `install.ps1`), then fully restart Chrome (`chrome://restart`). For v1.5.0/v1.5.1 without re-downloading: `[IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p), (New-Object Text.UTF8Encoding($false)))` with `$p = "$env:LOCALAPPDATA\X-Pilot\NativeMessagingHosts\com.so7ob.x_pilot_runner.json"`. If it still fails, run `install\doctor.ps1`; the runner.log `callerOrigin`/`framesReceived` lines now pinpoint which link failed. |
| Chrome: `Specified native messaging host not found.` | Registry key or manifest file missing | Run install.ps1 with the correct extension id. |
| Chrome: `Access to the specified native messaging host is forbidden.` | The installed extension id is not in `allowed_origins` | Re-run install.ps1 (or repair.ps1) with the id shown on chrome://extensions. |
| Installer: `Split-Path: Cannot bind argument ... empty string` | v1.5.0 bug: `$PSScriptRoot` was read inside a `param()` default (empty on Windows PowerShell 5.1) | Fixed in v1.5.1. With the v1.5.0 zip you can also pass `-RunnerHome <path to local-runner>` explicitly. |
| Not installed (`RUNNER_NOT_INSTALLED`) | Host manifest missing | Run install.ps1 with the correct extension id. |
| Failed to start (`RUNNER_LAUNCH_FAILED`) | Host registered but the process fails | Run `install\doctor.ps1`; check `logs\runner.log` and `logs\host-stderr.log`; verify Node >= 20. |
| Protocol mismatch (`RUNNER_PROTOCOL_MISMATCH`) | Extension/runner versions disagree | Update the runner (`repair.ps1`) and reload the extension. |
| Login expired (`RUNNER_LOGIN_REQUIRED`) | Runner profile session invalid | Press Set up login again. |
| X login form stalls silently after entering the username (≤ v1.5.3) | The login window exposed `navigator.webdriver === true` (Playwright `--enable-automation`, no anti-automation flags in headed mode) — X's login flow refuses to advance in automation-flagged browsers | **Install v1.5.4** (issue #12: anti-automation launch profile in both modes). |
| Google sign-in in the login window: «تعذّر تسجيل الدخول — قد يكون هذا المتصفّح أو التطبيق غير آمن» / "This browser or app may not be secure" (≤ v1.5.3) | Google refuses automation-flagged and generic Chromium builds; the X login page offers "Continue with Google" | **Install v1.5.4** — the login window now prefers the installed branded Google Chrome (`channel: 'chrome'`) with automation marks removed. If you have no branded Chrome installed, the runner logs a fallback warning and X's email login still works, but Google sign-in may be refused. |
| Profile in use (`RUNNER_PROFILE_LOCKED`) | Another process/session owns the profile | Close the other session (or login window) and retry. |
| Account mismatch (`RUNNER_ACCOUNT_MISMATCH`) | Signed-in account ≠ workspace expected account | Fix the login or update the expected account. |

## Limitations (explicit)

- The installer chain has now been exercised on a real Windows machine three
  times: v1.5.0 crashed at startup under Windows PowerShell 5.1 (fixed in
  v1.5.1, issue #3); v1.5.1 completed the install but Chrome failed every
  `connectNative` with the generic communication error because the manifest
  carried a UTF-8 BOM (fixed in v1.5.2, issue #6); v1.5.2 got the host
  **launching** (runner.log proved it) but the pipe still broke because a
  `.cmd` manifest forces Chrome's cmd.exe pipe-redirection launch path —
  fixed in v1.5.3 (issue #9) by compiling and registering a real
  `x-pilot-runner.exe` on the direct-launch path. Re-run `install.ps1`, then
  `install\doctor.ps1`, then **Test connection** to confirm the full path
  end-to-end.
- v1.5.4 (issue #12): the login window's automation marks were measured on
  real Chromium (`navigator.webdriver = true` with the v1.5.3 options,
  `undefined` after the fix) and the new `channel: 'chrome'` preference is
  covered by unit contracts with a fake Playwright factory. The final
  confirmation of the live x.com / Google sign-in flow rests with the
  reporter's machine (the dev environment has no display and no branded
  Chrome).
- No live publish against x.com was performed during development.
- X UI changes can break selectors; the runner shares the adapter's selector
  rules so fixes apply to both engines together.
- Automating X outside the official API may violate X's rules and can lead to
  account suspension. This is a local tool with no approval from the platform.
