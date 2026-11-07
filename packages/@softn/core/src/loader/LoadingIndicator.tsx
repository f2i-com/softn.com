import React from 'react';

/**
 * What shows while an app opens: a wheel and no words, centred in the space it is given. A screen
 * reader hears its label. A host colours it through CSS variables on any ancestor:
 * `--softn-loading-color` (the wheel; currentColor by default) and `--softn-loading-background`
 * (behind it; transparent by default). Someone who asked for less motion sees it pulse slowly
 * rather than spin.
 */
const CSS = `
.softn-loading{display:flex;align-items:center;justify-content:center;min-height:100%;height:100%;box-sizing:border-box;background:var(--softn-loading-background,transparent)}
.softn-loading-wheel{width:40px;height:40px;border-radius:50%;border:3.5px solid var(--softn-loading-color,currentColor);border-right-color:transparent;opacity:.85;animation:softn-loading-spin .8s linear infinite}
@keyframes softn-loading-spin{to{transform:rotate(360deg)}}
@keyframes softn-loading-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.softn-loading-wheel{animation:softn-loading-pulse 2s ease-in-out infinite}}
`;

export function LoadingIndicator({ label = 'Loading', className }: { label?: string; className?: string }): React.ReactElement {
  return (
    <div className={className ? `softn-loading ${className}` : 'softn-loading'} role="status" aria-live="polite" aria-label={label}>
      <style>{CSS}</style>
      <span className="softn-loading-wheel" aria-hidden="true" />
    </div>
  );
}
