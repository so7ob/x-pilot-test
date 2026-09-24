/**
 * Playwright persistent-context management for the Local Runner.
 *
 * - Each profile uses its OWN user-data directory (never the user's daily
 *   Chrome profile) via chromium.launchPersistentContext.
 * - Headless operation contexts and the visible login window are mutually
 *   exclusive per profile (enforced with the ProfileLock).
 * - Idle contexts are closed automatically; CLEANUP closes them immediately.
 * - The runner only closes processes it launched itself.
 */
import type { BrowserContext } from 'playwright';
import { ProfileLock, profilePaths, ProfileLockError, type ProfilePaths } from './profile-store.ts';
import { RunnerLogger } from './logging.ts';

const IDLE_CLOSE_MS = 5 * 60 * 1000;

/**
 * Anti-automation launch profile (issue #12).
 *
 * Playwright marks every Chromium it launches as automated: the default
 * `--enable-automation` switch enables the AutomationControlled blink
 * feature, which exposes `navigator.webdriver === true` (plus the
 * "controlled by automated test software" infobar). Two independent
 * providers refuse such browsers during the human-driven login window:
 * - X's login flow silently refuses to advance past the username step.
 * - Google's sign-in page rejects with "This browser or app may not be
 *   secure" (the X login page offers "Continue with Google").
 *
 * The runner therefore removes the automation marks in BOTH modes:
 * - `ignoreDefaultArgs` drops Playwright's `--enable-automation` switch.
 * - `--disable-blink-features=AutomationControlled` stops the feature from
 *   being enabled by any other path (previously applied to headless ONLY —
 *   the login window, the one place a human types credentials, was missed).
 * - One init script shadows any residual `navigator.webdriver` exposure to
 *   `undefined` before any page script runs (defense in depth for Chromium
 *   builds where the flags alone are insufficient).
 *
 * Policy (unchanged, see x-flow.ts): this is NOT a challenge bypass and NOT
 * fingerprint spoofing — CAPTCHAs, verification steps and daily limits still
 * stop operations with explicit codes, no fake user-agent/plugins/WebGL are
 * injected, and the login window stays 100% human-driven. The launched
 * browser simply stops self-identifying as automation.
 */
const ANTI_AUTOMATION_ARGS: string[] = ['--disable-blink-features=AutomationControlled'];
const IGNORED_DEFAULT_ARGS: string[] = ['--enable-automation'];
const WEBDRIVER_NEUTRALIZER_INIT_SCRIPT = 'Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });';

export interface LaunchOptions {
  headless: boolean;
  browserType?: 'chromium';
  timeoutMs?: number;
}

export interface ProfileContext {
  paths: ProfilePaths;
  lock: ProfileLock;
  context: BrowserContext | null;
  lastUsedAt: number;
  loginWindowOpen: boolean;
  mode?: 'headless' | 'headed';
}

/** Injectable Playwright factory so unit tests can run without the browser. */
export type PlaywrightFactory = () => Promise<{ chromium: { launchPersistentContext: (userDataDir: string, options: Record<string, unknown>) => Promise<BrowserContext> } }>;

async function defaultPlaywrightFactory(): Promise<{ chromium: { launchPersistentContext: (userDataDir: string, options: Record<string, unknown>) => Promise<BrowserContext> } }> {
  const playwright = await import('playwright');
  return playwright as unknown as { chromium: { launchPersistentContext: (userDataDir: string, options: Record<string, unknown>) => Promise<BrowserContext> } };
}

export class BrowserManager {
  private readonly profiles = new Map<string, ProfileContext>();
  private readonly logger: RunnerLogger;
  private readonly playwrightFactory: PlaywrightFactory;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(logger: RunnerLogger = new RunnerLogger(), playwrightFactory?: PlaywrightFactory) {
    this.logger = logger;
    this.playwrightFactory = playwrightFactory ?? defaultPlaywrightFactory;
  }

  private ensureEntry(profileId: string): ProfileContext {
    let entry = this.profiles.get(profileId);
    if (!entry) {
      const paths = profilePaths(profileId);
      entry = { paths, lock: new ProfileLock(paths.profileDir, this.logger), context: null, lastUsedAt: Date.now(), loginWindowOpen: false };
      this.profiles.set(profileId, entry);
    }
    return entry;
  }

