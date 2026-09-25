/**
 * Section Component
 *
 * Content section with optional title, subtitle, and action area.
 */

import React from 'react';
import { useJudgedBackground } from '../utils/egress';

export interface SectionProps {
  /** Section content */
  children?: React.ReactNode;
  /** Section title */
  title?: string;
  /** Section subtitle/description */
  subtitle?: string;
  /** Action buttons (top-right) */
  action?: React.ReactNode;
  /** Padding */
  padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Gap between children */
  gap?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Background color */
  background?: string;
  /** Border radius */
  borderRadius?: string;
  /** Collapsible */
  collapsible?: boolean;
  /** Default collapsed state */
  defaultCollapsed?: boolean;
  /** Heading level of the title (default 2) */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeMap: Record<string, string> = {
  none: '0',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
};

export function Section({
  children,
  title,
  subtitle,
  action,
  padding = 'lg',
  gap = 'md',
  background = 'var(--color-surface, #16161a)',
  borderRadius = 'var(--radius-lg, 0.75rem)',
  collapsible = false,
  defaultCollapsed = false,
  headingLevel = 2,
  className,
  style,
}: SectionProps): React.ReactElement {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
  const baseId = React.useId();
  const titleId = `${baseId}-title`;
  const contentId = `${baseId}-content`;
  const level = Math.min(6, Math.max(1, Math.round(Number(headingLevel)) || 2));
  const HeadingTag = `h${level}` as 'h2';
  const paddingValue = sizeMap[padding] || padding;
  const gapValue = sizeMap[gap] || gap;
  // A `url()` in `background` is a fetch the renderer's scrub of `style`
  // never sees; the same policy decides it here.
  const safeBackground = useJudgedBackground(background);

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    background: safeBackground,
    borderRadius,
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    overflow: 'hidden',
    transition: 'box-shadow 0.2s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
    ...style,
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
    padding: paddingValue,
    borderBottom: collapsed ? 'none' : '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    cursor: collapsible ? 'pointer' : 'default',
    userSelect: collapsible ? 'none' : 'auto',
  };

  const titleContainerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    flex: 1,
  };

  const titleStyle: React.CSSProperties = {
    margin: 0,
    fontSize: '1rem',
    fontWeight: 600,
    color: 'var(--color-text, #f5f5f5)',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  };

  const subtitleStyle: React.CSSProperties = {
    margin: 0,
    fontSize: '0.8125rem',
    color: 'var(--color-text-muted, #a1a1aa)',
    fontWeight: 400,
  };

  const contentStyle: React.CSSProperties = {
    display: collapsed ? 'none' : 'flex',
    flexDirection: 'column',
    gap: gapValue,
    padding: paddingValue,
    paddingTop: title ? '0' : paddingValue,
  };

  const chevronStyle: React.CSSProperties = {
    width: '1.25rem',
    height: '1.25rem',
    color: 'var(--color-text-muted, #a1a1aa)',
    transition: 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
    transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
  };

  const chevron = (
    <svg
      style={chevronStyle}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );

  const handleHeaderClick = () => {
    if (collapsible) {
      setCollapsed(!collapsed);
    }
  };

  // A collapsible title is a disclosure button inside the heading, so the
  // keyboard can reach it and a screen reader hears whether it is open.
  const toggle = collapsible && title;

  return (
    <section
      className={`softn-section ${className || ''}`}
      style={containerStyle}
      aria-labelledby={title ? titleId : undefined}
    >
      {(title || action) && (
        <div style={headerStyle} onClick={handleHeaderClick}>
          <div style={titleContainerStyle}>
            {title && (
              <HeadingTag style={titleStyle} id={titleId}>
                {toggle ? (
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    aria-controls={contentId}
                    // No handler of its own: the click bubbles to the header's.
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: 0,
                      margin: 0,
                      border: 0,
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      textAlign: 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    {chevron}
                    {title}
                  </button>
                ) : (
                  <>
                    {collapsible && chevron}
                    {title}
                  </>
                )}
              </HeadingTag>
            )}
            {subtitle && <p style={subtitleStyle}>{subtitle}</p>}
          </div>
          {action && <div onClick={(e) => e.stopPropagation()}>{action}</div>}
        </div>
      )}
      <div id={contentId} style={contentStyle} hidden={collapsed || undefined}>
        {children}
      </div>
    </section>
  );
}

export default Section;
