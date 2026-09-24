/**
 * Pure X composer/publish-control recognition rules.
 *
 * Extracted from the content-script adapter so the Local Runner (Playwright)
 * reuses EXACTLY the same selector and label logic without importing chrome.*
 * or touching DOM globals at module import time. The Local Runner package
 * keeps a mirrored copy at local-runner/src/x-selectors.ts; a contract test
 * asserts both copies stay in sync.
 */

export const composerSelectors: readonly string[] = [
  '[data-testid="tweetTextarea_0"]',
  '[contenteditable="true"][role="textbox"]',
  'div[role="textbox"][contenteditable="true"]',
  '[data-testid="tweetTextarea_0"] [contenteditable="true"]',
  'textarea[aria-label*="Post"]',
  'textarea[aria-label*="Tweet"]',
  'textarea[aria-label*="نص المنشور"]',
  'textarea[aria-label*="منشور"]',
  'textarea[placeholder*="Post"]',
  'textarea[placeholder*="Tweet"]',
  'textarea[placeholder*="منشور"]'
];

export const postButtonSelectors: readonly string[] = [
  '[data-testid="tweetButtonInline"]',
  '[data-testid="tweetButton"]',
  'button[data-testid*="tweetButton"]',
  'button[aria-label="Post"]',
  'button[aria-label="Tweet"]',
  'button[aria-label="نشر"]',
  'button[aria-label="غرد"]'
];

export const publishTestIdPattern = /(?:tweet|post|publish).*button|button.*(?:tweet|post|publish)/iu;
export const excludedLabelPattern = /(?:إضافة|الكل|رد|reply|add|cancel|إلغاء)/iu;
export const publishLabelPattern = /^(?:نشر|نشر\s+المنشور|إرسال|post|tweet|publish|send)$/iu;
export const dailyPostLimitPattern = /(?:لقد\s+وصلت\s+إلى\s+الحد\s+الأقصى\s+لعدد\s+المنشورات\s+اليومية|الحد\s+الأقصى\s+لعدد\s+المنشورات\s+اليومية|you(?:'|’)?ve\s+reached\s+(?:the\s+)?daily\s+(?:post|posts?)\s+limit|daily\s+post(?:ing)?\s+limit|subscribe\s+to\s+premium.*limit)/iu;

/** Profile link selector used to detect the signed-in account. */
export const accountLinkSelectors: readonly string[] = [
  'a[data-testid="AppTabBar_Profile_Link"]',
  'a[href^="/"][data-testid="AppTabBar_Profile_Link"]'
];

/** Toast/confirmation selectors used as secondary publish evidence. */
export const confirmationToastSelectors: readonly string[] = [
  '[data-testid="toast"]',
  'div[role="status"][aria-live="polite"]'
];

export function normalizeControlLabel(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/gu, '')
    .replace(/\u0640/gu, '')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase();
}

export function isPublishButtonLabel(value: string): boolean {
  const label = normalizeControlLabel(value);
  return Boolean(label) && !excludedLabelPattern.test(label) && publishLabelPattern.test(label);
}

export function isPublishTestId(value: string): boolean {
  return publishTestIdPattern.test(value);
}

export function isExcludedControlLabel(value: string): boolean {
  return excludedLabelPattern.test(normalizeControlLabel(value));
}

export function isDailyPostLimitMessage(value: string): boolean {
  return dailyPostLimitPattern.test(value.normalize('NFKC'));
}

/**
 * Normalizes composer text for content verification. X renders zero-width
 * joiners around emoji and may reflow whitespace; the comparison therefore
 * ignores zero-width characters and collapses whitespace while keeping Arabic
 * letters, emoji, and newlines semantically intact.
 */
export function normalizeComposerText(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ ?\n ?/gu, '\n')
    .trim();
}

/** Detects the account handle from a profile link href like "/handle". */
export function accountFromProfileHref(href: string): string | undefined {
  const match = href.match(/^\/(?:i\/)?([A-Za-z0-9_]{1,15})(?:\/|$|\?)/);
  const handle = match?.[1];
  if (!handle || ['home', 'i', 'explore', 'notifications', 'messages', 'bookmarks', 'settings', 'search', 'compose', 'intent'].includes(handle.toLowerCase())) return undefined;
  return handle.toLowerCase();
}
