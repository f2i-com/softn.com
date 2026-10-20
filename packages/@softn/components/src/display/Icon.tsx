/**
 * Icon Component
 *
 * Renders named SVG icons inline. Supports size and color props.
 * Use `name` for built-in icons or `svg` for custom SVG markup.
 */

import React from 'react';
import { domAttributes } from '../utils/domAttributes';
import { markupUrlJudge, sanitizeSvg, useEgressConfig } from '@softn/core';
import { iconMarkup } from '../utils/icons';

export interface IconProps {
  /** Built-in icon name */
  name?: string;
  /** Custom SVG markup (raw SVG string) */
  svg?: string;
  /** Icon size in px (default 20) */
  size?: number | string;
  /** Icon color (default currentColor) */
  color?: string;
  /**
   * What the icon means, when it is the only thing saying it (an icon-only
   * status, say). Without one the icon is decoration and hidden from
   * assistive technology; the text or button beside it carries the meaning.
   */
  ariaLabel?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles applied to the wrapper */
  style?: React.CSSProperties;
}

export function Icon({
  name,
  svg,
  size = 20,
  color = 'currentColor',
  ariaLabel,
  className,
  style,
  ...rest
}: IconProps): React.ReactElement {
  const a11y = ariaLabel
    ? ({ role: 'img', 'aria-label': ariaLabel } as const)
    : ({ 'aria-hidden': true } as const);
  // What custom markup may fetch: a `<use href="https://…">` is a request to
  // that host, judged by the bundle's `net` like any other.
  const judge = markupUrlJudge(useEgressConfig());
  const pxSize = typeof size === 'number' ? `${size}px` : size;

  const wrapperStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: pxSize,
    height: pxSize,
    flexShrink: 0,
    ...style,
  };

  // Custom SVG markup.
  //
  // Sanitized because this prop is routinely assigned from a `.ui` expression,
  // which means from a record in XDB or a value off the sync socket. Injecting
  // it verbatim routed straight around the renderer's tag denylist: `<Icon
  // svg={record.body}/>` with `<img src=x onerror=…>` ran on the host origin.
  if (svg) {
    return (
      <span
        {...domAttributes(rest)}
        className={className}
        style={wrapperStyle}
        {...a11y}
        dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg, judge) }}
      />
    );
  }

  // Built-in icon
  // The table's own entries only: `name="constructor"` found a function here.
  const iconSvg = iconMarkup(name) ?? null;
  if (!iconSvg) {
    return <span {...domAttributes(rest)} className={className} style={wrapperStyle} {...a11y} />;
  }

  // Determine if the icon uses fill or stroke
  const usesFill = iconSvg.includes('fill=') || name === 'send' || name === 'star' || name === 'heart';

  return (
    <span {...domAttributes(rest)} className={className} style={wrapperStyle} {...a11y}>
      <svg
        focusable="false"
        xmlns="http://www.w3.org/2000/svg"
        width={pxSize}
        height={pxSize}
        viewBox="0 0 24 24"
        fill={usesFill ? color : 'none'}
        stroke={usesFill ? 'none' : color}
        strokeWidth={usesFill ? undefined : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
        dangerouslySetInnerHTML={{ __html: iconSvg }}
      />
    </span>
  );
}

export default Icon;
