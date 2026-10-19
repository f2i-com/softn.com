/**
 * Props a component writes into CSS of its own, which the renderer's checks
 * do not see: a Popover's `placement` went into the text of a stylesheet, a
 * Spinner's `thickness` into its mask, a Switch's colours into its
 * background. Any text there was CSS of the bundle's: a rule for the whole
 * page, or an image loaded on sight with or without `net`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Popover } from '../src/feedback/Popover';
import { Spinner } from '../src/display/Spinner';
import { Switch } from '../src/form/Switch';

afterEach(() => {
  document.body.innerHTML = '';
});

const EVIL = 'url(https://evil.example/x.png)';

describe('CSS a component writes from its props', () => {
  it('Popover takes only a placement it knows', () => {
    const out = renderToStaticMarkup(
      <Popover
        trigger={<button>open</button>}
        placement={'x{} body{background-image:url(https://evil.example/pop)} @keyframes y' as 'top'}
        defaultOpen
      >
        content
      </Popover>
    );
    expect(out).not.toContain('evil.example');
    expect(out).toContain('softn-popover-in-bottom');
  });

  it('Spinner takes a number for its ring', () => {
    const out = renderToStaticMarkup(<Spinner thickness={`0px), #fff), ${EVIL}, radial-gradient(#fff, #fff calc(0` as unknown as number} />);
    expect(out).not.toContain('evil.example');
  });

  it('Switch paints only colours', () => {
    const off = renderToStaticMarkup(<Switch offColor={EVIL} />);
    const on = renderToStaticMarkup(<Switch checked onColor={EVIL} onChange={() => {}} />);
    expect(off + on).not.toContain('evil.example');
    expect(renderToStaticMarkup(<Switch checked onColor="#123456" onChange={() => {}} />)).toContain('#123456');
  });
});
