/**
 * What a page said while a journey ran.
 *
 * The audit asks the gate to attach console errors and uncaught exceptions
 * to every run, not only to failures: a journey that passes while the
 * runtime logs an uncaught TypeError is one that will fail next week. So
 * every message and every `pageerror` is recorded per page and attached to
 * the test's results as text, and a spec can ask for the uncaught errors to
 * assert that there were none.
 *
 * Console *messages* are not asserted on by the gate: the apps log by
 * design (`[SoftN Web] …`), a browser logs a failed favicon fetch, and a
 * gate that fails on noise is soon ignored. Uncaught exceptions are the
 * line: those are asserted by the specs that own the page.
 */
import type { Page, TestInfo } from '@playwright/test';

export interface PageLog {
  /** `pageerror` events: exceptions nothing on the page caught. */
  readonly uncaught: string[];
  /** Console messages at `error` level. */
  readonly errors: string[];
  /** Every console message, prefixed with its level. */
  readonly all: string[];
  /** Attach the record to the test's results under `label`. */
  attach(label: string): Promise<void>;
}

/** Start recording `page`; `testInfo` is where the record is attached. */
export function watchConsole(page: Page, testInfo: TestInfo): PageLog {
  const uncaught: string[] = [];
  const errors: string[] = [];
  const all: string[] = [];
  page.on('console', (message) => {
    const line = `[${message.type()}] ${message.text()}`;
    all.push(line);
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => {
    uncaught.push(`${error.name}: ${error.message}\n${error.stack ?? ''}`);
  });
  return {
    uncaught,
    errors,
    all,
    async attach(label: string): Promise<void> {
      const body = [`# ${label}`, `# url: ${page.url()}`, '', '## uncaught exceptions', ...(uncaught.length ? uncaught : ['(none)']), '', '## console', ...(all.length ? all : ['(nothing logged)'])].join('\n');
      await testInfo.attach(`console-${label}`, { body, contentType: 'text/plain' });
    },
  };
}