  /**
   * Opens (or reuses) the persistent context for a profile. A context is
   * reused only when the requested mode matches; switching between headless
   * operation and the visible login window closes and relaunches cleanly
   * under the same profile lock. Fails with RUNNER_PROFILE_LOCKED when another
   * process owns the profile.
   */
  async openContext(profileId: string, options: LaunchOptions = { headless: true }): Promise<BrowserContext> {
    const entry = this.ensureEntry(profileId);
    const requestedMode: 'headless' | 'headed' = options.headless ? 'headless' : 'headed';
    if (entry.context && entry.mode === requestedMode) {
      entry.lastUsedAt = Date.now();
      this.touch(profileId);
      return entry.context;
    }
    if (entry.context && entry.mode !== requestedMode) {
      // Mode switch (e.g., OPEN_LOGIN while an idle headless context is open):
      // close the runner-owned context first — never run two contexts on one
      // profile directory.
      await this.closeContext(profileId);
    }
    await entry.lock.acquire(requestedMode === 'headless' ? 'headless-session' : 'login-window');
    const playwright = await this.playwrightFactory();
    try {
      const context = await this.launchPersistentContext(playwright, entry.paths.profileDir, {
        headless: options.headless,
        viewport: options.headless ? { width: 1280, height: 900 } : undefined,
        timeoutMs: options.timeoutMs ?? 60_000,
      });
      entry.context = context;
      entry.mode = requestedMode;
      entry.loginWindowOpen = requestedMode === 'headed';
      entry.lastUsedAt = Date.now();
      context.on('close', () => {
        entry.context = null;
        entry.mode = undefined;
        if (entry.loginWindowOpen) entry.loginWindowOpen = false;
        void entry.lock.release();
      });
      this.scheduleIdleSweep();
      this.logger.info('browser context launched', { profileId, mode: requestedMode });
      return context;
    } catch (error) {
      await entry.lock.release();
      if (error instanceof ProfileLockError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('browser launch failed', { profileId, message });
      throw new Error(`RUNNER_LAUNCH_FAILED:${message}`);
    }
  }

  /**
   * Launches the persistent context with the anti-automation profile.
   *
   * Binary choice:
   * - Headless operations → the bundled full Chromium (channel: 'chromium',
   *   new-headless mode; the minimal headless shell does NOT persist cookies).
   * - The login window (headed) → the INSTALLED, branded Google Chrome
   *   (channel: 'chrome') when available: Google's sign-in page — offered by
   *   the X login page as "Continue with Google" — refuses generic Chromium
   *   builds with "This browser or app may not be secure". Still the Runner's
   *   OWN dedicated user-data directory: never the user's daily Chrome profile
   *   or session. Falls back to bundled Chromium (with a warning) when no
   *   branded Chrome is installed; X's own email login still works there.
   */
  private async launchPersistentContext(
    playwright: Awaited<ReturnType<PlaywrightFactory>>,
    profileDir: string,
    options: { headless: boolean; viewport?: { width: number; height: number }; timeoutMs: number },
  ): Promise<BrowserContext> {
    const launchOptions: Record<string, unknown> = {
      headless: options.headless,
      viewport: options.viewport,
      timeout: options.timeoutMs,
      args: ANTI_AUTOMATION_ARGS,
      ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
    };
    let context: BrowserContext;
    if (!options.headless) {
      try {
        context = await playwright.chromium.launchPersistentContext(profileDir, { ...launchOptions, channel: 'chrome' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn('installed Google Chrome unavailable for the login window; falling back to bundled Chromium (Google sign-in on the X login page may be refused there)', { message });
        context = await playwright.chromium.launchPersistentContext(profileDir, { ...launchOptions, channel: 'chromium' });
      }
    } else {
      context = await playwright.chromium.launchPersistentContext(profileDir, { ...launchOptions, channel: 'chromium' });
    }
    // Registered before any navigation to x.com: every page created in this
    // context (login window, INSPECT, PUBLISH) evaluates it first.
    try {
      await context.addInitScript(WEBDRIVER_NEUTRALIZER_INIT_SCRIPT);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('webdriver neutralizer init script registration failed', { message });
    }
    return context;
  }

  async closeContext(profileId: string): Promise<void> {
    const entry = this.profiles.get(profileId);
    if (!entry?.context) return;
    try {
      await entry.context.close();
    } catch { /* already closed */ }
    entry.context = null;
    entry.loginWindowOpen = false;
    await entry.lock.release();
  }

  async closeLoginWindow(profileId: string): Promise<boolean> {
    const entry = this.profiles.get(profileId);
    if (!entry?.loginWindowOpen || !entry.context) return false;
    await this.closeContext(profileId);
    return true;
  }

  isLoginWindowOpen(profileId: string): boolean {
    return this.profiles.get(profileId)?.loginWindowOpen ?? false;
  }

  async closeAll(): Promise<void> {
    for (const profileId of [...this.profiles.keys()]) await this.closeContext(profileId);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  activeProfileCount(): number {
    return [...this.profiles.values()].filter((entry) => entry.context !== null).length;
  }

  private scheduleIdleSweep(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => { void this.idleSweep(); }, 30_000);
    this.idleTimer.unref?.();
  }

  private async idleSweep(): Promise<void> {
    const now = Date.now();
    for (const [profileId, entry] of this.profiles) {
      if (entry.loginWindowOpen) continue; // user is interacting with the login window
      if (entry.context && now - entry.lastUsedAt > IDLE_CLOSE_MS) {
        this.logger.info('closing idle browser context', { profileId });
        await this.closeContext(profileId);
      }
    }
    if (![...this.profiles.values()].some((entry) => entry.context)) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  touch(profileId: string): void {
    const entry = this.profiles.get(profileId);
    if (entry) entry.lastUsedAt = Date.now();
  }
}
