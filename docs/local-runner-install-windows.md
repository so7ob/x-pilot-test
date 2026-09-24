# X-Pilot Local Runner — Windows Installation

> Scope: Windows 10/11 x64, per-user installation (HKCU, no admin required).

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Windows | 10 or 11, x64 | Install scripts run under Windows PowerShell 5.1 (`powershell.exe`). A v1.5.0 first-run crash on 5.1 was reported from a real machine and fixed in v1.5.1. |
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
   - renders `x-pilot-runner.cmd` (ASCII-only; resolves its own directory at
     runtime, so install paths with **spaces or Arabic characters** are safe),
   - writes the native messaging manifest to
     `%LOCALAPPDATA%\X-Pilot\NativeMessagingHosts\com.so7ob.x_pilot_runner.json`
     with `allowed_origins` = your exact extension id (no wildcards),
   - registers it under `HKCU:\Software\Google\Chrome\NativeMessagingHosts`.

   Re-run with `-RunnerHome <path>` if the runner package lives elsewhere.

4. In X-Pilot (Side Panel → Settings → Local Runner):
   1. Press **Test connection** — the runner version and protocol must show
      `Connected`.
   2. Press **Set up login** once — a visible browser window opens. Sign in
      to X inside it, then close it. The runner re-opens the profile headless
      and verifies the session persisted; the detected account appears in the
      card.
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

Removes the HKCU registration, the manifest, and the rendered launcher.
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
| `%LOCALAPPDATA%\X-Pilot\Runner\logs\runner.log` | Rotating runner logs (2 MB × 3). |
| `%LOCALAPPDATA%\X-Pilot\Runner\logs\host-stderr.log` | stderr of the LAST host launch (bootstrap crashes such as `Cannot find module`; overwritten per launch, v1.5.2+). |

## Diagnosing with doctor.ps1 (v1.5.2+)

Run the bundled diagnostic any time, without opening Chrome:

```powershell
powershell -ExecutionPolicy Bypass -File .\local-runner\install\doctor.ps1
```

It checks Node.js, the runner files, the HKCU registration, the manifest bytes
(including a BOM check), and then performs a **live framed PING** against the
real launch chain - once directly with `node dist\index.js` and once through
`cmd.exe /c x-pilot-runner.cmd`, the exact command Chrome runs. If both
pass, the launch chain is healthy and any remaining failure is on the Chrome
side (stale registration -> fully restart Chrome via `chrome://restart`).

## Troubleshooting (distinct states, not a generic error)

| UI state / code | Meaning | Action |
|---|---|---|
| Chrome: `Error when communicating with the native messaging host.` | The host was found but failed to launch. In v1.5.0/v1.5.1 on Windows PowerShell 5.1 the manifest was written **with a UTF-8 BOM**, which Chrome's JSON reader rejects (issue #6) | **Fixed in v1.5.2.** Without re-downloading you can repair it in place, then FULLY restart Chrome (`chrome://restart`): `[IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p), (New-Object Text.UTF8Encoding($false)))` with `$p = "$env:LOCALAPPDATA\X-Pilot\NativeMessagingHosts\com.so7ob.x_pilot_runner.json"`. If it still fails, run `install\doctor.ps1` and check `logs\host-stderr.log`. |
| Chrome: `Specified native messaging host not found.` | Registry key or manifest file missing | Run install.ps1 with the correct extension id. |
| Chrome: `Access to the specified native messaging host is forbidden.` | The installed extension id is not in `allowed_origins` | Re-run install.ps1 (or repair.ps1) with the id shown on chrome://extensions. |
| Installer: `Split-Path: Cannot bind argument ... empty string` | v1.5.0 bug: `$PSScriptRoot` was read inside a `param()` default (empty on Windows PowerShell 5.1) | Fixed in v1.5.1. With the v1.5.0 zip you can also pass `-RunnerHome <path to local-runner>` explicitly. |
| Not installed (`RUNNER_NOT_INSTALLED`) | Host manifest missing | Run install.ps1 with the correct extension id. |
| Failed to start (`RUNNER_LAUNCH_FAILED`) | Host registered but the process fails | Run `install\doctor.ps1`; check `logs\runner.log` and `logs\host-stderr.log`; verify Node >= 20. |
| Protocol mismatch (`RUNNER_PROTOCOL_MISMATCH`) | Extension/runner versions disagree | Update the runner (`repair.ps1`) and reload the extension. |
| Login expired (`RUNNER_LOGIN_REQUIRED`) | Runner profile session invalid | Press Set up login again. |
| Profile in use (`RUNNER_PROFILE_LOCKED`) | Another process/session owns the profile | Close the other session (or login window) and retry. |
| Account mismatch (`RUNNER_ACCOUNT_MISMATCH`) | Signed-in account ≠ workspace expected account | Fix the login or update the expected account. |

## Limitations (explicit)

- The installer chain has now been exercised on a real Windows machine twice:
  v1.5.0 crashed at startup under Windows PowerShell 5.1 (fixed in v1.5.1,
  issue #3), and v1.5.1 completed the install but Chrome failed every
  `connectNative` with the generic communication error because the manifest
  carried a UTF-8 BOM (fixed in v1.5.2, issue #6, with byte-level
  self-verification and doctor.ps1). Re-run `install.ps1`, then
  `install\doctor.ps1`, then **Test connection** to confirm the full path
  end-to-end.
- No live publish against x.com was performed during development.
- X UI changes can break selectors; the runner shares the adapter's selector
  rules so fixes apply to both engines together.
- Automating X outside the official API may violate X's rules and can lead to
  account suspension. This is a local tool with no approval from the platform.
