/**
 * ButtonGroup Component
 *
 * Buttons that belong together, drawn as one piece: the actions on one
 * thing, or the steps of a pager. Without it they are a row of separate
 * buttons with a gap, which is how every app here lays them out by hand.
 * For choosing one of a few options, SegmentedControl is the control.
 * Uses CSS variables for theming support.
 */

import React from 'react';

export interface ButtonGroupProps {
  /** Side by side, or one above the other */
  orientation?: 'horizontal' | 'vertical';
  /** Joined edge to edge. False keeps them apart with a small gap */
  attached?: boolean;
  /** Fill the width, each button taking an equal share */
  fullWidth?: boolean;
  /** What the group is for, read by a screen reader */
  ariaLabel?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** The buttons */
  children?: React.ReactNode;
}

/**
 * The joins. A Button sets its own corners inline, so the rules that square
 * the inner ones have to outrank an inline style. One sheet serves every
 * group on the page.
 *
 * Written for buttons by their type, not by their place among the group's
 * children: a Button draws a style element beside itself, so the first
 * child of a group is not its first button. And written without the child
 * combinator or quotes, which a server-rendered style element would be sent
 * with escaped.
 */
const groupStyles = `
  .softn-button-group--attached button { border-radius: 0 !important; position: relative; }
  .softn-button-group--attached button:focus-visible { z-index: 1; }
  .softn-button-group--attached.softn-button-group--horizontal button:not(:first-of-type) { margin-left: -1px; }
  .softn-button-group--attached.softn-button-group--vertical button:not(:first-of-type) { margin-top: -1px; }
  .softn-button-group--attached.softn-button-group--horizontal button:first-of-type {
    border-top-left-radius: var(--radius-lg, 0.5rem) !important;
    border-bottom-left-radius: var(--radius-lg, 0.5rem) !important;
  }
  .softn-button-group--attached.softn-button-group--horizontal button:last-of-type {
    border-top-right-radius: var(--radius-lg, 0.5rem) !important;
    border-bottom-right-radius: var(--radius-lg, 0.5rem) !important;
  }
  .softn-button-group--attached.softn-button-group--vertical button:first-of-type {
    border-top-left-radius: var(--radius-lg, 0.5rem) !important;
    border-top-right-radius: var(--radius-lg, 0.5rem) !important;
  }
  .softn-button-group--attached.softn-button-group--vertical button:last-of-type {
    border-bottom-left-radius: var(--radius-lg, 0.5rem) !important;
    border-bottom-right-radius: var(--radius-lg, 0.5rem) !important;
  }
  .softn-button-group--full button { flex: 1 1 0; min-width: 0; }
`;

export function ButtonGroup({
  orientation = 'horizontal',
  attached = true,
  fullWidth = false,
  ariaLabel,
  className,
  style,
  children,
}: ButtonGroupProps): React.ReactElement {
  const vertical = orientation === 'vertical';

  const groupStyle: React.CSSProperties = {
    display: fullWidth ? 'flex' : 'inline-flex',
    flexDirection: vertical ? 'column' : 'row',
    alignItems: 'stretch',
    gap: attached === false ? '0.5rem' : 0,
    flexWrap: attached === false && !vertical ? 'wrap' : 'nowrap',
    width: fullWidth ? '100%' : undefined,
    maxWidth: '100%',
    ...style,
  };

  return (
    <>
      <style>{groupStyles}</style>
      <div
        role="group"
        aria-label={ariaLabel}
        className={[
          'softn-button-group',
          attached === false ? '' : 'softn-button-group--attached',
          vertical ? 'softn-button-group--vertical' : 'softn-button-group--horizontal',
          fullWidth ? 'softn-button-group--full' : '',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={groupStyle}
      >
        {children}
      </div>
    </>
  );
}

export default ButtonGroup;
