/**
 * SoftN Runtime Context
 *
 * React context provider for SoftN components.
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { SoftNRenderContext, RuntimeState, SoftNProps, XDBRecord } from '../types';

/**
 * Context type for SoftN runtime
 */
interface SoftNContextValue extends SoftNRenderContext {
  // Refresh data
  refreshData: () => void;
}

/**
 * SoftN Runtime Context
 */
const SoftNContext = createContext<SoftNContextValue | null>(null);

/**
 * Props for the SoftN Provider
 */
export interface SoftNProviderProps {
  initialState?: RuntimeState;
  initialData?: Record<string, XDBRecord[]>;
  props?: SoftNProps;
  functions?: Record<string, (...args: unknown[]) => unknown>;
  computed?: Record<string, unknown>;
  children: React.ReactNode;
}

/**
 * SoftN Provider Component
 */
export function SoftNProvider({
  initialState = {},
  initialData = {},
  props = {},
  functions = {},
  computed = {},
  children,
}: SoftNProviderProps): React.ReactElement {
  const [state, setStateValue] = useState<RuntimeState>(initialState);
  const [data, _setData] = useState<Record<string, XDBRecord[]>>(initialData);

  /**
   * Update state at a path
   */
  const setState = useCallback((path: string, value: unknown) => {
    setStateValue((prevState) => {
      const parts = path.split('.');
      const newState = { ...prevState };

      let current: Record<string, unknown> = newState;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!(part in current) || typeof current[part] !== 'object') {
          current[part] = {};
        }
        current[part] = { ...(current[part] as Record<string, unknown>) };
        current = current[part] as Record<string, unknown>;
      }

      current[parts[parts.length - 1]] = value;
      return newState;
    });
  }, []);

  /**
   * Refresh data from XDB
   */
  const refreshData = useCallback(() => {
    // This will be implemented when XDB integration is added
    console.log('Refreshing data...');
  }, []);

  /**
   * Context value
   */
  const contextValue = useMemo<SoftNContextValue>(
    () => ({
      state,
      setState,
      data,
      props,
      functions,
      asyncFunctions: {}, // Empty by default, populated by SoftNRenderer
      computed,
      refreshData,
    }),
    [state, setState, data, props, functions, computed, refreshData]
  );

  return <SoftNContext.Provider value={contextValue}>{children}</SoftNContext.Provider>;
}

/**
 * Hook to access the SoftN context
 */
export function useSoftNContext(): SoftNContextValue {
  const context = useContext(SoftNContext);
  if (!context) {
    throw new Error('useSoftNContext must be used within a SoftNProvider');
  }
  return context;
}

/**
 * Hook to access just the state
 */
export function useSoftNState(): [RuntimeState, (path: string, value: unknown) => void] {
  const { state, setState } = useSoftNContext();
  return [state, setState];
}

/**
 * Hook to access just the data
 */
export function useSoftNData(): Record<string, XDBRecord[]> {
  const { data } = useSoftNContext();
  return data;
}

/**
 * Hook to access props
 */
export function useSoftNProps(): SoftNProps {
  const { props } = useSoftNContext();
  return props;
}
