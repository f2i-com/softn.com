/**
 * PanView Component
 *
 * A window onto content that is bigger than the space available for it: the
 * user can drag it with the mouse, flick it on a touchscreen, spin a wheel or
 * arrow-key around it, and the app can zoom it with `scale`.
 *
 * Panning is deliberately done by moving the scroll position rather than by
 * raising state, because the thing this exists for — a tilemap the size of a
 * game world — is usually being re-rendered by something else already. A drag
 * that re-rendered the tree sixty times a second would fight that. Nothing here
 * calls `setState` while the pointer is down.
 */

import * as React from 'react';

export interface PanViewProps {
  /** Width of the content, in its own unscaled units. */
  contentWidth: number;
  /** Height of the content, in its own unscaled units. */
  contentHeight: number;
  /** Zoom applied to the content. The centre of the view is held still across changes. */
  scale?: number;
  /** Start scrolled to the middle of the content rather than its top-left corner. */
  centered?: boolean;
  /** Change this to scroll back to the middle — for a "recentre" control. */
  recenterKey?: number | string;
  /** Set false for content that needs its own drag behaviour (selection, drawing). */
  draggable?: boolean;
  /** Painted behind the content, and visible in the margin when it is smaller than the view. */
  background?: string;
  /** Accessible name for the scrollable region. */
  label?: string;
  /** Additional inline styles for the viewport. */
  style?: React.CSSProperties;
  /** CSS class for the viewport — use it to style the scrollbars. */
  className?: string;
  children?: React.ReactNode;
}

export function PanView({
  contentWidth,
  contentHeight,
  scale = 1,
  centered = true,
  recenterKey,
  draggable = true,
  background,
  label,
  style,
  className,
  children,
}: PanViewProps): React.ReactElement {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  // A host whose content size is computed — from a script that has not loaded
  // yet, say — hands over NaN on the first render. Left alone that reaches the
  // DOM as `width: NaN`, and worse, the centring below "succeeds" against it
  // and never runs again, so the view opens jammed in a corner.
  const safeW = Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 0;
  const safeH = Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 0;
  const scaledW = safeW * safeScale;
  const scaledH = safeH * safeScale;

  const viewportRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const prevScaleRef = React.useRef(safeScale);
  const centredRef = React.useRef(false);
  const placedRef = React.useRef<{ left: number; top: number } | null>(null);

  // Put the middle of the content in the middle of the view, once.
  //
  // The wait for a real box on both sides is the whole subtlety here: a tab
  // that mounts hidden lays out at 0x0, and content whose size is still being
  // computed measures 0 too. Centring against either and then calling itself
  // done leaves the view jammed in a corner with the far side unreachable
  // until the user drags. So it refuses to act on an empty box, and gets
  // another chance on any later render and from the resize observer below.
  const centre = React.useCallback(() => {
    if (!centered || centredRef.current) return;
    const el = viewportRef.current;
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
    if (scaledW === 0 || scaledH === 0) return;
    el.scrollLeft = (scaledW - el.clientWidth) / 2;
    el.scrollTop = (scaledH - el.clientHeight) / 2;
    // Remembered so a later resize can tell "still where we put it" from
    // "the user has looked somewhere else since".
    placedRef.current = { left: el.scrollLeft, top: el.scrollTop };
    centredRef.current = true;
    // A view that was just centred has nothing to preserve across a zoom, and
    // the two arriving on the same render is the normal case for a host whose
    // scale and content size both come from a script. Left to run, the zoom
    // adjustment took the freshly centred position as an old scroll offset,
    // multiplied it, and slid the view to its far edge.
    prevScaleRef.current = safeScale;
  }, [centered, scaledW, scaledH, safeScale]);

  React.useLayoutEffect(centre);

  // A "recentre" control: arming the flag and centring again is all it takes,
  // and running on mount too is harmless because that is what mount does anyway.
  React.useLayoutEffect(() => {
    centredRef.current = false;
    centre();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenterKey]);

  // Resizing the panel around an untouched view re-centres it. Once the user
  // has panned anywhere the view is theirs, and nothing moves it but them.
  React.useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const placed = placedRef.current;
      const untouched = !placed || (el.scrollLeft === placed.left && el.scrollTop === placed.top);
      if (untouched) centredRef.current = false;
      centre();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [centre]);

  // Zooming keeps whatever is in the middle of the view in the middle of the
  // view. Without this, zooming out drags the content away under the cursor.
  React.useLayoutEffect(() => {
    const el = viewportRef.current;
    const prev = prevScaleRef.current;
    prevScaleRef.current = safeScale;
    if (!el || prev === safeScale || !Number.isFinite(prev) || prev <= 0) return;
    const ratio = safeScale / prev;
    el.scrollLeft = (el.scrollLeft + el.clientWidth / 2) * ratio - el.clientWidth / 2;
    el.scrollTop = (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2;
  }, [safeScale]);

  const endDrag = React.useCallback(() => {
    const el = viewportRef.current;
    const drag = dragRef.current;
    dragRef.current = null;
    if (!el) return;
    el.style.cursor = draggable ? 'grab' : '';
    el.style.userSelect = '';
    if (drag && el.hasPointerCapture(drag.id)) el.releasePointerCapture(drag.id);
  }, [draggable]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Touch and pen already pan this element natively; taking the pointer here
    // would replace a good gesture with a worse one.
    if (!draggable || e.pointerType !== 'mouse' || e.button !== 0) return;
    const el = viewportRef.current;
    if (!el) return;
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
    el.style.cursor = 'grabbing';
    el.style.userSelect = 'none';
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    const el = viewportRef.current;
    if (!drag || !el || drag.id !== e.pointerId) return;
    el.scrollLeft = drag.left - (e.clientX - drag.x);
    el.scrollTop = drag.top - (e.clientY - drag.y);
  };

  const viewportStyle: React.CSSProperties = {
    position: 'relative',
    overflow: 'auto',
    background,
    cursor: draggable ? 'grab' : undefined,
    // Keeps a wheel over the map from scrolling the page behind it once the
    // map has reached its own edge.
    overscrollBehavior: 'contain',
    ...style,
  };

  return (
    <div
      ref={viewportRef}
      className={className}
      style={viewportStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {/* Sizer: takes up the scaled footprint so the scrollbars know the extent. */}
      <div style={{ width: scaledW, height: scaledH, position: 'relative' }}>
        {/* World: children position themselves in unscaled content coordinates. */}
        <div
          style={{
            width: safeW,
            height: safeH,
            position: 'absolute',
            top: 0,
            left: 0,
            transform: `scale(${safeScale})`,
            transformOrigin: 'top left',
            imageRendering: 'pixelated',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export default PanView;
