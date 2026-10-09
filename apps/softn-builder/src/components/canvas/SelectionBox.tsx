/**
 * SelectionBox - the outline of a selected element.
 *
 * It used to draw four squares at the corners with resize cursors, kept
 * "for future implementation": they did nothing, said the element could be
 * resized by dragging, and took the press, so an element could not be
 * picked up by a corner. An element's size is its properties.
 */

import React from 'react';

const outline: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  borderWidth: 2,
  borderStyle: 'solid',
  borderColor: 'var(--coral)',
  borderRadius: 4,
  pointerEvents: 'none',
};

export function SelectionBox() {
  return <div style={outline} data-selection-outline="true" />;
}
