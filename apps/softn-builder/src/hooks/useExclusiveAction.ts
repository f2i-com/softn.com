import { useCallback, useEffect, useRef, useState } from 'react';

/** Ignore repeat clicks/shortcuts until the current file operation has settled. */
export function useExclusiveAction(action: () => Promise<void>) {
  const actionRef = useRef(action);
  actionRef.current = action;
  const running = useRef(false);
  const mounted = useRef(true);
  const [isPending, setIsPending] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const run = useCallback(async () => {
    // A ref guards same-tick requests before React updates a disabled button.
    if (running.current) return;
    running.current = true;
    setIsPending(true);
    try {
      await actionRef.current();
    } finally {
      running.current = false;
      if (mounted.current) setIsPending(false);
    }
  }, []);
  return { run, isPending };
}
