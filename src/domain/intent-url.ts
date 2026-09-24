import { normalizeComposerText } from './x-selectors.ts';

/**
 * X intent URL helpers (pure).
 *
 * Queue items are intent links such as
 * https://x.com/intent/post?text=Hello%20world
 * The `text` parameter carries the intended composer content (percent-encoded,
 * UTF-8). `publishContentFromIntentUrl` extracts and normalizes it so both the
 * content script flow and the Local Runner can verify that the visible
 * composer actually holds the content of THIS item (Arabic, links, newlines,
 * and emoji included) before publishing.
 */

const INTENT_HOSTS = new Set(['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com']);

export function isXIntentUrl(rawUrl: string, hosts: readonly string[] = [...INTENT_HOSTS]): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return hosts.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Extracts the intended composer content from an intent URL's text parameter. */
export function publishContentFromIntentUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    if (!isXIntentUrl(rawUrl)) return undefined;
    const text = parsed.searchParams.get('text');
    if (text === null) return undefined;
    return normalizeComposerText(text);
  } catch {
    return undefined;
  }
}

/** Stable content hash input used to bind operation ids to intended content. */
export function contentHashInput(targetUrl: string, workspaceId: string, profileId: string): string {
  const content = publishContentFromIntentUrl(targetUrl) ?? '';
  return `${workspaceId}::${profileId}::${content}::${targetUrl}`;
}
