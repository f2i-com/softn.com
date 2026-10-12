/**
 * A function the page calls while it is drawn, over state the page does not name.
 *
 * State the markup never names is kept in the engine and not mirrored to the
 * page, because nothing on the page could read it and mirroring it costs. But
 * a function called from the markup is how a newcomer reads state:
 *
 *   function label() { return "n is " + n }      <p>{label()}</p>
 *
 * `n` is named by logic alone, so a change to it told the page nothing, the
 * page was not drawn again, and the paragraph stood at "n is 1" whatever was
 * clicked. Nothing said why.
 *
 * This mounts the real loader over the real engine and acts on the page, once
 * for every way a page comes to call a function while it is drawn and every
 * way the state under it comes to change. Each case reads the text before it
 * acts: a case that only asked for a difference would pass on a page read
 * before its logic had loaded.
 *
 * The state in these pages is never a word of the markup. The scan that
 * decides what a page names reads the page as text, so a paragraph saying
 * "n is big" names `n`, and that page worked while its neighbours did not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useEffect, useRef, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SoftNRenderer, type SoftNRendererProps } from '../src/loader/SoftNRenderer';
import { registerComponent, type SoftNComponent } from '../src/renderer/registry';
import { composeBundleSource } from '../src/bundle/source-composer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Fires its handler on an interval, as the components' `<Loop>` does. */
function TestLoop({ interval = 25, onTick }: { interval?: number; onTick?: () => unknown }) {
  const handler = useRef(onTick);
  handler.current = onTick;
  useEffect(() => {
    const id = setInterval(() => void handler.current?.(), interval);
    return () => clearInterval(id);
  }, [interval]);
  return null;
}
registerComponent('TestLoop', TestLoop as unknown as SoftNComponent);

interface Column {
  render: (row: unknown) => unknown;
}

/** A table that asks a function for each cell while it is drawn, as a column's `render` is asked. */
function TestTable({
  rows = [],
  render,
  formatter,
  columns,
}: {
  rows?: unknown[];
  render?: (row: unknown) => unknown;
  formatter?: (row: unknown) => unknown;
  columns?: Column[];
}) {
  const cell = columns?.[0]?.render ?? render ?? formatter;
  return (
    <ul>
      {rows.map((row, index) => (
        <li key={index} className="cell">
          {String(cell ? cell(row) : '')}
        </li>
      ))}
    </ul>
  );
}
registerComponent('TestTable', TestTable as unknown as SoftNComponent);

let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
});

const text = (selector: string) => container.querySelector(selector)?.textContent;
const texts = (selector: string) => [...container.querySelectorAll(selector)].map((node) => node.textContent);

async function settle(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function click(id: string) {
  await act(async () => {
    (container.querySelector(`#${id}`) as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 120));
  });
}

/** Mount a page and wait for its logic to have loaded: `ready` is drawn with something in it. */
async function mount(source: string, ready: string, props: Partial<SoftNRendererProps> = {}) {
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer source={source} {...props} />);
  });
  for (let i = 0; i < 80; i++) {
    const drawn = container.querySelector(ready)?.textContent;
    if (drawn && !drawn.includes('undefined')) break;
    await settle(50);
  }
  expect(container.querySelector(ready), 'the page should render').not.toBeNull();
}

const BUMP = '<button id="bump" @click={() => bump()}>Bump</button>';

