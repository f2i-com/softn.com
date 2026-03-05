import { describe, it, expect } from 'vitest';
import { detectWorkerIncompatibilities } from '../src/runtime/formlogic';

describe('detectWorkerIncompatibilities', () => {
  it('returns empty list for pure logic code', () => {
    const code = `
      let a = 1;
      function sum(x, y) {
        return x + y;
      }
    `;
    expect(detectWorkerIncompatibilities(code)).toEqual([]);
  });

  it('detects synchronous bridge usage', () => {
    const code = `
      function tick() {
        let rows = db.query("tasks");
        window.addEventListener("resize", onResize);
        navigator.clipboard.writeText("x");
        localStorage.setItem("k", "v");
      }
    `;
    const reasons = detectWorkerIncompatibilities(code);
    expect(reasons).toContain('uses db bridge (synchronous host access)');
    expect(reasons).toContain('uses window bridge/event APIs');
    expect(reasons).toContain('uses navigator bridge APIs');
    expect(reasons).toContain('uses localStorage bridge');
  });

  it('ignores single-line comments', () => {
    const code = `
      // db.query("tasks")
      // window.addEventListener("resize", f)
      let ok = true;
    `;
    expect(detectWorkerIncompatibilities(code)).toEqual([]);
  });
});
