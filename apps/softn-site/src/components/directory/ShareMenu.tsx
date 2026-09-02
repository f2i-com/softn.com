import React, { useState } from 'react';
import { SHARE_TARGETS, canSystemShare, copyText, systemShare } from '../../lib/share';
import { Popover } from './Controls';

export function ShareMenu({ url, title, text, className = '' }: { url: string; title: string; text: string; className?: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const absolute = typeof window !== 'undefined' ? new URL(url, window.location.origin).href : url;

  const onShare = async () => {
    // A phone's own share sheet reaches every app the person has; the menu
    // is for the browsers that lack one.
    if (canSystemShare() && (await systemShare(absolute, title, text))) return;
    setOpen((o) => !o);
  };

  return (
    <span className={`share ${className}`}>
      <button type="button" className="cta" onClick={onShare} aria-haspopup="menu" aria-expanded={open}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
        </svg>
        Share
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <button
          type="button"
          className="popover-item"
          onClick={async () => {
            setCopied(await copyText(absolute));
            setTimeout(() => {
              setCopied(false);
              setOpen(false);
            }, 900);
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <div className="popover-sep" />
        {SHARE_TARGETS.map((t) => (
          <a key={t.id} className="popover-item" href={t.href(absolute, title)} target="_blank" rel="noreferrer noopener" onClick={() => setOpen(false)}>
            {t.name}
          </a>
        ))}
      </Popover>
    </span>
  );
}
