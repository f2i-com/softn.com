/**
 * Confirm Component
 *
 * "Are you sure?" in one tag: a question, what will happen, and the two
 * answers. It is a Modal with its buttons already in it, so asking before
 * something is deleted does not mean laying a dialog out by hand each time.
 *
 *   <Confirm open={asking} title="Delete this note?" message="This cannot be undone."
 *            confirmText="Delete" variant="danger"
 *            @confirm={() => remove()} @cancel={() => asking = false} />
 *
 * The app keeps `open`: both answers are told to it, and neither closes the
 * dialog behind its back, so a failed delete can leave the question up.
 */

import React from 'react';
import { Modal } from './Modal';
import { Button } from '../form/Button';
import { named } from '../utils/choice';

export interface ConfirmProps {
  /** Whether the question is being asked */
  open?: boolean;
  /** The question */
  title?: string;
  /** What will happen, under the question. Content inside the tag is shown after it */
  message?: React.ReactNode;
  /** The answer that goes ahead */
  confirmText?: string;
  /** The answer that does not */
  cancelText?: string;
  /** How the go-ahead button looks: `danger` for something that cannot be undone */
  variant?: 'primary' | 'danger' | 'warning' | 'success';
  /** The action is under way: both answers are held and the go-ahead button shows it */
  loading?: boolean;
  /** Dialog size */
  size?: 'sm' | 'md' | 'lg';
  /** Called when the person goes ahead */
  onConfirm?: () => void;
  /** Called when they do not: the other button, Escape, or a click outside */
  onCancel?: () => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** More to say, after the message */
  children?: React.ReactNode;
}

const variants: Record<string, 'primary' | 'danger' | 'warning' | 'success'> = {
  primary: 'primary',
  danger: 'danger',
  warning: 'warning',
  success: 'success',
};

const sizes: Record<string, 'sm' | 'md' | 'lg'> = { sm: 'sm', md: 'md', lg: 'lg' };

export function Confirm({
  open = false,
  title = 'Are you sure?',
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'primary',
  loading = false,
  size = 'sm',
  onConfirm,
  onCancel,
  className,
  style,
  children,
}: ConfirmProps): React.ReactElement | null {
  const busy = loading === true;
  // Nothing to ask while the answer is being acted on.
  const cancel = () => {
    if (!busy) onCancel?.();
  };
  const confirm = () => {
    if (!busy) onConfirm?.();
  };

  const messageStyle: React.CSSProperties = {
    margin: 0,
    fontSize: 'var(--text-sm, 0.875rem)',
    lineHeight: 1.5,
    color: 'var(--color-text-muted, inherit)',
    overflowWrap: 'anywhere',
  };

  const hasMessage = message !== null && message !== undefined && message !== '' && typeof message !== 'boolean';

  // The keyboard starts on the answer that changes nothing. The Modal this
  // is built on focuses the dialog itself when it opens; a question is
  // answered from the keyboard, and Enter on one that has just appeared
  // must not be "Delete". Called once, when the answers are first drawn:
  // a callback that changed each render would take the focus back every
  // time the page drew again.
  const focusSafeAnswer = React.useCallback((answers: HTMLDivElement | null) => {
    answers?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, []);

  return (
    <Modal
      open={open === true}
      onClose={cancel}
      // A title that has not arrived (state still null) is still a question.
      title={typeof title === 'string' && title !== '' ? title : 'Are you sure?'}
      size={named(sizes, size) ?? 'sm'}
      showCloseButton={false}
      closeOnOverlayClick={!busy}
      closeOnEscape={!busy}
      className={className}
      style={style}
      footer={
        // The answer that changes nothing comes first, and is given the
        // keyboard when the dialog opens. `display: contents` leaves the
        // two buttons laid out by the Modal's footer as though unwrapped.
        <div ref={focusSafeAnswer} style={{ display: 'contents' }}>
          <Button variant="secondary" onClick={cancel} disabled={busy}>
            {cancelText ?? 'Cancel'}
          </Button>
          <Button variant={named(variants, variant) ?? 'primary'} onClick={confirm} loading={busy}>
            {confirmText ?? 'Confirm'}
          </Button>
        </div>
      }
    >
      {hasMessage && <p style={messageStyle}>{message}</p>}
      {children}
    </Modal>
  );
}

export default Confirm;
