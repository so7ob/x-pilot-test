/**
 * X page flow for the Local Runner: navigation, composer recognition, content
 * verification, and the publish click with attempt-scoped evidence collection.
 *
 * Verification policy (publish success is PROVEN, never guessed):
 * 1. PRIMARY EVIDENCE — passive observation of the CreateTweet response the
 *    page itself generates when the Post button is clicked (no requests are
 *    re-created or sent directly to X APIs by the runner).
 * 2. SECONDARY EVIDENCE — a status link that did NOT exist before this click
 *    plus the X confirmation toast.
 * 3. Composer disappearance, a toast alone, or a timeout are NEVER success.
 *    Insufficient evidence → UNVERIFIED; the extension then quarantines the
 *    item as PUBLISHED_UNVERIFIED and pauses (no automatic republication).
 *
 * All waits are condition-based with configurable, diagnosable timeouts.
 * No stealth tooling and no CAPTCHA/limit bypass: login, challenge, or daily
 * limit states stop the operation with explicit codes.
 */

import type { Page, Response } from 'playwright';
import {
  accountFromProfileHref,
  accountLinkSelectors,
  composerSelectors,
  confirmationToastSelectors,
  isDailyPostLimitMessage,
  normalizeComposerText,
  postButtonSelectors,
  publishContentFromIntentUrl,
  isXIntentUrl
} from './x-selectors.ts';
import type { RunnerInspection, RunnerPublishResult } from './protocol.ts';
import { RunnerLogger } from './logging.ts';

const CREATE_TWEET_URL_PATTERN = /\/i\/api\/graphql\/[^/]+\/(CreateTweet|create-tweet)/i;

export interface XFlowOptions {
  baseUrl: string;
  extraHosts?: string[];
  timeouts?: Partial<XFlowTimeouts>;
}

export interface XFlowTimeouts {
  navigation: number;
  composer: number;
  account: number;
  evidence: number;
  click: number;
}

const DEFAULT_TIMEOUTS: XFlowTimeouts = { navigation: 45_000, composer: 30_000, account: 15_000, evidence: 20_000, click: 15_000 };

