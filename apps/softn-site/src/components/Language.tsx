import React, { useRef, useState } from 'react';
import { Reveal } from './Reveal';
import { Code } from '../lib/highlight';
import { SAMPLES } from '../data/language';

export function Language(): React.ReactElement {
  const [active, setActive] = useState(SAMPLES[0].id);
  const sample = SAMPLES.find((s) => s.id === active) ?? SAMPLES[0];
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * One tab stop for the whole strip, arrow keys between the tabs — the pattern
   * `role="tablist"` promises. Five separate tab stops was the other half of the
   * problem below 820px, where the strip scrolls sideways: tabs four and five
   * start off the right edge at 320px, and the browser does not scroll a focused
   * child into a scroller of its own accord, so tabbing walked into controls
   * nobody could see. Selection moves with focus, and the `onFocus` below brings
   * the tab into view.
   */
  function move(to: number | 'first' | 'last'): void {
    const i = SAMPLES.findIndex((s) => s.id === active);
    const last = SAMPLES.length - 1;
    const n = to === 'first' ? 0 : to === 'last' ? last : (i + to + SAMPLES.length) % SAMPLES.length;
    setActive(SAMPLES[n].id);
    (listRef.current?.children[n] as HTMLElement | undefined)?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    const to: Record<string, number | 'first' | 'last' | undefined> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      Home: 'first',
      End: 'last',
    };
    const step = to[e.key];
    if (step === undefined) return;
    e.preventDefault();
    move(step);
  }

  return (
    <Reveal as="section" className="band" id="language">
      <div className="wrap">
        <div className="band-head">
          <span className="eyebrow">The language</span>
          <h2 className="band-title">Five ideas, and you have read the whole thing.</h2>
          <p className="band-sub">
            Tags for structure, braces for expressions, <code>@</code> to send an event out and <code>:</code> to bind a
            value both ways, <code>#</code> for control flow, and a <code>.logic</code> file for everything else. It is
            small on purpose — a language a model can write correctly on the first attempt is a language you can read.
          </p>
        </div>

        <div className="lang">
          <div className="lang-list" role="tablist" aria-label="Language examples" ref={listRef} onKeyDown={onKeyDown}>
            {SAMPLES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`lang-tab-${s.id}`}
                aria-selected={s.id === active}
                /* Only the selected sample's panel is rendered, so pointing the
                   other four at ids that do not exist claims a relationship the
                   browser drops on the floor. */
                aria-controls={s.id === active ? `lang-panel-${s.id}` : undefined}
                tabIndex={s.id === active ? 0 : -1}
                className="lang-tab"
                onClick={() => setActive(s.id)}
                onFocus={(e) => e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })}
              >
                <span className="lang-tab-name">{s.name}</span>
                <span className="lang-tab-hint">{s.hint}</span>
              </button>
            ))}
          </div>

          <div className="lang-body">
            <div className="panel-bar">
              <span className="panel-bar-name">{sample.file}</span>
              <span className="panel-bar-tag">{sample.file.endsWith('.logic') ? 'logic' : 'markup'}</span>
            </div>
            <div
              role="tabpanel"
              id={`lang-panel-${sample.id}`}
              aria-labelledby={`lang-tab-${sample.id}`}
              style={{ display: 'contents' }}
            >
              <Code source={sample.source} className="lang-code" label={`${sample.file} source`} />
            </div>
          </div>
        </div>
      </div>
    </Reveal>
  );
}
