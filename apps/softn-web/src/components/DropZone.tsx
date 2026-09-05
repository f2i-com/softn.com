import React, { useCallback, useRef, useState } from 'react';

interface DropZoneProps {
  onFile: (data: Uint8Array, fileName: string) => void;
  children: React.ReactNode;
}

const dropZoneStyles = `
  @keyframes softn-drop-fade-in {
    from { opacity: 0; backdrop-filter: blur(0px); }
    to { opacity: 1; backdrop-filter: blur(12px); }
  }
  @keyframes softn-drop-card-in {
    from { opacity: 0; transform: scale(0.92) translateY(8px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }
  @keyframes softn-drop-border-pulse {
    0%, 100% { border-color: var(--mint-edge); box-shadow: 0 0 0 0 rgba(99, 102, 241, 0); }
    50% { border-color: var(--mint-edge); box-shadow: 0 0 40px -8px var(--mint-edge); }
  }
  @keyframes softn-drop-icon-float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4px); }
  }
  .softn-drop-overlay {
    position: fixed;
    inset: 0;
    background: var(--nav-bg);
    backdrop-filter: blur(12px) saturate(0.8);
    -webkit-backdrop-filter: blur(12px) saturate(0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    pointer-events: none;
    animation: softn-drop-fade-in 250ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .softn-drop-card {
    padding: 2.5rem 3.5rem;
    border-radius: 20px;
    border: 2px dashed var(--mint-edge);
    background: var(--ink-2);
    text-align: center;
    animation:
      softn-drop-card-in 300ms cubic-bezier(0.16, 1, 0.3, 1) 50ms both,
      softn-drop-border-pulse 2s ease-in-out infinite 350ms;
    box-shadow: 0 24px 80px var(--shadow);
  }
  .softn-drop-icon {
    width: 56px;
    height: 56px;
    border-radius: 16px;
    background: linear-gradient(135deg, var(--mint-edge), var(--mint-edge));
    border: 1px solid var(--mint-edge);
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 1.25rem;
    animation: softn-drop-icon-float 2s ease-in-out infinite 400ms;
  }
`;

/**
 * Full-page drag-and-drop overlay for .softn files.
 * Wraps its children and shows a visual overlay when dragging.
 */
export function DropZone({ onFile, children }: DropZoneProps): React.ReactElement {
  const [isDragOver, setIsDragOver] = useState(false);
  // dragenter and dragleave fire as a pair for every element the pointer crosses,
  // so moving over a child fires leave-then-enter and a naive boolean flickers.
  // The previous guard — only clear when target === currentTarget — traded that
  // flicker for a worse bug: dragging out of the window last fires leave on
  // whatever child the pointer was over, so the condition is false, and the
  // full-page overlay stays up over the whole app until something else clears
  // it. Counting enters against leaves is what actually tracks "inside".
  const depth = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    depth.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setIsDragOver(false);

      const files = Array.from(e.dataTransfer.files);
      const softnFile = files.find((f) => f.name.endsWith('.softn'));

      if (softnFile) {
        try {
          const buffer = await softnFile.arrayBuffer();
          onFile(new Uint8Array(buffer), softnFile.name);
        } catch (err) {
          console.error('[SoftN Web] Failed to read dropped file:', err);
        }
      }
    },
    [onFile]
  );

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ position: 'relative', height: '100%' }}
    >
      <style dangerouslySetInnerHTML={{ __html: dropZoneStyles }} />
      {children}
      {isDragOver && (
        <div className="softn-drop-overlay">
          <div className="softn-drop-card">
            <div className="softn-drop-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--mint)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </div>
            <div style={{
              fontSize: '1.125rem',
              fontWeight: 600,
              color: 'var(--paper)',
              marginBottom: '0.5rem',
              letterSpacing: '-0.02em',
            }}>
              Drop your .softn file
            </div>
            <div style={{
              color: 'var(--dim)',
              fontSize: '0.8125rem',
              letterSpacing: '-0.01em',
            }}>
              Release to open the application
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
