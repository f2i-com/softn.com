/**
 * What an app's first draw waited for, written down so its next open can
 * start it before the page is read (src/renderer/first-draw-memory.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentRegistry, type SoftNComponent } from '../src/renderer/registry';
import {
  MAX_APPS,
  preloadRememberedFirstDraw,
  recallFirstDraw,
  rememberFirstDraw,
  resetFirstDrawMemoryForTests,
} from '../src/renderer/first-draw-memory';

const Hello: SoftNComponent = () => null;

beforeEach(() => {
  localStorage.clear();
  resetFirstDrawMemoryForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('remembering a first draw', () => {
  it('records each app once a page load, from its first page', () => {
    rememberFirstDraw('notes', ['Tabs', 'Select']);
    // The app's next page, in the same load: not what it opens with.
    rememberFirstDraw('notes', ['Table']);
    expect(recallFirstDraw('notes')).toEqual(['Select', 'Tabs']);
  });

  it('replaces the record of the last open rather than adding to it', () => {
    rememberFirstDraw('notes', ['Tabs', 'Select']);
    resetFirstDrawMemoryForTests(); // the next page load
    rememberFirstDraw('notes', ['Select']);
    expect(recallFirstDraw('notes')).toEqual(['Select']);
    resetFirstDrawMemoryForTests();
    rememberFirstDraw('notes', []);
    expect(recallFirstDraw('notes')).toEqual([]);
  });

  it('keeps the most recently opened apps, and drops the oldest first', () => {
    const now = vi.spyOn(Date, 'now');
    for (let i = 0; i <= MAX_APPS; i++) {
      now.mockReturnValue(1000 + i);
      rememberFirstDraw(`app-${i}`, ['Select']);
    }
    expect(recallFirstDraw('app-0')).toEqual([]);
    expect(recallFirstDraw('app-1')).toEqual(['Select']);
    expect(recallFirstDraw(`app-${MAX_APPS}`)).toEqual(['Select']);
  });

  it('remembers nothing, and throws nothing, where storage is refused', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => rememberFirstDraw('notes', ['Select'])).not.toThrow();
    expect(recallFirstDraw('notes')).toEqual([]);
    expect(() => preloadRememberedFirstDraw('notes', new ComponentRegistry())).not.toThrow();
  });

  it('reads a record it cannot make sense of as none', () => {
    localStorage.setItem('softn:first-draw', '{"notes":{"names":"Select"}}');
    expect(recallFirstDraw('notes')).toEqual([]);
    localStorage.setItem('softn:first-draw', 'not json');
    expect(recallFirstDraw('notes')).toEqual([]);
  });
});

describe('starting a remembered first draw', () => {
  it('starts what the first draw waited for, and nothing a first draw does not wait for', () => {
    const registry = new ComponentRegistry();
    const loadLight = vi.fn(() => Promise.resolve(Hello));
    const loadHeavy = vi.fn(() => Promise.resolve(Hello));
    registry.registerLazy('Select', loadLight, { beforeFirstDraw: true });
    registry.registerLazy('Scene3D', loadHeavy);
    registry.register('Button', Hello);

    // What the renderer records: the names a first draw waits for, among a
    // first screen's tags, each once.
    const names = registry.firstDrawNames(['Select', 'Scene3D', 'Button', 'Nope', 'Select']);
    expect(names).toEqual(['Select']);
    rememberFirstDraw('shop', names);

    // A record written by hand, or by an older build, with a heavy name in it.
    localStorage.setItem('softn:first-draw', JSON.stringify({ shop: { names: ['Select', 'Scene3D'], at: 1 } }));
    preloadRememberedFirstDraw('shop', registry);
    expect(loadLight).toHaveBeenCalledTimes(1);
    expect(loadHeavy).not.toHaveBeenCalled();

    // The renderer joins the load rather than starting it again.
    void registry.firstDrawLoads(['Select']);
    expect(loadLight).toHaveBeenCalledTimes(1);
  });

  it('starts nothing for an app it has no record of', () => {
    const registry = new ComponentRegistry();
    const load = vi.fn(() => Promise.resolve(Hello));
    registry.registerLazy('Select', load, { beforeFirstDraw: true });
    preloadRememberedFirstDraw('never-opened', registry);
    expect(load).not.toHaveBeenCalled();
  });
});
