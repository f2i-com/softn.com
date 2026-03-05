/**
 * DragLayer - Shows what component is being dragged
 */

import React, { useEffect, useState } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';

const style: React.CSSProperties = {
  position: 'fixed',
  padding: '6px 12px',
  background: '#1e293b',
  color: '#fff',
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 500,
  boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
  pointerEvents: 'none',
  zIndex: 10000,
  opacity: 0.9,
};

export function DragLayer() {
  const draggedType = useCanvasStore((state) => state.draggedType);
  const draggedElementId = useCanvasStore((state) => state.draggedElementId);
  const elements = useCanvasStore((state) => state.elements);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const isDragging = !!(draggedType || draggedElementId);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      setPosition({ x: e.clientX + 15, y: e.clientY + 15 });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [isDragging]);

  if (!isDragging) return null;

  // Get the label
  let label = draggedType || '';
  if (draggedElementId) {
    const element = elements.get(draggedElementId);
    if (element) {
      label = element.componentType;
    }
  }

  if (!label) return null;

  const prefix = draggedType ? '+ ' : draggedElementId ? '\u2195 ' : '';

  return (
    <div
      style={{
        ...style,
        left: position.x,
        top: position.y,
      }}
    >
      {prefix}{label}
    </div>
  );
}
