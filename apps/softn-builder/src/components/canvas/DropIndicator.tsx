/**
 * DropIndicator - Visual indicator for drop zones
 */

import React from 'react';

const styles: Record<string, React.CSSProperties> = {
  indicator: {
    position: 'absolute' as const,
    left: 4,
    right: 4,
    bottom: 4,
    height: 3,
    background: '#c2410c',
    borderRadius: 2,
    opacity: 0.8,
    pointerEvents: 'none' as const,
  },
};

export function DropIndicator() {
  return <div style={styles.indicator} />;
}
