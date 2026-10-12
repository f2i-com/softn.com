/**
 * The chat of a project open in two tabs, merged.
 *
 * A merged save put the messages of both tabs in the order of their
 * timestamps and kept the last 200. Two things followed from trusting the
 * clock that far. A message said after the computer's clock was put back
 * sorted among the oldest, and with the chat at 200 it was the one cut: a
 * new message was gone from storage, with nothing said. And two messages, one
 * from each tab, with the same timestamp were stored in the order of
 * whichever tab saved last, so the stored chat changed order from save to
 * save. Each tab's own order is kept now, and only where the two tabs' lists
 * do not say which came first is the time read, then the id.
 */

import { describe, expect, it } from 'vitest';
import { mergeProjectRecords, orderChat } from '../src/lib/projectMerge';
import type { ProjectRecord } from '../src/lib/persistence';
import type { ChatMessage } from '../src/types/studio';

const say = (id: string, timestamp: number): ChatMessage => ({ id, role: 'user', content: id, timestamp });

function record(messages: ChatMessage[], revision: number): ProjectRecord {
  return {
    projectId: 'p',
    schemaVersion: 1,
    revision,
    savedAt: revision,
    workspace: {
      projectName: 'Notes',
      projectId: 'p',
      brief: null,
      blueprint: null,
      taskGraph: [],
      blueprintApproved: true,
      mode: 'design',
      leftPanel: 'ai',
      leftPanelExpanded: true,
      rightSidebarOpen: true,
      bottomDrawerOpen: false,
      bottomTab: 'log',
      advancedMode: false,
      activePageId: null,
      activeFilePath: null,
      selectedComponentId: null,
      devicePreset: 'desktop',
      zoom: 100,
      themePreview: 'light',
      consoleOutput: [],
    },
    files: [{ path: 'ui/main.ui', content: '<Text>Main</Text>', mimeType: 'text/plain', lastModified: 1, lastModifiedBy: 'user', version: 1 }],
    session: { messages, iterationsUsed: 0, tokensUsed: 0, filesChanged: 0 },
  };
}

const ids = (messages: readonly ChatMessage[]) => messages.map((m) => m.id);
const merged = (base: ChatMessage[], mine: ChatMessage[], theirs: ChatMessage[]) =>
  mergeProjectRecords(record(base, 1), record(mine, 2), record(theirs, 3), 4).record.session.messages;

describe('the chat of a merged save', () => {
  const full = Array.from({ length: 200 }, (_, i) => say(`m${i}`, 1_000_000 + i * 1000));

  it('keeps a message said after the clock was put back, with the chat at 200', () => {
    const late = say('late', 5_000);
    const theirs = say('theirs', 2_000_000);
    const out = merged(full, [...full, late], [...full, theirs]);
    expect(out).toHaveLength(200);
    expect(ids(out)).toContain('late');
    expect(ids(out)).toContain('theirs');
    // The oldest are the ones that go.
    expect(ids(out).slice(0, 2)).toEqual(['m2', 'm3']);
    expect(ids(out).slice(-2)).toEqual(['late', 'theirs']);
  });

  it('stores two tabs’ messages of the same moment in one order, whichever tab saves', () => {
    const base = full.slice(0, 3);
    const a = say('from-a', 9_000_000);
    const b = say('from-b', 9_000_000);
    const savedByA = merged(base, [...base, a], [...base, b]);
    const savedByB = merged(base, [...base, b], [...base, a]);
    expect(ids(savedByA)).toEqual(ids(savedByB));
  });

  it('keeps one tab’s own order for messages of the same moment', () => {
    const base = full.slice(0, 3);
    const question = say('z-question', 9_000_000);
    const answer = say('a-answer', 9_000_000);
    expect(ids(merged(base, [...base, question, answer], base)).slice(-2)).toEqual(['z-question', 'a-answer']);
    expect(ids(merged(base, base, [...base, question, answer])).slice(-2)).toEqual(['z-question', 'a-answer']);
  });

  it('still puts the other tab’s messages among this tab’s by when they were said', () => {
    const base = [say('one', 1000)];
    const out = merged(base, [...base, say('mine-3', 3000), say('mine-5', 5000)], [...base, say('theirs-4', 4000)]);
    expect(ids(out)).toEqual(['one', 'mine-3', 'theirs-4', 'mine-5']);
  });
});

describe('orderChat', () => {
  it('orders what the lists disagree on by time, and leaves out nothing', () => {
    const a = say('a', 1);
    const b = say('b', 2);
    const keep = new Map([a, b].map((m) => [m.id, m]));
    expect(ids(orderChat([[a, b], [b, a]], keep))).toEqual(['a', 'b']);
  });
});
