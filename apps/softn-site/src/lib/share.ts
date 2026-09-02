/**
 * Where a link to an app can be sent. The system share sheet when the
 * browser has one — every phone does — and the networks' own share URLs
 * otherwise, which need no SDK and no script from anyone.
 */
export interface ShareTarget {
  id: string;
  name: string;
  href: (url: string, title: string) => string;
}

export const SHARE_TARGETS: ShareTarget[] = [
  { id: 'x', name: 'X', href: (u, t) => `https://twitter.com/intent/tweet?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}` },
  { id: 'facebook', name: 'Facebook', href: (u) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}` },
  { id: 'reddit', name: 'Reddit', href: (u, t) => `https://www.reddit.com/submit?url=${encodeURIComponent(u)}&title=${encodeURIComponent(t)}` },
  { id: 'linkedin', name: 'LinkedIn', href: (u) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(u)}` },
  { id: 'bluesky', name: 'Bluesky', href: (u, t) => `https://bsky.app/intent/compose?text=${encodeURIComponent(`${t} ${u}`)}` },
  { id: 'mastodon', name: 'Mastodon', href: (u, t) => `https://mastodonshare.com/?text=${encodeURIComponent(`${t} ${u}`)}` },
  { id: 'whatsapp', name: 'WhatsApp', href: (u, t) => `https://wa.me/?text=${encodeURIComponent(`${t} ${u}`)}` },
  { id: 'telegram', name: 'Telegram', href: (u, t) => `https://t.me/share/url?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}` },
  { id: 'email', name: 'Email', href: (u, t) => `mailto:?subject=${encodeURIComponent(t)}&body=${encodeURIComponent(u)}` },
];

export function canSystemShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export async function systemShare(url: string, title: string, text: string): Promise<boolean> {
  if (!canSystemShare()) return false;
  try {
    await navigator.share({ url, title, text });
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
