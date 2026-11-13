/**
 * Page content pinned to a place in the scene.
 *
 * A name over a figure, a health bar, a card beside the part that was
 * clicked: the page around a scene is ordinary markup, and nothing joined
 * the two. A `<SceneAnchor>` inside a `<Scene3D>` is an ordinary element
 * laid over the canvas, and the scene's render loop moves it: each frame it
 * works out where the anchor's object (or its fixed position) is drawn and
 * writes one CSS transform into the element. Nothing is rendered again for
 * that: the page is not redrawn per frame, and an anchor that has not moved
 * is not written at all.
 *
 * An anchor is hidden while there is nowhere to put it: its object is not in
 * the scene, the place is behind the camera or beyond what the camera
 * draws, or the content would lie wholly outside the scene's box.
 */

import React from 'react';
import * as THREE from 'three';

export type AnchorPlace = 'center' | 'above' | 'below' | 'left' | 'right';

/** One anchor, as the scene's render loop sees it. */
export interface AnchorRecord {
  /** The element moved. Null until it is on the page. */
  el: HTMLElement | null;
  object: string | undefined;
  position: { x: number; y: number; z: number } | undefined;
  offset: { x?: number; y?: number; z?: number } | undefined;
  place: AnchorPlace;
  /** How big the content is, measured when it changes size and never per frame. */
  width: number;
  height: number;
  /** What was last written into the element: null before anything was. */
  shown: boolean | null;
  x: number;
  y: number;
}

/** What a `<Scene3D>` offers the anchors inside it. */
export interface AnchorHost {
  /** Take an anchor into the scene's render loop; the answer takes it out again. */
  add(record: AnchorRecord): () => void;
}

export const SceneAnchorContext = React.createContext<AnchorHost | null>(null);

/** Which point of the content sits on the pin, as the second half of the transform. */
const SHIFT: Record<AnchorPlace, string> = {
  center: 'translate(-50%, -50%)',
  above: 'translate(-50%, -100%)',
  below: 'translate(-50%, 0)',
  left: 'translate(-100%, -50%)',
  right: 'translate(0, -50%)',
};

const point = new THREE.Vector3();
const finite = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function anchorPlaceOf(place: unknown): AnchorPlace {
  return place === 'above' || place === 'below' || place === 'left' || place === 'right' ? place : 'center';
}

export class AnchorSet implements AnchorHost {
  private readonly records: AnchorRecord[] = [];

  get size(): number {
    return this.records.length;
  }

  add = (record: AnchorRecord): (() => void) => {
    this.records.push(record);
    return () => {
      const index = this.records.indexOf(record);
      if (index !== -1) this.records.splice(index, 1);
    };
  };

  /**
   * One frame: put each anchor where its place is drawn by `cam` in a view
   * `width` by `height` CSS pixels. `find` answers the node of an object.
   */
  project(
    cam: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    width: number,
    height: number,
    find: (id: string) => THREE.Object3D | null
  ): void {
    const records = this.records;
    if (records.length === 0) return;
    // The camera's matrices as this frame will draw with them.
    cam.updateMatrixWorld();
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const el = record.el;
      if (!el) continue;
      let shown = false;
      if (typeof record.object === 'string' && record.object !== '') {
        const node = find(record.object);
        if (node) {
          // Where the object is drawn now: part of the way, if it is being eased.
          node.updateWorldMatrix(true, false);
          point.setFromMatrixPosition(node.matrixWorld);
          shown = true;
        }
      } else if (record.position) {
        point.set(finite(record.position.x), finite(record.position.y), finite(record.position.z));
        shown = true;
      }
      let x = 0;
      let y = 0;
      if (shown) {
        const offset = record.offset;
        if (offset) {
          point.x += finite(offset.x);
          point.y += finite(offset.y);
          point.z += finite(offset.z);
        }
        point.applyMatrix4(cam.matrixWorldInverse);
        // A camera looks down its own -z: at or behind it is not in the picture.
        if (!(point.z < -cam.near)) {
          shown = false;
        } else {
          point.applyMatrix4(cam.projectionMatrix);
          x = (point.x + 1) * 0.5 * width;
          y = (1 - point.y) * 0.5 * height;
          shown = point.z <= 1 && Number.isFinite(x) && Number.isFinite(y) && this.inView(record, x, y, width, height);
        }
      }
      if (!shown) {
        if (record.shown !== false) {
          record.shown = false;
          el.style.visibility = 'hidden';
        }
        continue;
      }
      x = Math.round(x * 10) / 10;
      y = Math.round(y * 10) / 10;
      if (record.shown !== true || record.x !== x || record.y !== y) {
        record.x = x;
        record.y = y;
        el.style.transform = `translate3d(${x}px, ${y}px, 0) ${SHIFT[record.place]}`;
      }
      if (record.shown !== true) {
        record.shown = true;
        el.style.visibility = 'visible';
      }
    }
  }

  /** Whether any of the content, pinned at (x, y), lies within the view. */
  private inView(record: AnchorRecord, x: number, y: number, width: number, height: number): boolean {
    const w = record.width;
    const h = record.height;
    const place = record.place;
    const left = place === 'left' ? x - w : place === 'right' ? x : x - w / 2;
    const top = place === 'above' ? y - h : place === 'below' ? y : y - h / 2;
    return left <= width && left + w >= 0 && top <= height && top + h >= 0;
  }
}
