import React, { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { anchorPlaceOf, SceneAnchorContext, type AnchorRecord } from './anchors';

// Before the browser paints, where there is one: an anchor is hidden, and in
// the scene's hands, before it could be seen in the corner it starts in.
const useBeforePaint = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface SceneAnchorProps {
  /**
   * The `id` of the object this content is pinned to: one of the scene's
   * `objects` or `staticObjects`, or a child of a group. The content goes
   * where the object is drawn, frame by frame, a model and an object that
   * `transition` is easing included. While no object has that id, the
   * content is hidden.
   */
  object?: string;
  /** A fixed place in the scene to pin the content to, `{ x, y, z }`, used when `object` is not given. */
  position?: { x: number; y: number; z: number };
  /**
   * How far the pin is from the object's own position (or from `position`),
   * `{ x, y, z }` in scene units along the scene's axes: `{ y: 1 }` is one
   * unit above, however the object is turned.
   */
  offset?: { x?: number; y?: number; z?: number };
  /**
   * Where the content sits about the pin: 'center' (its middle on the pin,
   * the default), 'above' (a name over a head), 'below', 'left' or 'right'
   * (a card beside a part).
   */
  place?: 'center' | 'above' | 'below' | 'left' | 'right';
  /**
   * Let the pointer through to the scene: for a label that is only read, so
   * a click or an orbit that starts on it still reaches what is behind.
   * Without it the content takes the pointer, as a button in it must.
   */
  clickThrough?: boolean;
  /** The content: ordinary markup, a label, a health bar, a card with buttons. */
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

let warnedOutside = false;

/**
 * Page content pinned to a place in a 3D scene: written inside `<Scene3D>`,
 * it holds ordinary markup and is kept over the object it names (or over a
 * fixed `position`) as the object and the camera move. The scene moves it
 * with one CSS transform a frame; the page is not redrawn for it. It is
 * hidden while its place is behind the camera or outside the view, and while
 * its object is not in the scene. Outside a `<Scene3D>` it shows nothing.
 */
export function SceneAnchor({
  object,
  position,
  offset,
  place = 'center',
  clickThrough = false,
  children,
  className,
  style,
}: SceneAnchorProps) {
  const host = useContext(SceneAnchorContext);
  const ref = useRef<HTMLDivElement>(null);
  const recordRef = useRef<AnchorRecord | null>(null);
  if (!recordRef.current) {
    recordRef.current = {
      el: null,
      object: undefined,
      position: undefined,
      offset: undefined,
      place: 'center',
      width: 0,
      height: 0,
      shown: null,
      x: 0,
      y: 0,
    };
  }

  // What it is pinned to, as this render gives it: read by the scene's next
  // frame. Nothing is registered again for a change of object or offset.
  useBeforePaint(() => {
    const record = recordRef.current as AnchorRecord;
    const placed = anchorPlaceOf(place);
    // The same pin with the content sitting another way about it is another transform.
    if (record.place !== placed) record.shown = null;
    record.object = typeof object === 'string' ? object : undefined;
    record.position = position;
    record.offset = offset;
    record.place = placed;
  });

  useBeforePaint(() => {
    const el = ref.current;
    const record = recordRef.current as AnchorRecord;
    if (!host || !el) return undefined;
    record.el = el;
    record.shown = null;
    // Hidden until the scene has put it somewhere: it is not to flash in the corner first.
    el.style.visibility = 'hidden';
    const remove = host.add(record);
    // Its size, for telling when it has left the view: measured when it
    // changes, never in the render loop.
    const measure = () => {
      record.width = el.offsetWidth;
      record.height = el.offsetHeight;
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      remove();
      record.el = null;
    };
  }, [host]);

  if (!host) {
    if (!warnedOutside) {
      warnedOutside = true;
      console.warn('[SceneAnchor] A <SceneAnchor> shows nothing outside a <Scene3D>: write it inside the scene it belongs to.');
    }
    return null;
  }

  return (
    <div
      ref={ref}
      className={className}
      data-scene-anchor=""
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        pointerEvents: clickThrough ? 'none' : 'auto',
        willChange: 'transform',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