describe('a function the page calls while it is drawn', () => {
  it('is asked again when the state it reads changes: a call alone on the page', async () => {
    await mount(
      `<logic>
let n = 1
function bump() { n = n + 1 }
function label() { return "n is " + n }
</logic>
<div>
  ${BUMP}
  <p class="label">{label()}</p>
</div>`,
      '.label'
    );
    expect(text('.label')).toBe('n is 1');
    await click('bump');
    expect(text('.label')).toBe('n is 2');
    await click('bump');
    expect(text('.label')).toBe('n is 3');
  }, 60_000);

  it('beside other state the page names', async () => {
    await mount(
      `<logic>
let tally = 1
let other = "x"
function bump() { tally = tally + 1 }
function label() { return "tally is " + tally }
</logic>
<div>
  ${BUMP}
  <p class="label">{label()}</p>
  <p class="other">{other}</p>
</div>`,
      '.label'
    );
    expect(text('.label')).toBe('tally is 1');
    expect(text('.other')).toBe('x');
    await click('bump');
    expect(text('.label')).toBe('tally is 2');
  }, 60_000);

  it('in an attribute', async () => {
    await mount(
      `<logic>
let tally = 1
function bump() { tally = tally + 1 }
function label() { return "tally is " + tally }
</logic>
<div>
  ${BUMP}
  <p class="label" title={label()}>shown</p>
</div>`,
      '.label[title]'
    );
    const title = () => container.querySelector('.label')?.getAttribute('title');
    for (let i = 0; i < 40 && title() !== 'tally is 1'; i++) await settle(50);
    expect(title()).toBe('tally is 1');
    await click('bump');
    expect(title()).toBe('tally is 2');
  }, 60_000);

  it('through another function', async () => {
    await mount(
      `<logic>
let tally = 1
function bump() { tally = tally + 1 }
function inner() { return tally }
function label() { return "tally is " + inner() }
</logic>
<div>
  ${BUMP}
  <p class="label">{label()}</p>
</div>`,
      '.label'
    );
    expect(text('.label')).toBe('tally is 1');
    await click('bump');
    expect(text('.label')).toBe('tally is 2');
  }, 60_000);

  // The same page whose branches said "n is big" and "n is small" passed
  // before this was fixed: the words of a paragraph are scanned too, and
  // those name `n`. These branches name nothing.
  it('as the condition of an #if whose branches name no state', async () => {
    await mount(
      `<logic>
let tally = 1
function bump() { tally = tally + 1 }
function big() { return tally > 1 }
</logic>
<div>
  ${BUMP}
  #if (big())
    <p class="label">large</p>
  #else
    <p class="label">little</p>
  #end
</div>`,
      '.label'
    );
    // The #else branch is drawn before the logic has loaded as well, so wait
    // for the function to be there to ask.
    await settle(300);
    expect(text('.label')).toBe('little');
    await click('bump');
    expect(text('.label')).toBe('large');
  }, 60_000);

  it('in the body of an #each, with the loop variable as its argument', async () => {
    await mount(
      `<logic>
let items = ["tea", "bun"]
let rate = 2
function bump() { rate = rate + 1 }
function price(item) { return item + " x" + rate }
</logic>
<div>
  ${BUMP}
  <ul>
    #each (item in items)
      <li class="row">{price(item)}</li>
    #end
  </ul>
</div>`,
      '.row'
    );
    expect(texts('.row')).toEqual(['tea x2', 'bun x2']);
    await click('bump');
    expect(texts('.row')).toEqual(['tea x3', 'bun x3']);
  }, 60_000);

  it('several of them on one page, each over its own state', async () => {
    await mount(
      `<logic>
let apples = 1
let pears = 10
let plums = 100
function moreApples() { apples = apples + 1 }
function morePears() { pears = pears + 1 }
function morePlums() { plums = plums + 1 }
function a() { return "a" + apples }
function b() { return "b" + pears }
function c() { return "c" + plums }
</logic>
<div>
  <button id="one" @click={() => moreApples()}>One</button>
  <button id="two" @click={() => morePears()}>Two</button>
  <button id="three" @click={() => morePlums()}>Three</button>
  <p class="label">{a()} {b()} {c()}</p>
</div>`,
      '.label'
    );
    expect(text('.label')).toBe('a1 b10 c100');
    await click('two');
    expect(text('.label')).toBe('a1 b11 c100');
    await click('three');
    expect(text('.label')).toBe('a1 b11 c101');
    await click('one');
    expect(text('.label')).toBe('a2 b11 c101');
  }, 60_000);

  // This one was drawn again before the rest were: every name a `$:`
  // expression is written with is mirrored, so the state under `doubled` is.
  // It is here so that it stays so.
  it('over a $: value, whose own state the page does not name', async () => {
    await mount(
      `<logic>
let step = 1
$: doubled = step * 2
function bump() { step = step + 1 }
function label() { return "doubled is " + doubled }
</logic>
<div>
  ${BUMP}
  <p class="label">{label()}</p>
</div>`,
      '.label'
    );
    expect(text('.label')).toBe('doubled is 2');
    await click('bump');
    expect(text('.label')).toBe('doubled is 4');
  }, 60_000);

  it('on a page with a style block', async () => {
    await mount(
      `<style>
.label { color: teal; }
</style>
<logic>
let tally = 1
function bump() { tally = tally + 1 }
function label() { return "tally is " + tally }
</logic>
<div>
  ${BUMP}
  <p class="label">{label()}</p>
</div>`,
      '.label'
    );
    expect(text('.label')).toBe('tally is 1');
    await click('bump');
    expect(text('.label')).toBe('tally is 2');
  }, 60_000);
});