export class XFlow {
  private readonly timeouts: XFlowTimeouts;
  private readonly options: XFlowOptions;
  private readonly logger: RunnerLogger;
  constructor(options: XFlowOptions, logger: RunnerLogger = new RunnerLogger()) {
    this.options = options;
    this.logger = logger;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  }

  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/$/, '');
  }

  private homeUrl(): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/home`;
  }

  private validateTargetUrl(targetUrl: string): void {
    const extraHosts = this.options.extraHosts ?? [];
    if (!isXIntentUrl(targetUrl, extraHosts)) {
      const parsed = (() => { try { return new URL(targetUrl).hostname; } catch { return ''; } })();
      if (!parsed || !extraHosts.includes(parsed)) throw new Error(`RUNNER_INVALID_TARGET_URL:${targetUrl}`);
    }
  }

  /** Classifies the signed-in state and detects the account handle. */
  async detectAccount(page: Page): Promise<{ pageKind: RunnerInspection['pageKind']; account?: string; dailyPostLimitReached: boolean; reason?: string }> {
    await page.goto(this.homeUrl(), { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigation });
    const loginUrl = page.url().includes('/i/flow/login') || page.url().endsWith('/login');
    const bodyText = (await page.evaluate(() => document.body?.innerText ?? '')).slice(0, 8000).toLocaleLowerCase();
    if (loginUrl || bodyText.includes('log in to x') || bodyText.includes('تسجيل الدخول')) return { pageKind: 'LOGIN', dailyPostLimitReached: false, reason: 'RUNNER_LOGIN_REQUIRED' };
    if (bodyText.includes('captcha') || bodyText.includes('challenge')) return { pageKind: 'CHALLENGE', dailyPostLimitReached: false, reason: 'RUNNER_CHALLENGE' };
    if (isDailyPostLimitMessage(bodyText)) return { pageKind: 'X', dailyPostLimitReached: true, reason: 'RUNNER_DAILY_LIMIT' };
    const account = await this.waitForAccount(page, this.timeouts.account);
    return { pageKind: 'X', account, dailyPostLimitReached: false, reason: account ? undefined : 'RUNNER_ACCOUNT_UNKNOWN' };
  }

  private async waitForAccount(page: Page, timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const href = await page.evaluate((selectors: string[]) => {
        for (const selector of selectors) {
          const anchor = document.querySelector<HTMLAnchorElement>(selector);
          const found = anchor?.getAttribute('href');
          if (found) return found;
        }
        return null;
      }, [...accountLinkSelectors]);
      if (href) {
        const handle = accountFromProfileHref(href);
        if (handle) return handle;
      }
      if (Date.now() >= deadline) return undefined;
      await page.waitForTimeout(500);
    }
  }

  /** Opens the target (intent) URL and inspects publish controls without publishing. */
  async inspectTarget(page: Page, targetUrl: string, expected: { expectedAccount?: string; expectedContent?: string }): Promise<RunnerInspection> {
    this.validateTargetUrl(targetUrl);
    const detected = await this.detectAccount(page);
    if (detected.pageKind !== 'X') {
      return { pageKind: detected.pageKind, composerFound: false, contentPresent: false, contentMatches: false, postButtonFound: false, postButtonEnabled: false, detectedAccount: detected.account, dailyPostLimitReached: detected.dailyPostLimitReached, reason: detected.reason, checkedAt: Date.now() };
    }
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigation });
    const controls = await this.waitForComposer(page, this.timeouts.composer);
    const expectedFromUrl = expected.expectedContent ?? publishContentFromIntentUrl(targetUrl, this.options.extraHosts ?? []);
    const contentMatches = expectedFromUrl === undefined ? true : controls.composerText !== undefined && normalizeComposerText(controls.composerText) === normalizeComposerText(expectedFromUrl);
    const bodyText = (await page.evaluate(() => document.body?.innerText ?? '')).slice(0, 8000).toLocaleLowerCase();
    return {
      pageKind: 'X',
      composerFound: controls.composerFound,
      contentPresent: controls.composerText !== undefined && controls.composerText.length > 0,
      contentMatches,
      postButtonFound: controls.postButtonFound,
      postButtonEnabled: controls.postButtonEnabled,
      detectedAccount: detected.account,
      dailyPostLimitReached: detected.dailyPostLimitReached || isDailyPostLimitMessage(bodyText),
      reason: controls.composerFound ? (contentMatches ? undefined : 'RUNNER_CONTENT_MISMATCH') : 'PUBLISH_CONTROLS_NOT_READY',
      checkedAt: Date.now(),
    };
  }

  private async waitForComposer(page: Page, timeoutMs: number): Promise<{ composerFound: boolean; composerText?: string; postButtonFound: boolean; postButtonEnabled: boolean }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const controls = await this.readControls(page);
      if (controls.composerFound && controls.postButtonFound) return controls;
      if (Date.now() >= deadline) return controls;
      await page.waitForTimeout(400);
    }
  }

  private async readControls(page: Page): Promise<{ composerFound: boolean; composerText?: string; postButtonFound: boolean; postButtonEnabled: boolean }> {
    return page.evaluate((params: { composerSelectors: string[]; postButtonSelectors: string[] }) => {
      const readText = (element: Element): string => (element instanceof HTMLTextAreaElement ? element.value : (element as HTMLElement).innerText || element.textContent || '').trim();
      const isVisible = (element: HTMLElement): boolean => {
        if (!element.isConnected || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
      };
      const findFirst = (selectors: string[]): HTMLElement | null => {
        for (const selector of selectors) {
          const element = document.querySelector<HTMLElement>(selector);
          if (element && isVisible(element)) return element;
        }
        return null;
      };
      const composer = findFirst(params.composerSelectors);
      const button = findFirst(params.postButtonSelectors);
      const enabled = Boolean(button && !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true');
      return { composerFound: Boolean(composer), composerText: composer ? readText(composer) : undefined, postButtonFound: Boolean(button), postButtonEnabled: enabled };
    }, { composerSelectors: [...composerSelectors], postButtonSelectors: [...postButtonSelectors] });
  }

  private async collectStatusLinks(page: Page): Promise<string[]> {
    return page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')).map((anchor) => anchor.href));
  }

  private async isToastVisible(page: Page): Promise<boolean> {
    return page.evaluate((selectors: string[]) => {
      const readText = (element: Element): string => (element as HTMLElement).innerText || '';
      for (const selector of selectors) {
        const element = document.querySelector<HTMLElement>(selector);
        if (element && element.isConnected) {
          const text = readText(element);
          if (/your (?:post|tweet) was sent|تم إرسال (?:منشورك|تغريدتك)/iu.test(text)) return true;
        }
      }
      return false;
    }, [...confirmationToastSelectors]);
  }

  private static isCreateTweetResponse(response: Response): boolean {
    return CREATE_TWEET_URL_PATTERN.test(response.url()) && response.request().method() === 'POST';
  }

  /**
   * Executes the publish for one operation.
   * `beforeSubmit` runs after all pre-checks pass and MUST complete durably
   * BEFORE the click (the ledger SUBMITTED write). If it throws, the outcome
   * is a definite pre-submit failure.
   */
  async publishTarget(page: Page, targetUrl: string, expected: { expectedAccount?: string; expectedContent?: string }, beforeSubmit: () => Promise<void>): Promise<RunnerPublishResult> {
    this.validateTargetUrl(targetUrl);
    const detected = await this.detectAccount(page);
    if (detected.pageKind === 'LOGIN') return { outcome: 'FAILED_BEFORE_SUBMIT', reason: 'RUNNER_LOGIN_REQUIRED', detectedAccount: detected.account };
    if (detected.pageKind === 'CHALLENGE') return { outcome: 'FAILED_BEFORE_SUBMIT', reason: 'RUNNER_CHALLENGE', detectedAccount: detected.account };
    if (detected.dailyPostLimitReached) return { outcome: 'FAILED_BEFORE_SUBMIT', reason: 'RUNNER_DAILY_LIMIT', detectedAccount: detected.account };
    if (!detected.account) return { outcome: 'FAILED_BEFORE_SUBMIT', reason: 'RUNNER_ACCOUNT_UNKNOWN' };
    if (expected.expectedAccount && detected.account !== expected.expectedAccount.toLocaleLowerCase()) return { outcome: 'FAILED_BEFORE_SUBMIT', reason: `RUNNER_ACCOUNT_MISMATCH:${detected.account}`, detectedAccount: detected.account };

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigation });
    const controls = await this.waitForComposer(page, this.timeouts.composer);
    if (!controls.composerFound) return { outcome: 'FAILED_BEFORE_SUBMIT', reason: 'PUBLISH_CONTROLS_NOT_READY', detectedAccount: detected.account };
    if (!controls.postButtonFound) return { outcome: 'FAILED_BEFORE_SUBMIT', reason: 'POST_BUTTON_NOT_FOUND', detectedAccount: detected.account };
    if (!controls.postButtonEnabled) return { outcome: 'FAILED_BEFORE_SUBMIT', reason: 'POST_BUTTON_DISABLED', detectedAccount: detected.account };
    const expectedContent = expected.expectedContent ?? publishContentFromIntentUrl(targetUrl, this.options.extraHosts ?? []);
    if (expectedContent !== undefined) {
      const actual = controls.composerText !== undefined ? normalizeComposerText(controls.composerText) : '';
      if (actual !== normalizeComposerText(expectedContent)) {
        this.logger.warn('composer content mismatch; refusing to publish', { expected: expectedContent.slice(0, 80), actual: actual.slice(0, 80) });
        return { outcome: 'FAILED_BEFORE_SUBMIT', reason: 'RUNNER_CONTENT_MISMATCH', detectedAccount: detected.account };
      }
    }

    const preStatusLinks = new Set(await this.collectStatusLinks(page));
    // Durable pre-submit write: once this resolves, the click follows.
    await beforeSubmit();

    // Evidence channel armed BEFORE the click: passively observe the page's
    // own CreateTweet response (the runner never re-creates X API requests).
    const responsePromise = page.waitForResponse((response) => XFlow.isCreateTweetResponse(response), { timeout: this.timeouts.evidence }).catch(() => null);
    const clickError = await this.clickPostButton(page);
    if (clickError) {
      // The click itself failed before dispatch: definite pre-submit failure.
      return { outcome: 'FAILED_BEFORE_SUBMIT', reason: clickError, detectedAccount: detected.account };
    }
    const submittedAt = Date.now();
    const response = await responsePromise;
    const completedAt = Date.now();

    if (response) {
      const status = response.status();
      if (status >= 200 && status < 300) {
        const tweetId = await this.parseTweetId(response);
        if (tweetId) {
          const postUrl = `${this.options.baseUrl.replace(/\/$/, '')}/${detected.account}/status/${tweetId}`;
          return { outcome: 'CONFIRMED', postUrl, detectedAccount: detected.account, evidence: { createTweetResponseStatus: status, createTweetResponseUrl: response.url(), tweetId, submittedAt, completedAt } };
        }
        return { outcome: 'UNVERIFIED', reason: 'RUNNER_RESPONSE_WITHOUT_TWEET_ID', detectedAccount: detected.account, evidence: { createTweetResponseStatus: status, createTweetResponseUrl: response.url(), submittedAt, completedAt } };
      }
      const rejection = await this.parseRejection(response);
      return { outcome: 'REJECTED', reason: `RUNNER_PUBLISH_REJECTED:${rejection}`, detectedAccount: detected.account, evidence: { createTweetResponseStatus: status, createTweetResponseUrl: response.url(), submittedAt, completedAt } };
    }

    // No network evidence: secondary signals only.
    const postStatusLinks = await this.collectStatusLinks(page);
    const newStatusLink = postStatusLinks.find((link) => !preStatusLinks.has(link));
    const toast = await this.isToastVisible(page);
    if (newStatusLink && toast) {
      return { outcome: 'CONFIRMED', postUrl: newStatusLink, detectedAccount: detected.account, evidence: { confirmationToast: toast, newStatusLink, submittedAt, completedAt } };
    }
    return { outcome: 'UNVERIFIED', reason: 'RUNNER_NO_RESPONSE_EVIDENCE', detectedAccount: detected.account, evidence: { confirmationToast: toast, newStatusLink, submittedAt, completedAt } };
  }

  private async clickPostButton(page: Page): Promise<string | undefined> {
    const clicked = await page.evaluate((params: { postButtonSelectors: string[] }) => {
      const isVisible = (element: HTMLElement): boolean => {
        if (!element.isConnected || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
      };
      const findFirst = (selectors: string[]): HTMLElement | null => {
        for (const selector of selectors) {
          const element = document.querySelector<HTMLElement>(selector);
          if (element && isVisible(element)) return element;
        }
        return null;
      };
      const button = findFirst(params.postButtonSelectors);
      if (!button) return 'POST_BUTTON_NOT_FOUND';
      if (button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true') return 'POST_BUTTON_DISABLED';
      button.click();
      return null;
    }, { postButtonSelectors: [...postButtonSelectors] }).catch((error: unknown) => `CLICK_FAILED:${error instanceof Error ? error.message : String(error)}`);
    return clicked === null ? undefined : clicked;
  }

  private async parseTweetId(response: Response): Promise<string | undefined> {
    try {
      const body = await response.json() as { data?: { create_tweet?: { tweet_results?: { result?: { rest_id?: string; legacy?: { id_str?: string } } } } } };
      return body?.data?.create_tweet?.tweet_results?.result?.rest_id ?? body?.data?.create_tweet?.tweet_results?.result?.legacy?.id_str ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async parseRejection(response: Response): Promise<string> {
    try {
      const body = await response.json() as { errors?: Array<{ message?: string; code?: number }> };
      const first = body?.errors?.[0];
      if (first?.message) return `${first.code ?? 0}:${first.message}`;
    } catch { /* opaque body */ }
    return String(response.status());
  }
}
