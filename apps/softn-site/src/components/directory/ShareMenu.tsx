import React, { useRef, useState } from 'react';
import { SHARE_TARGETS, canSystemShare, copyText, systemShare } from '../../lib/share';
import { Popover } from './Controls';

export function ShareMenu({ url, title, text, className = '' }: { url: string; title: string; text: string; className?: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  /** How the last "Copy link" went; a copy the browser refused says so rather than closing as if it had worked. */
  const [copied, setCopied] = useState<'no' | 'yes' | 'refused'>('no');
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  const absolute = typeof window !== 'undefined' ? new URL(url, window.location.origin).href : url;

  const onShare = async () => {
    // A second press closes the menu. The popover leaves a press on this
    // button to this handler rather than closing on its mousedown, which
    // used to close the menu only for this click to open it again.
    if (open) {
      setOpen(false);
      return;
    }
    // A phone's own share sheet reaches every app the person has; the menu
    // is for the browsers that lack one. Closing the sheet is a choice not to
    // share, not a reason to offer the menu instead.
    if (canSystemShare() && (await systemShare(absolute, title, text)) !== 'failed') return;
    setOpen(true);
  };

  // Closing from inside takes the pressed control out of the page with the
  // menu, so focus goes back to the button that opened it instead of nowhere.
  const closeFromInside = () => {
    const inside = Boolean(menu.current?.querySelector('.popover')?.contains(document.activeElement));
    setOpen(false);
    if (inside) button.current?.focus();
  };

  return (
    <span className={`share ${className}`} ref={menu}>
      <button type="button" className="cta" onClick={onShare} aria-expanded={open} ref={button}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
        </svg>
        Share
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Share this app" opener={button}>
        <button
          type="button"
          className="popover-item"
          onClick={async () => {
            setCopied((await copyText(absolute)) ? 'yes' : 'refused');
            setTimeout(() => {
              setCopied('no');
              closeFromInside();
            }, 900);
          }}
        >
          {copied === 'yes' ? 'Copied' : copied === 'refused' ? 'Could not copy' : 'Copy link'}
        </button>
        <div className="popover-sep" />
        {SHARE_TARGETS.map((t) => (
          <a key={t.id} className="popover-item" href={t.href(absolute, title)} target="_blank" rel="noreferrer noopener" onClick={closeFromInside}>
            {t.name}
          </a>
        ))}
      </Popover>
    </span>
  );
}