describe('a function a component is handed, and calls while it is drawn', () => {
  const LOGIC = `<logic>
let rows = ["tea", "bun"]
let unit = "kg"
function bump() { unit = unit + "!" }
function cell(row) { return row + " " + unit }
</logic>`;

  it('as an arrow in a prop that calls the function', async () => {
    await mount(
      `${LOGIC}
<div>
  ${BUMP}
  <TestTable rows={rows} render={(row) => cell(row)} />
</div>`,
      '.cell'
    );
    expect(texts('.cell')).toEqual(['tea kg', 'bun kg']);
    await click('bump');
    expect(texts('.cell')).toEqual(['tea kg!', 'bun kg!']);
  }, 60_000);

  it('by name, in a record of a list of columns', async () => {
    await mount(
      `${LOGIC}
<div>
  ${BUMP}
  <TestTable rows={rows} columns={[{ render: cell }]} />
</div>`,
      '.cell'
    );
    expect(texts('.cell')).toEqual(['tea kg', 'bun kg']);
    await click('bump');
    expect(texts('.cell')).toEqual(['tea kg!', 'bun kg!']);
  }, 60_000);

  it('as the function itself, by name', async () => {
    await mount(
      `${LOGIC}
<div>
  ${BUMP}
  <TestTable rows={rows} formatter={cell} />
</div>`,
      '.cell'
    );
    expect(texts('.cell')).toEqual(['tea kg', 'bun kg']);
    await click('bump');
    expect(texts('.cell')).toEqual(['tea kg!', 'bun kg!']);
  }, 60_000);

  it('as the render of a column in a list of columns', async () => {
    await mount(
      `${LOGIC}
<div>
  ${BUMP}
  <TestTable rows={rows} columns={[{ render: (row) => cell(row) }]} />
</div>`,
      '.cell'
    );
    expect(texts('.cell')).toEqual(['tea kg', 'bun kg']);
    await click('bump');
    expect(texts('.cell')).toEqual(['tea kg!', 'bun kg!']);
  }, 60_000);
});

describe('however the state under a drawn function comes to change', () => {
  // When what follows an `await` runs is the engine's to say. ZIPP runs it
  // before the call returns, and the page is told of the change; the
  // host-JavaScript engine runs it afterwards, and a page is not told,
  // whether it names the state or not. So the page that only calls a
  // function is held to what a page that also names the state shows: on
  // ZIPP that is the change.
  it('in a handler that waits on a promise first, as for state the page names', async () => {
    const page = (named: string) => `<logic>
let tally = 1
async function bump() { await Promise.resolve(); tally = tally + 1 }
function label() { return "tally is " + tally }
</logic>
<div>
  ${BUMP}
  <p class="label">{label()}</p>
  ${named}
</div>`;
    await mount(page('<p class="named">{tally}</p>'), '.label');
    expect(text('.label')).toBe('tally is 1');
    await click('bump');
    const whenNamed = text('.label');
    await act(async () => root?.unmount());
    root = null;

    await mount(page(''), '.label');
    expect(text('.label')).toBe('tally is 1');
    await click('bump');
    expect(text('.label')).toBe(whenNamed);
  }, 60_000);

  // The waits a script can make: a call to the host, answered later, and a
  // timer, which is one (logic-timers.ts).
  it('in the callback of a host call that is answered later', async () => {
    await mount(
      `<logic>
let tally = 1
function bump() { softn.backend.call("slow", {}, function (answer) { tally = tally + 1 }) }
function label() { return "tally is " + tally }
</logic>
<div>
  ${BUMP}
  <p class="label">{label()}</p>
</div>`,
      '.label',
      {
        backendCall: async () => {
          await new Promise((r) => setTimeout(r, 30));
          return { ok: true };
        },
      }
    );
    expect(text('.label')).toBe('tally is 1');
    await click('bump');
    await settle(150);
    expect(text('.label')).toBe('tally is 2');
  }, 60_000);

  it('in the callback of a timer the logic set', async () => {
    await mount(
      `<logic>
let tally = 1
function bump() { setTimeout(function () { tally = tally + 1 }, 30) }
function label() { return "tally is " + tally }
</logic>
<div>
  ${BUMP}
  <p class="label">{label()}</p>
</div>`,
      '.label'
    );
    expect(text('.label')).toBe('tally is 1');
    await click('bump');
    await settle(150);
    expect(text('.label')).toBe('tally is 2');
  }, 60_000);

  it('in a listener the script put on the window', async () => {
    await mount(
      `<logic>
let tally = 1
function _init() { window.addEventListener("keydown", function (event) { tally = tally + 1 }) }
function label() { return "tally is " + tally }
</logic>
<div>
  <p class="label">{label()}</p>
</div>`,
      '.label'
    );
    // The listener is put on the real window once `_init` has run.
    await settle(200);
    expect(text('.label')).toBe('tally is 1');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(text('.label')).toBe('tally is 2');
  }, 60_000);

  it('on an interval, with nothing clicked', async () => {
    await mount(
      `<logic>
let tally = 1
function tick() { tally = tally + 1 }
function label() { return "tally is " + tally }
</logic>
<div>
  <TestLoop interval={25} @tick={tick} />
  <p class="label">{label()}</p>
</div>`,
      '.label'
    );
    const shown = () => Number(/^tally is (\d+)$/.exec(text('.label') ?? '')?.[1]);
    const first = shown();
    expect(first).toBeGreaterThanOrEqual(1);
    await settle(300);
    const later = shown();
    expect(later).toBeGreaterThan(first);
    await settle(300);
    expect(shown()).toBeGreaterThan(later);
  }, 60_000);

  // Named state is compared by what it holds, so a change inside a list or
  // a record is a change. State a drawn function reads is held to the same.
  it('inside a record of a list, and by adding to a list', async () => {
    await mount(
      `<logic>
let todos = [{ done: false }]
let basket = []
function bump() { todos[0].done = true; basket.push("bun") }
function label() { return (todos[0].done ? "done" : "open") + " " + basket.length }
</logic>
<div>
  ${BUMP}
  <p class="label">{label()}</p>
</div>`,
      '.label'
    );
    expect(text('.label')).toBe('open 0');
    await click('bump');
    expect(text('.label')).toBe('done 1');
  }, 60_000);
});

