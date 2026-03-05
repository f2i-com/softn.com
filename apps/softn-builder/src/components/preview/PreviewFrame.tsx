/**
 * PreviewFrame - Iframe sandbox for isolated preview
 */

import React, { useRef, useEffect, useMemo } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useProjectStore } from '../../stores/projectStore';
import { generateSource } from '../../utils/sourceGenerator';

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f1f5f9',
    padding: 24,
  },
  frame: {
    width: '100%',
    height: '100%',
    border: 'none',
    background: '#fff',
    borderRadius: 8,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  },
};

interface PreviewFrameProps {
  width?: number;
  height?: number;
}

export function PreviewFrame({ width, height }: PreviewFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const { elements, rootId } = useCanvasStore();
  const { logicSource, collections, themeMode } = useProjectStore();

  const source = useMemo(() => {
    return generateSource(elements, rootId, logicSource, collections);
  }, [elements, rootId, logicSource, collections]);

  // Generate HTML document for iframe
  const htmlContent = useMemo(() => {
    return `
      <!DOCTYPE html>
      <html lang="en" data-theme="${themeMode}">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Preview</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.5;
            color: #1e293b;
            background: #fff;
          }
          .preview-container {
            padding: 16px;
          }
          .preview-placeholder {
            padding: 24px;
            text-align: center;
            color: #94a3b8;
            font-size: 14px;
          }
          pre {
            background: #f8fafc;
            padding: 16px;
            border-radius: 8px;
            overflow: auto;
            font-size: 12px;
            font-family: monospace;
            white-space: pre-wrap;
          }
        </style>
      </head>
      <body>
        <div class="preview-container">
          <div class="preview-placeholder">
            <p>Preview mode</p>
            <pre>${source.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
          </div>
        </div>
      </body>
      </html>
    `;
  }, [source, themeMode]);

  useEffect(() => {
    if (iframeRef.current) {
      const doc = iframeRef.current.contentDocument;
      if (doc) {
        doc.open();
        doc.write(htmlContent);
        doc.close();
      }
    }
  }, [htmlContent]);

  const frameStyle: React.CSSProperties = {
    ...styles.frame,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };

  return (
    <div style={styles.container}>
      <iframe ref={iframeRef} style={frameStyle} title="Preview" sandbox="allow-scripts" />
    </div>
  );
}
