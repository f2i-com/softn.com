/**
 * Known ways of getting script into a page, written into a SoftN page and
 * drawn: none may come out as code the browser would run. The corpus leans on
 * how the page is read, which grew: attribute values unquoted
 * (`href=javascript:…`), names in capitals (`<A HREF=…>`, `ONERROR`), and
 * character references HTML5 gives a name, read from the browser's own table
 * (`javascript&colon;`, `jav&Tab;ascript:`), which jsdom has too.
 *
 * What is drawn is read as a browser would read it (references decoded,
 * the tabs and line breaks a URL scheme may hide behind removed, case folded)
 * and searched for what runs: a script URL, an element that runs or embeds,
 * an `on…` attribute, a style that runs.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { ComponentRegistry, renderDocument } from '../src/renderer';
import type { SoftNRenderContext } from '../src/types';

const context = {
  state: { url: 'javascript:alert(1)', dataUrl: 'data:text/html,<script>alert(1)</script>' },
  setState: () => {},
  data: {},
  props: {},
  functions: {},
  asyncFunctions: {},
  computed: {},
} as unknown as SoftNRenderContext;

function drawn(source: string): string {
  const registry = new ComponentRegistry();
  return renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(parse(source), context, registry)));
}

/** Elements a browser runs, embeds or lets change where the page goes. */
const RUNNING_ELEMENTS = new Set(['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'frame', 'frameset', 'applet', 'portal']);

/**
 * What in the drawn markup a browser would run, read as a browser reads it:
 * parsed into elements (so text that only shows `<script>` is text), with
 * every attribute's value decoded, the tabs and line breaks a URL scheme may
 * hide behind removed, and one case.
 */
function runnable(markup: string): string[] {
  const body = new DOMParser().parseFromString(`<!DOCTYPE html><body>${markup}`, 'text/html').body;
  const found: string[] = [];
  for (const element of body.querySelectorAll('*')) {
    if (RUNNING_ELEMENTS.has(element.localName.toLowerCase())) found.push(`<${element.localName}>`);
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      // Without the controls and spaces a browser passes over in a URL's scheme.
      const value = Array.from(attribute.value)
        .filter((char) => char > ' ')
        .join('')
        .toLowerCase();
      if (name.startsWith('on')) found.push(`${name}=`);
      if (name === 'srcdoc') found.push(name);
      if (/(?:^|[\s,])(?:javascript|vbscript):/.test(value) || /^(?:javascript|vbscript):|^data:text\/html/.test(value)) {
        // In a style a script URL is only ever an image a browser will not load.
        if (name !== 'style') found.push(`${name}=${value}`);
      }
    }
  }
  return found;
}

const VECTORS: string[] = [
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<A HREF=JAVASCRIPT:alert(1)>x</A>',
  '<a href=javascript:alert(1)>x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="jav&#x09;ascript:alert(1)">x</a>',
  '<a href="jav&#9;ascript:alert(1)">x</a>',
  '<a href="jav&Tab;ascript:alert(1)">x</a>',
  '<a href="jav&NewLine;ascript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)">x</a>',
  '<a href="javascript&#58;alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="javascript&#x3A;alert(1)">x</a>',
  '<a href="javascript://%0aalert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<a href={url}>x</a>',
  '<a href={dataUrl}>x</a>',
  '<a href={"java" + "script:alert(1)"}>x</a>',
  '<img src=x onerror=alert(1)>',
  '<IMG SRC=x ONERROR=alert(1)>',
  '<img src=x onerror="alert(1)">',
  '<img src="javascript:alert(1)">',
  '<img srcset="javascript:alert(1) 1x">',
  '<input type=image src=javascript:alert(1)>',
  '<video poster=javascript:alert(1)></video>',
  '<details open ontoggle=alert(1)><summary>s</summary></details>',
  '<div onmouseover="alert(1)">x</div>',
  '<svg onload=alert(1)></svg>',
  '<svg><script>alert(1)</script></svg>',
  '<SVG><SCRIPT>alert(1)</SCRIPT></SVG>',
  '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  '<svg><animate attributeName="href" values="javascript:alert(1)" /></svg>',
  '<svg><set attributeName="onmouseover" to="alert(1)" /></svg>',
  '<svg><use href="data:text/html,<script>alert(1)</script>" /></svg>',
  '<svg><![CDATA[<script>alert(1)</script>]]></svg>',
  '<math><a href="javascript:alert(1)">x</a></math>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<IFRAME SRC=javascript:alert(1)></IFRAME>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<form action="javascript:alert(1)"><button>go</button></form>',
  '<button formaction="javascript:alert(1)">go</button>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<base href="javascript:alert(1)//">',
  '<link rel="import" href="javascript:alert(1)">',
  // (CSS's own old ways in, `expression()`, `-moz-binding`, `behavior:` and a
  // script URL as an image, run in no browser SoftN supports; not tested.)
  '<textarea><script>alert(1)</script></textarea>',
  '<title><script>alert(1)</script></title><p>x</p>',
  '<noscript><img src=x onerror=alert(1)></noscript>',
  '<template><img src=x onerror=alert(1)></template>',
  '<div dangerouslySetInnerHTML={{ __html: "<img src=x onerror=alert(1)>" }}>x</div>',
  '<div innerHTML="<img src=x onerror=alert(1)>">x</div>',
  '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
  '<p>{"<script>alert(1)</script>"}</p>',
  '<a href="#" onclick="alert(1)">x</a>',
  '<a href="#" onClick={url}>x</a>',
  '<div is="x-y" style="x">x</div>',
];

describe('a page cannot draw code that runs', () => {
  it.each(VECTORS)('%s', (source) => {
    const markup = drawn(source);
    expect(runnable(markup), markup).toEqual([]);
  });
});