describe('a drawn function that is declared somewhere else', () => {
  it('in a logic file the app lists, in one it imports, and in its own', async () => {
    const files = new Map<string, string>([
      [
        'ui/main.ui',
        `<logic src="../logic/main.logic" />
<div>
  ${BUMP}
  <p class="listed">{fromListed()}</p>
  <p class="imported">{fromImported()}</p>
  <p class="entry">{fromEntry()}</p>
</div>`,
      ],
      ['logic/shared.logic', 'let apples = 1\nfunction fromListed() { return "apples " + apples }\n'],
      ['logic/more.logic', 'let pears = 1\nfunction fromImported() { return "pears " + pears }\n'],
      [
        'logic/main.logic',
        'import "./more.logic"\nlet plums = 1\nfunction fromEntry() { return "plums " + plums }\nfunction bump() { apples = apples + 1; pears = pears + 2; plums = plums + 3 }\n',
      ],
    ]);
    const composed = composeBundleSource(files, 'ui/main.ui', ['logic/shared.logic', 'logic/main.logic']);
    // One file reaches the engine already joined to the entry, the other is
    // fetched by the runtime as it loads: both roads are on this page.
    expect(composed.preIncludedLogicPaths).toEqual(['logic/shared.logic']);
    await mount(composed.source, '.entry', {
      importResolver: async (path) => files.get(path) ?? null,
      logicBasePath: composed.logicBasePath,
      preIncludedLogicPaths: composed.preIncludedLogicPaths,
    });
    expect(text('.listed')).toBe('apples 1');
    expect(text('.imported')).toBe('pears 1');
    expect(text('.entry')).toBe('plums 1');
    await click('bump');
    expect(text('.listed')).toBe('apples 2');
    expect(text('.imported')).toBe('pears 3');
    expect(text('.entry')).toBe('plums 4');
  }, 60_000);

  it('in a page imported into this one, whose markup makes the call', async () => {
    const files = new Map<string, string>([
      [
        'ui/main.ui',
        `<import Row from="./row.ui" />
<logic>
let tally = 1
function bump() { tally = tally + 1 }
</logic>
<div>
  ${BUMP}
  <Row />
</div>`,
      ],
      [
        'ui/row.ui',
        `<logic>
function rowLabel() { return "row sees " + tally }
</logic>
<p class="row">{rowLabel()}</p>`,
      ],
    ]);
    const composed = composeBundleSource(files, 'ui/main.ui');
    await mount(composed.source, '.row', {
      importResolver: async (path) => files.get(path) ?? null,
      logicBasePath: composed.logicBasePath,
      preIncludedLogicPaths: composed.preIncludedLogicPaths,
    });
    expect(text('.row')).toBe('row sees 1');
    await click('bump');
    expect(text('.row')).toBe('row sees 2');
  }, 60_000);
});
