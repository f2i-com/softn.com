import React, { useEffect, useRef, useState } from 'react';

/**
 * Fades a section in the first time it comes into view, and then stops
 * observing it — a section that has arrived does not need to animate again
 * when you scroll back up.
 */
export function Reveal({
  children,
  className = '',
  delay = 0,
  as: Tag = 'div',
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  as?: 'div' | 'section' | 'header' | 'footer';
} & React.HTMLAttributes<HTMLElement>): React.ReactElement {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Without IntersectionObserver the content still has to be readable, so it
    // starts visible rather than starting hidden and waiting for an event that
    // will never fire.
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -12% 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return React.createElement(
    Tag,
    {
      ...rest,
      ref,
      className: `reveal ${className}`.trim(),
      'data-shown': shown,
      style: { transitionDelay: delay ? `${delay}ms` : undefined, ...rest.style },
    },
    children
  );
}
