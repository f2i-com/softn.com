import React, { useCallback, useRef } from 'react';
import type { CachedApp } from '../lib/appCache';

const launcherStyles = `
  @keyframes softn-launcher-fade-up {
    from { opacity: 0; transform: translateY(16px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes softn-launcher-scale-in {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }
  @keyframes softn-launcher-float {
    0%, 100% { transform: translate(0, 0); }
    33% { transform: translate(8px, -6px); }
    66% { transform: translate(-4px, 4px); }
  }
  @keyframes softn-launcher-glow {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 0.8; }
  }
  .softn-launcher {
    min-height: 100%;
    background: #0c0c0e;
    padding: 3rem 2.5rem;
    position: relative;
    overflow: hidden;
  }
  .softn-launcher::before {
    content: '';
    position: absolute;
    top: -30%;
    left: -5%;
    width: 50%;
    height: 70%;
    background: radial-gradient(ellipse, rgba(59, 130, 246, 0.07) 0%, transparent 65%);
    pointer-events: none;
    animation: softn-launcher-float 20s ease-in-out infinite;
  }
  .softn-launcher::after {
    content: '';
    position: absolute;
    bottom: -20%;
    right: -10%;
    width: 45%;
    height: 55%;
    background: radial-gradient(ellipse, rgba(59, 130, 246, 0.05) 0%, transparent 65%);
    pointer-events: none;
    animation: softn-launcher-float 25s ease-in-out infinite reverse;
  }
  .softn-launcher-inner {
    max-width: 860px;
    margin: 0 auto;
    position: relative;
    z-index: 1;
  }
  .softn-launcher-header {
    animation: softn-launcher-fade-up 500ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .softn-launcher-section-label {
    animation: softn-launcher-fade-up 400ms cubic-bezier(0.16, 1, 0.3, 1) 150ms both;
  }
  .softn-launcher-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 0.875rem;
  }
  .softn-launcher-card {
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 14px;
    padding: 1.25rem;
    cursor: pointer;
    transition: all 250ms cubic-bezier(0.16, 1, 0.3, 1);
    position: relative;
    animation: softn-launcher-scale-in 400ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .softn-launcher-card:nth-child(1) { animation-delay: 100ms; }
  .softn-launcher-card:nth-child(2) { animation-delay: 160ms; }
  .softn-launcher-card:nth-child(3) { animation-delay: 220ms; }
  .softn-launcher-card:nth-child(4) { animation-delay: 280ms; }
  .softn-launcher-card:nth-child(5) { animation-delay: 340ms; }
  .softn-launcher-card:nth-child(6) { animation-delay: 400ms; }
  .softn-launcher-card:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(59, 130, 246, 0.2);
    transform: translateY(-3px);
    box-shadow:
      0 12px 40px rgba(0, 0, 0, 0.25),
      0 0 0 1px rgba(59, 130, 246, 0.08),
      0 0 30px -10px rgba(59, 130, 246, 0.12);
  }
  .softn-launcher-card:active {
    transform: translateY(-1px) scale(0.99);
  }
  .softn-launcher-btn {
    padding: 0.625rem 1.375rem;
    background: linear-gradient(135deg, #3b82f6, #2563eb);
    color: white;
    border: none;
    border-radius: 10px;
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 220ms cubic-bezier(0.16, 1, 0.3, 1);
    box-shadow: 0 2px 12px rgba(59, 130, 246, 0.25), inset 0 1px 0 rgba(255,255,255,0.12);
    letter-spacing: -0.01em;
    position: relative;
    overflow: hidden;
  }
  .softn-launcher-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 24px rgba(59, 130, 246, 0.35), inset 0 1px 0 rgba(255,255,255,0.12);
  }
  .softn-launcher-btn:active {
    transform: translateY(0) scale(0.98);
  }
  .softn-launcher-remove {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 24px;
    height: 24px;
    background: transparent;
    border: none;
    color: transparent;
    font-size: 0.875rem;
    cursor: pointer;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .softn-launcher-card:hover .softn-launcher-remove {
    color: #6b6b78;
  }
  .softn-launcher-remove:hover {
    color: #ef4444 !important;
    background: rgba(239, 68, 68, 0.1) !important;
  }
  .softn-launcher-empty {
    animation: softn-launcher-fade-up 500ms cubic-bezier(0.16, 1, 0.3, 1) 100ms both;
  }
  .softn-launcher-dnd-hint {}
  @media (max-width: 640px) {
    .softn-launcher { padding: 1.25rem; }
    .softn-launcher-grid { grid-template-columns: 1fr; }
    .softn-launcher-dnd-hint { display: none; }
  }
  @media (min-width: 641px) and (max-width: 768px) {
    .softn-launcher { padding: 1.5rem; }
    .softn-launcher-grid {
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    }
  }
`;

