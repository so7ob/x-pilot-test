import type { ContentInspection } from '../../domain/models';
import {
  accountFromProfileHref,
  accountLinkSelectors,
  composerSelectors,
  confirmationToastSelectors,
  dailyPostLimitPattern,
  excludedLabelPattern,
  isDailyPostLimitMessage,
  isPublishButtonLabel,
  normalizeControlLabel,
  postButtonSelectors,
  publishTestIdPattern
} from '../../domain/x-selectors.ts';

function findFirst(selectors: readonly string[]): HTMLElement | null {
  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element && isVisibleControl(element)) return element;
  }
  return null;
}

function readText(element: HTMLElement): string {
  return (element instanceof HTMLTextAreaElement ? element.value : element.innerText || element.textContent || '').trim();
}

export { normalizeControlLabel, isPublishButtonLabel, isDailyPostLimitMessage };

function isVisibleControl(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = element.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? element.getClientRects().length > 0 : true;
}

function isEnabledControl(element: HTMLElement): boolean {
  return !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
}

function controlMetadata(element: HTMLElement): string {
  return [
    readText(element),
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('title') ?? '',
    element.getAttribute('data-testid') ?? ''
  ].filter(Boolean).join(' ');
}

function isPublishControl(element: HTMLElement): boolean {
  if (!isVisibleControl(element) || !isEnabledControl(element)) return false;
  const testId = element.getAttribute('data-testid') ?? '';
  if (publishTestIdPattern.test(testId) && !excludedLabelPattern.test(normalizeControlLabel(controlMetadata(element)))) return true;
  return isPublishButtonLabel(readText(element)) || isPublishButtonLabel(element.getAttribute('aria-label') ?? '') || isPublishButtonLabel(element.getAttribute('title') ?? '');
}

function findPostButton(): HTMLElement | null {
  const selected = findFirst(postButtonSelectors);
  if (selected && isPublishControl(selected)) return selected;
  return Array.from(document.querySelectorAll<HTMLElement>('button,[role="button"],[data-testid*="tweetButton"],[data-testid*="postButton"]')).find(isPublishControl) ?? null;
}

/** Returns the signed-in account handle using the profile link (secondary evidence, also used by diagnostics). */
export function detectAccountHandle(): string | undefined {
  for (const selector of accountLinkSelectors) {
    const anchor = document.querySelector<HTMLAnchorElement>(selector);
    const href = anchor?.getAttribute('href');
    if (href) {
      const handle = accountFromProfileHref(href);
      if (handle) return handle;
    }
  }
  return undefined;
}

/** Status links currently visible on the page, used to bind publish evidence to THIS attempt. */
export function collectStatusLinks(): string[] {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
    .map((anchor) => anchor.href)
    .filter((href) => /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(href));
}

/** True when the X "post was sent" toast is visible (secondary evidence only). */
export function isConfirmationToastVisible(): boolean {
  for (const selector of confirmationToastSelectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element && isVisibleControl(element)) {
      const text = readText(element);
      if (/your (?:post|tweet) was sent|تم إرسال (?:منشورك|تغريدتك)/iu.test(text)) return true;
    }
  }
  return false;
}

export function inspect(): ContentInspection {
  const host = location.hostname.toLowerCase();
  if (!INTENT_HOSTS_CHECK(host)) {
    return { ok: false, pageKind: 'UNKNOWN', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: 'WRONG_HOST' };
  }
  const body = document.body?.innerText?.toLocaleLowerCase() ?? '';
  if (location.pathname.startsWith('/i/flow/login') || body.includes('log in to x') || body.includes('تسجيل الدخول')) {
    return { ok: false, pageKind: 'LOGIN', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: 'NOT_LOGGED_IN' };
  }
  if (body.includes('captcha') || body.includes('challenge')) {
    return { ok: false, pageKind: 'CHALLENGE', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: 'CAPTCHA_OR_SECURITY_CHALLENGE' };
  }
  if (isDailyPostLimitMessage(body)) {
    return { ok: false, pageKind: 'X', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: 'X_DAILY_POST_LIMIT_REACHED', dailyPostLimitReached: true };
  }
  const composer = findFirst(composerSelectors);
  const postButton = findPostButton();
  const contentPresent = composer ? readText(composer).length > 0 : false;
  const postButtonEnabled = Boolean(postButton && isEnabledControl(postButton));
  const ok = Boolean(composer && contentPresent && postButton && postButtonEnabled);
  return { ok, pageKind: 'X', composerFound: Boolean(composer), contentPresent, postButtonFound: Boolean(postButton), postButtonEnabled, reason: ok ? undefined : 'PUBLISH_CONTROLS_NOT_READY', dailyPostLimitReached: false };
}

function INTENT_HOSTS_CHECK(host: string): boolean {
  return ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(host);
}

export { dailyPostLimitPattern };

export function getPublishedPostUrl(): string | undefined {
  const statusLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
    .map((anchor) => anchor.href)
    .filter((href) => /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(href));
  const current = location.href.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i)?.[0];
  return statusLinks.at(-1) ?? current;
}

export function publish(): ContentInspection {
  const state = inspect();
  if (!state.ok) return state;
  const button = findPostButton();
  if (!button) return { ...state, ok: false, postButtonFound: false, reason: 'POST_BUTTON_NOT_FOUND' };
  button.click();
  return { ...state, ok: true };
}
