import React, { useState } from 'react';

interface IntegerLimitInputProps {
  id: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  style?: React.CSSProperties;
  onCommit(value: number): void;
}

/** Keep a partial edit out of persisted settings; apply it when leaving the field. */
export function IntegerLimitInput({ value, min, max, onCommit, ...props }: IntegerLimitInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...props}
      type="number"
      min={min}
      max={max}
      value={draft ?? String(value)}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => {
        const text = event.currentTarget.value.trim();
        const number = Number(text);
        setDraft(null);
        if (text && Number.isFinite(number)) onCommit(Math.max(min, Math.min(max, Math.floor(number))));
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') { event.preventDefault(); setDraft(null); }
      }}
    />
  );
}
