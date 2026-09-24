# X-Pilot Local Runner — Windows Installation

> Scope: Windows 10/11 x64, per-user installation (HKCU, no admin required).

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Windows | 10 or 11, x64 | Developed/automated-tested on Linux; Windows runtime not yet live-verified (see Limitations). |
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

## Troubleshooting (distinct states, not a generic error)

| UI state / code | Meaning | Action |
|---|---|---|
| Not installed (`RUNNER_NOT_INSTALLED`) | Host manifest missing | Run install.ps1 with the correct extension id. |
| Failed to start (`RUNNER_LAUNCH_FAILED`) | Host registered but the process fails | Check `logs\runner.log`; verify Node ≥ 20. |
| Protocol mismatch (`RUNNER_PROTOCOL_MISMATCH`) | Extension/runner versions disagree | Update the runner (`repair.ps1`) and reload the extension. |
| Login expired (`RUNNER_LOGIN_REQUIRED`) | Runner profile session invalid | Press Set up login again. |
| Profile in use (`RUNNER_PROFILE_LOCKED`) | Another process/session owns the profile | Close the other session (or login window) and retry. |
| Account mismatch (`RUNNER_ACCOUNT_MISMATCH`) | Signed-in account ≠ workspace expected account | Fix the login or update the expected account. |

## Limitations (explicit)

- The installer and HKCU registration were authored for Windows and reviewed,
  but **not executed on a Windows machine in this development cycle** — the
  automated suite (protocol, ledger, lock, commands, real-Chromium flow, and
  the built-host end-to-end test) ran on Linux. Run the installer once on
  Windows and press **Test connection** to confirm.
- No live publish against x.com was performed during development.
- X UI changes can break selectors; the runner shares the adapter's selector
  rules so fixes apply to both engines together.
- Automating X outside the official API may violate X's rules and can lead to
  account suspension. This is a local tool with no approval from the platform.
