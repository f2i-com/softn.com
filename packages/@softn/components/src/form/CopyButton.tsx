/**
 * CopyButton Component
 *
 * A button that copies text: a room code, an address, an export. An app
 * that wants one writes a logic function that calls the clipboard, keeps a
 * second state variable for "Copied" and a timer to put the label back.
 * This is that button: it copies its `value` when pressed, says so for a
 * moment to the eye and to a screen reader, and says so when the browser
 * refuses.
 *
 * A component runs in the page, beside the app's script and not inside its
 * sandbox, so it asks the app it is in: where the app's manifest denies its
 * script the clipboard, this does not copy either.
 * Uses CSS variables for theming support.
 */

import React from 'react';
import { useAppScope } from '@softn/core';
import { Button, type ButtonProps } from './Button';
import { Icon } from '../display/Icon';

export interface CopyButtonProps {
  /** The text to copy */
  value?: string | number | null;
  /** What the button says (default "Copy") */
  label?: React.ReactNode;
  /** What it says once it has copied (default "Copied") */
  copiedLabel?: React.ReactNode;
  /** The icon alone; the label is read out */
  iconOnly?: boolean;
  /** Visual style, as Button's */
  variant?: ButtonProps['variant'];
  /** Size, as Button's */
  size?: ButtonProps['size'];
  /** How long it says it has copied, in milliseconds (default 2000) */
  resetAfter?: number;
  /** Disabled state */
  disabled?: boolean;
  /** Called with the text once it is on the clipboard */
  onCopy?: (text: string) => void;
  /** Called when the browser would not copy */
  onError?: (reason: string) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** In place of `label` */
  children?: React.ReactNode;
}

/** Put `text` on the clipboard. Resolves to whether it got there. */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused, or a page that is not secure: the older way may still work.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

/** Read only by a screen reader: the change of the button's label is not announced on its own. */
const statusStyle: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

const text = (node: React.ReactNode, fallback: string): string => (typeof node === 'string' || typeof node === 'number' ? String(node) : fallback);

export function CopyButton({
  value,
  label,
  copiedLabel = 'Copied',
  iconOnly = false,
  variant = 'secondary',
  size = 'sm',
  resetAfter = 2000,
  disabled = false,
  onCopy,
  onError,
  className,
  style,
  children,
}: CopyButtonProps): React.ReactElement {
  const allowed = useAppScope().clipboard !== false;
  const [state, setState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const toCopy = value === null || value === undefined ? '' : String(value);
  const idleLabel = children ?? label ?? 'Copy';
  const shown = state === 'copied' ? copiedLabel : state === 'failed' ? 'Could not copy' : idleLabel;
  const said = state === 'copied' ? text(copiedLabel, 'Copied') : state === 'failed' ? 'Could not copy' : '';

  const handleClick = async () => {
    if (!allowed || toCopy === '') return;
    const copied = await writeToClipboard(toCopy);
    if (!mounted.current) return;
    setState(copied ? 'copied' : 'failed');
    if (copied) onCopy?.(toCopy);
    else onError?.('The browser did not allow the copy.');
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (mounted.current) setState('idle');
    }, Math.max(0, Number(resetAfter) || 0));
  };

  return (
    <span style={{ position: 'relative', display: 'inline-flex', ...style }} className={className}>
      <Button
        variant={variant}
        size={size}
        iconOnly={iconOnly}
        disabled={disabled || !allowed || toCopy === ''}
        onClick={() => void handleClick()}
        aria-label={iconOnly ? text(shown, 'Copy') : undefined}
        title={!allowed ? 'This app is not allowed to use the clipboard' : undefined}
        leftIcon={<Icon name={state === 'copied' ? 'check' : 'copy'} size={iconOnly ? 16 : 14} />}
      >
        {shown}
      </Button>
      <span role="status" aria-live="polite" style={statusStyle}>
        {said}
      </span>
    </span>
  );
}

export default CopyButton;
