/**
 * Form Component
 *
 * A form container with submit handling.
 */

import React from 'react';

export interface FormProps {
  /** Submit handler */
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children */
  children?: React.ReactNode;
}

export function Form({ onSubmit, className, style, children }: FormProps): React.ReactElement {
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit?.(event);
  };

  return (
    <form onSubmit={handleSubmit} className={className} style={style}>
      {children}
    </form>
  );
}

export default Form;