interface LauncherProps {
  apps: CachedApp[];
  onOpenFile: (data: Uint8Array, fileName: string) => void;
  onOpenCached: (app: CachedApp) => void;
  onRemove: (id: string) => void;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

export function Launcher({
  apps,
  onOpenFile,
  onOpenCached,
  onRemove,
}: LauncherProps): React.ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        onOpenFile(new Uint8Array(buffer), file.name);
      } catch (err) {
        console.error('[SoftN] Failed to read file:', err);
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [onOpenFile]
  );

  return (
    <>
    <style dangerouslySetInnerHTML={{ __html: launcherStyles }} />
    <div className="softn-launcher">
      <div className="softn-launcher-inner">
        {/* Brand header */}
        <div className="softn-launcher-header" style={{ marginBottom: '2.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
            <svg width="38" height="38" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ filter: 'drop-shadow(0 4px 12px rgba(59, 130, 246, 0.3))' }}>
              <defs>
                <linearGradient id="launcher-logo" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#60a5fa"/>
                  <stop offset="100%" stopColor="#2563eb"/>
                </linearGradient>
              </defs>
              <rect width="32" height="32" rx="8" fill="url(#launcher-logo)"/>
              <path d="M10.5 9C20 9 21 16 16 16S12 23 21.5 23" fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round"/>
              <circle cx="10.5" cy="9" r="2.5" fill="#fff"/>
              <circle cx="21.5" cy="23" r="2.5" fill="#fff"/>
            </svg>
            <div>
              <div style={{
                fontSize: '1.1875rem',
                fontWeight: 700,
                color: '#ececf0',
                letterSpacing: '-0.025em',
              }}>SoftN</div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".softn"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
            <button
              className="softn-launcher-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              Open .softn File
            </button>
            <span className="softn-launcher-dnd-hint" style={{
              color: '#4a4a56',
              fontSize: '0.8125rem',
              letterSpacing: '-0.01em',
            }}>
              or drag &amp; drop anywhere
            </span>
          </div>
        </div>

        {/* App Grid */}
        {apps.length > 0 ? (
          <>
            <div
              className="softn-launcher-section-label"
              style={{
                fontSize: '0.6875rem',
                fontWeight: 600,
                color: '#4a4a56',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                marginBottom: '1rem',
              }}
            >
              Recent Apps
            </div>
            <div className="softn-launcher-grid">
              {apps.map((app) => (
                <div
                  key={app.id}
                  className="softn-launcher-card"
                  onClick={() => onOpenCached(app)}
                >
                  {/* Remove button */}
                  <button
                    className="softn-launcher-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(app.id);
                    }}
                    title="Remove"
                  >
                    &times;
                  </button>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
                    {/* App icon */}
                    {app.icon ? (
                      <img
                        src={app.icon}
                        alt=""
                        style={{
                          width: '40px',
                          height: '40px',
                          borderRadius: '11px',
                          objectFit: 'cover',
                          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)',
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: '40px',
                          height: '40px',
                          background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
                          borderRadius: '11px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          boxShadow: '0 2px 8px rgba(59, 130, 246, 0.2)',
                        }}
                      >
                        <span style={{ color: 'white', fontWeight: 700, fontSize: '1rem' }}>
                          {app.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          color: '#ececf0',
                          fontSize: '0.875rem',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          letterSpacing: '-0.01em',
                        }}
                      >
                        {app.name}
                      </div>
                      <div style={{
                        fontSize: '0.6875rem',
                        color: '#4a4a56',
                        marginTop: '2px',
                      }}>
                        v{app.version}
                      </div>
                    </div>
                  </div>
                  {app.description && (
                    <div
                      style={{
                        marginTop: '0.875rem',
                        fontSize: '0.75rem',
                        color: '#7a7a86',
                        lineHeight: 1.55,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        letterSpacing: '-0.005em',
                      }}
                    >
                      {app.description}
                    </div>
                  )}
                  <div
                    style={{
                      marginTop: '0.875rem',
                      fontSize: '0.6875rem',
                      color: '#3a3a44',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.375rem',
                    }}
                  >
                    <span style={{
                      width: '4px',
                      height: '4px',
                      borderRadius: '50%',
                      background: '#3a3a44',
                      flexShrink: 0,
                    }} />
                    {formatDate(app.lastOpened)}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          /* Empty state */
          <div
            className="softn-launcher-empty"
            style={{
              textAlign: 'center',
              padding: '4.5rem 2rem',
              background: 'rgba(255, 255, 255, 0.015)',
              borderRadius: '18px',
              border: '1px dashed rgba(255, 255, 255, 0.06)',
              position: 'relative',
            }}
          >
            <div style={{
              width: '60px',
              height: '60px',
              borderRadius: '16px',
              background: 'rgba(59, 130, 246, 0.08)',
              border: '1px solid rgba(59, 130, 246, 0.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1.5rem',
            }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                <polyline points="13 2 13 9 20 9" />
              </svg>
            </div>
            <div style={{
              color: '#7a7a86',
              lineHeight: 1.6,
              fontSize: '0.9375rem',
              letterSpacing: '-0.01em',
            }}>
              No apps loaded yet.
              <br />
              Open a <strong style={{ color: '#b0b0bc', fontWeight: 500 }}>.softn</strong> file or drag and drop one onto this page.
            </div>
            <div
              style={{
                marginTop: '1.75rem',
                padding: '0.875rem 1.25rem',
                background: 'rgba(255, 255, 255, 0.025)',
                borderRadius: '10px',
                display: 'inline-block',
                border: '1px solid rgba(255, 255, 255, 0.04)',
              }}
            >
              <div style={{ color: '#4a4a56', fontSize: '0.75rem', letterSpacing: '-0.005em' }}>
                SoftN apps are self-contained bundles with UI, logic, and data.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
