import { useEffect, useRef, type RefObject } from 'react';

/** Fit once after both node measurement and the surrounding layout settle. */
export function useInitialSchemaFit({ ready, width, height, fit, interacted }: {
  ready: boolean;
  width: number;
  height: number;
  fit: () => void;
  interacted: RefObject<boolean>;
}) {
  const fitted = useRef(false);
  useEffect(() => {
    if (!ready || width <= 0 || height <= 0 || fitted.current || interacted.current) return;
    let secondFrame = 0;
    // ResizeObserver measurements can arrive after the first render, when
    // Seed Data takes its final height. A changed size cancels this attempt.
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (interacted.current) return;
        fitted.current = true;
        fit();
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [ready, width, height, fit, interacted]);
}
