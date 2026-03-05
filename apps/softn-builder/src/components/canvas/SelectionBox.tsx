/**
 * SelectionBox - Selection overlay with resize handles
 */

import React from 'react';
import type { CanvasElement } from '../../types/builder';

interface Props {
  element: CanvasElement;
}

const styles: Record<string, React.CSSProperties> = {
  box: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    border: '2px solid #3b82f6',
    borderRadius: 4,
    pointerEvents: 'none' as const,
  },
  handle: {
    position: 'absolute' as const,
    width: 8,
    height: 8,
    background: '#fff',
    border: '2px solid #3b82f6',
    borderRadius: 2,
    pointerEvents: 'auto' as const,
    cursor: 'pointer',
  },
  handleTopLeft: {
    top: -4,
    left: -4,
    cursor: 'nwse-resize',
  },
  handleTopRight: {
    top: -4,
    right: -4,
    cursor: 'nesw-resize',
  },
  handleBottomLeft: {
    bottom: -4,
    left: -4,
    cursor: 'nesw-resize',
  },
  handleBottomRight: {
    bottom: -4,
    right: -4,
    cursor: 'nwse-resize',
  },
};

export function SelectionBox({ element: _element }: Props) {
  // Resize handles are for future implementation
  // For now, just show the selection border

  return (
    <div style={styles.box}>
      <div style={{ ...styles.handle, ...styles.handleTopLeft }} />
      <div style={{ ...styles.handle, ...styles.handleTopRight }} />
      <div style={{ ...styles.handle, ...styles.handleBottomLeft }} />
      <div style={{ ...styles.handle, ...styles.handleBottomRight }} />
    </div>
  );
}
