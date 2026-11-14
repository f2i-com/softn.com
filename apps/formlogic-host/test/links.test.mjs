// node --test apps/formlogic-host/test/links.test.mjs
// (Node 24 runs the TypeScript modules directly; they use only erasable syntax.)
//
// What a link the person clicks does in a frame that cannot go anywhere itself (links.ts). Every
// link that left the app's own pages used to take the frame off the app: a link to another site,
// to a mail address, to a file of the app's that is not a page, to `/` or a folder. Each case
// below was clicked in a browser on an app hosted by FormLogic before this was written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { LINK_LIMIT, asParsed, decideLink, linkAt, linkKind, outsideAddress, watchLinks } from '../src/links.ts';

const FRAME = 'https://site.example/hosted-runtime/index.html';
const PAGES = new Set(['about.html', 'docs/guide.html', 'index.html']);
/** A click as the frame's listener reads it: written as `href`, read by the browser against the frame's address. */
const click = (href, more = {}) => decideLink({
  written: href,
  resolved: (() => { try { return new URL(href, FRAME).href; } catch { return href; } })(),
  download: false, handled: false, byPerson: true,
  isPage: written => PAGES.has(written.trim().replace(/^\.\//, '').split(/[?#]/)[0]),
  ...more,
});

test('what a link is, by what is written in it', () => {
  for (const href of ['https://example.com/', 'http://example.com', 'HTTPS://Example.com/a', '//cdn.example.com/x', 'mailto:someone@example.com', 'tel:+61400000000', ' https://example.com ']) {
    assert.equal(linkKind(href), 'outside', href);
  }
  for (const href of ['#top', '#']) assert.equal(linkKind(href), 'fragment', JSON.stringify(href));
  // No address at all is the frame's own address: following it loads the frame again.
  for (const href of ['', '   ']) assert.equal(linkKind(href), 'empty', JSON.stringify(href));
  for (const href of ['data:text/html,<p>x', 'blob:null/1234', 'DATA:image/png;base64,AA']) assert.equal(linkKind(href), 'inline', href);
  for (const href of ['about.html', 'about', '/', './', 'docs/', '?tab=2', 'styles.css', 'assets/dot.png', '../about.html', 'docs\\guide.html']) {
    assert.equal(linkKind(href), 'own', href);
  }
  for (const href of ['javascript:void(0)', 'file:///C:/x', 'ftp://example.com/x', 'intent://scan']) assert.equal(linkKind(href), 'other', href);
});

test('an address is read as the browser\'s parser reads it: what it drops around it and in it, and nothing more', () => {
  // The parser drops spaces and control characters around an address, and tabs and line breaks in it.
  for (const href of [' #top', '\t#top\n', '#t\no\tp', '\u0000#top']) assert.equal(linkKind(href), 'fragment', JSON.stringify(href));
  assert.equal(asParsed(' \thttps://exa\nmple.com/ \r'), 'https://example.com/');
  // It keeps a no-break space, U+3000, U+FEFF and U+2028, which trim() took: "&nbsp;#top" was left to the browser as a place on
  // the page, and the browser went to the address %C2%A0#top, off the app.
  for (const href of [' #top', '　#top', '﻿#top', ' #top']) {
    assert.equal(linkKind(href), 'own', JSON.stringify(href));
    assert.equal(click(href).kind, 'keep', JSON.stringify(href));
  }
});

test('a link to another site, a mail address or a phone number is handed to the parent, absolute', () => {
  assert.deepEqual(click('https://example.com/a?b=1#c'), { kind: 'hand-on', href: 'https://example.com/a?b=1#c' });
  assert.deepEqual(click('//cdn.example.com/x'), { kind: 'hand-on', href: 'https://cdn.example.com/x' }, 'read against the frame\'s own scheme');
  assert.deepEqual(click('mailto:someone@example.com?subject=Hi'), { kind: 'hand-on', href: 'mailto:someone@example.com?subject=Hi' });
  assert.deepEqual(click('tel:+61400000000'), { kind: 'hand-on', href: 'tel:+61400000000' });
  // With a target or a download, as it was clicked: the frame can open no window, so the parent is asked either way.
  assert.equal(click('https://example.com/', { download: true }).kind, 'hand-on');
});

test('only a link the person clicked goes elsewhere: the page\'s code calling click() does not', () => {
  const action = click('https://example.com/', { byPerson: false });
  assert.equal(action.kind, 'keep');
  assert.match(action.warning, /only a link the person clicks goes to another site/);
});

test('an outside address that could mislead, or is no address, is kept and said', () => {
  // A name and password before the host, so that one site's address reads as another's.
  assert.equal(click('https://bank.example.com@evil.example/').kind, 'keep');
  assert.equal(click('https://user:pass@example.com/').kind, 'keep');
  assert.equal(click('mailto:').kind, 'keep');
  assert.equal(click(`https://example.com/${'a'.repeat(LINK_LIMIT)}`).kind, 'keep', 'longer than a parent keeps');
  assert.equal(outsideAddress('https://example.com/\u0007'), null, 'a character a person cannot see');
  assert.equal(outsideAddress('javascript:alert(1)'), null);
  assert.equal(outsideAddress('not an address'), null);
  assert.equal(outsideAddress('https://example.com/'), 'https://example.com/');
});

test('a link already dealt with, or to a place on the same page, is the browser\'s', () => {
  assert.deepEqual(click('about.html', { handled: true }), { kind: 'browser' }, 'core showed the page and cancelled the click');
  assert.deepEqual(click('https://example.com/', { handled: true }), { kind: 'browser' }, 'the app\'s own handler took it');
  assert.deepEqual(click('#top'), { kind: 'browser' });
});

test('a link to a page of the app that core left to the browser (a target, a key held) is shown in place', () => {
  assert.deepEqual(click('about.html'), { kind: 'show-page' });
  assert.deepEqual(click('./docs/guide.html#team'), { kind: 'show-page' });
});

test('a link that names no page of the app keeps the frame on the app, and says why in the console', () => {
  for (const href of ['missing.html', 'about', '/', './', 'docs/', '?tab=2', 'styles.css', 'assets/dot.png']) {
    const action = click(href);
    assert.equal(action.kind, 'keep', href);
    assert.match(action.warning, /names no page of this app, so it was not followed/, href);
  }
  // A control character in the address is not written to the console as it is.
  assert.doesNotMatch(click('a\u0000b').warning, /\u0000/);
});

test('a data: or blob: link would replace the app: kept, unless it downloads', () => {
  const kept = click('data:text/html,<h1>x</h1>');
  assert.equal(kept.kind, 'keep');
  assert.match(kept.warning, /data: address would replace the app/);
  assert.match(click('blob:null/1234').warning, /blob: address would replace the app/);
  assert.deepEqual(click('data:image/png;base64,AA', { download: true }), { kind: 'browser' });
});

test('any other scheme is kept', () => {
  for (const href of ['javascript:void(0)', 'file:///C:/x', 'ftp://example.com/x']) assert.equal(click(href).kind, 'keep', href);
});

test('an empty address is kept, and said', () => {
  const action = click('');
  assert.equal(action.kind, 'keep');
  assert.match(action.warning, /empty address would load the frame again/);
});

// ── Clicks on real elements (jsdom): every click on a link is decided once, also one the app stops ──
// jsdom goes nowhere when a link is followed, so that the frame stays where it is is seen here as a
// click whose default was prevented by the time its dispatch is over.

/** A page with links in it and the frame's watch on it; `acted` is what was carried out, `queued` what waits for the click's end. */
function page(body) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"><div id="card">${body}</div></div></body></html>`, { url: 'https://frame.test/hosted-runtime/index.html', virtualConsole: new VirtualConsole() });
  const acted = [];
  const queued = [];
  let open = true;
  const stop = watchLinks(dom.window, {
    open: () => open,
    decide: (link, event, handled) => decideLink({ ...link, handled, byPerson: true, isPage: written => written.trim() === 'about.html' }),
    act: (action, link) => acted.push({ ...action, written: link.written }),
    later: run => queued.push(run),
  });
  const doc = dom.window.document;
  /** Click the element `id` (left, or middle with `button: 1`), and say whether its default was prevented by the end. */
  const press = (id, { button = 0 } = {}) => {
    const event = new dom.window.MouseEvent(button === 1 ? 'auxclick' : 'click', { bubbles: true, cancelable: true, button });
    doc.getElementById(id).dispatchEvent(event);
    return event.defaultPrevented;
  };
  const drain = () => { while (queued.length) queued.shift()(); };
  return { dom, doc, acted, queued, press, drain, stop, close: () => { open = false; } };
}
const LINKS = '<a id="out" href="https://other.example/?d=1">out</a><a id="page" href="about.html">page</a><a id="nowhere" href="styles.css">css</a><a id="empty" href="">empty</a>';

test('a click no one stops is decided on the document, after the app\'s own handlers, and the app sees the click as it made it', () => {
  const p = page(LINKS);
  let seenByApp = null;
  p.doc.getElementById('card').addEventListener('click', event => { seenByApp = event.defaultPrevented; });
  assert.equal(p.press('out'), true, 'the frame stays where it is');
  assert.equal(seenByApp, false, 'nothing cancelled the click before the app saw it');
  assert.deepEqual(p.acted, [{ kind: 'hand-on', href: 'https://other.example/?d=1', written: 'https://other.example/?d=1' }]);
  assert.equal(p.queued.length, 0, 'carried out at once');
  // A page of the app, a file that is no page, and no address at all.
  assert.equal(p.press('page'), true);
  assert.equal(p.press('nowhere'), true);
  assert.equal(p.press('empty'), true);
  assert.deepEqual(p.acted.slice(1).map(a => a.kind), ['show-page', 'keep', 'keep']);
});

test('a click the app stops on its way is decided where it is stopped, and carried out once the click is over', () => {
  const ways = {
    'stopPropagation on the way up (a component, @click.stop)': (doc) => doc.getElementById('card').addEventListener('click', event => event.stopPropagation()),
    'stopPropagation on the way down (a page\'s code)': (doc) => doc.addEventListener('click', event => event.stopPropagation(), true),
    'stopImmediatePropagation': (doc) => doc.getElementById('root').addEventListener('click', event => event.stopImmediatePropagation()),
    'cancelBubble': (doc) => doc.getElementById('card').addEventListener('click', event => { event.cancelBubble = true; }),
  };
  for (const [way, stopIt] of Object.entries(ways)) {
    const p = page(LINKS);
    stopIt(p.doc);
    assert.equal(p.press('out'), true, `${way}: the frame does not follow it`);
    assert.deepEqual(p.acted, [], `${way}: not yet`);
    p.drain();
    assert.deepEqual(p.acted, [{ kind: 'hand-on', href: 'https://other.example/?d=1', written: 'https://other.example/?d=1' }], way);
    // A page of the app is shown in place the same way, and a link to nowhere kept.
    assert.equal(p.press('page'), true, `${way}: page`);
    assert.equal(p.press('nowhere'), true, `${way}: nowhere`);
    p.drain();
    assert.deepEqual(p.acted.slice(1).map(a => a.kind), ['show-page', 'keep'], way);
  }
});

test('a click the app cancels is the app\'s, whether before or after it stops it', () => {
  for (const order of ['cancel then stop', 'stop then cancel', 'stop then returnValue false', 'cancel only']) {
    const p = page(LINKS);
    p.doc.getElementById('card').addEventListener('click', event => {
      if (order === 'cancel then stop') { event.preventDefault(); event.stopPropagation(); }
      if (order === 'stop then cancel') { event.stopPropagation(); event.preventDefault(); }
      if (order === 'stop then returnValue false') { event.stopPropagation(); event.returnValue = false; }
      if (order === 'cancel only') event.preventDefault();
    });
    assert.equal(p.press('out'), true, order);
    p.drain();
    assert.deepEqual(p.acted, [], `${order}: the frame does nothing more with it`);
  }
});

test('each click is decided once, a middle click only for a link to the outside, and nothing once the frame has ended', () => {
  const p = page(LINKS);
  p.press('out');
  p.drain();
  assert.equal(p.acted.length, 1);
  assert.equal(p.press('page', { button: 1 }), false, 'a middle click on a page of the app is the browser\'s (it opens no window here)');
  p.press('out', { button: 1 });
  assert.equal(p.acted.length, 2);
  assert.equal(p.acted[1].kind, 'hand-on');
  p.close();
  assert.equal(p.press('out'), false);
  assert.equal(p.acted.length, 2);
  // Listening stops when asked.
  const q = page(LINKS);
  q.stop();
  assert.equal(q.press('out'), false);
  assert.deepEqual(q.acted, []);
});

test('an SVG link is a link, with its address in href or xlink:href', () => {
  const p = page('<svg><a id="svg" href="https://other.example/svg"><text id="svgtext">s</text></a><a id="old"><text>o</text></a></svg>');
  p.doc.getElementById('old').setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', 'https://other.example/old');
  assert.equal(p.press('svgtext'), true);
  assert.equal(p.press('old'), true);
  assert.deepEqual(p.acted.map(a => a.href), ['https://other.example/svg', 'https://other.example/old']);
  // A click on what a link holds is a click on the link; an `a` with no address is no link.
  const q = page('<a id="wrapped" href="https://other.example/wrapped"><span id="inside">x</span></a><a id="bare"><span id="bareinside">y</span></a>');
  const found = id => {
    let got;
    const look = e => { got = linkAt(e); };
    q.doc.addEventListener('click', look, true);
    q.doc.getElementById(id).dispatchEvent(new q.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    q.doc.removeEventListener('click', look, true);
    return got;
  };
  assert.deepEqual(found('inside'), { written: 'https://other.example/wrapped', resolved: 'https://other.example/wrapped', download: false });
  assert.equal(found('bareinside'), null);
});

test('a link an SVG <use> draws is the link it draws; where it draws several, none is followed', () => {
  // The copy a <use> makes is in a shadow tree the click's path does not reach, and the browser followed its link off the app.
  const p = page([
    '<svg>',
    '<defs><a id="one" href="https://other.example/drawn"><rect width="5" height="5"/></a>',
    '<g id="two"><a href="https://a.example/">a</a><a href="https://b.example/">b</a></g>',
    '<g id="outer"><use href="#one"/></g>',
    '<g id="plain"><rect width="5" height="5"/></g></defs>',
    '<use id="u1" href="#one"/><use id="u2" href="#two"/><use id="u3" href="#outer"/><use id="u4" href="#plain"/><use id="u5" href="#u5"/>',
    '</svg>',
  ].join(''));
  assert.equal(p.press('u1'), true, 'one link: the frame stays');
  assert.equal(p.press('u3'), true, 'one link, drawn by a <use> in what it draws');
  assert.deepEqual(p.acted.map(a => [a.kind, a.href]), [['hand-on', 'https://other.example/drawn'], ['hand-on', 'https://other.example/drawn']]);
  assert.equal(p.press('u2'), true, 'several: kept');
  assert.equal(p.acted[2].kind, 'keep');
  assert.match(p.acted[2].warning, /draws more than one link/);
  assert.equal(p.press('u4'), false, 'a drawing with no link in it is no link');
  assert.equal(p.press('u5'), false, 'a <use> that draws itself draws nothing (a browser draws no loop)');
});

test('an <area> of an image map, and a link in an open shadow root, are links', () => {
  const p = page('<map name="m"><area id="ar" href="https://area.example/" shape="rect" coords="0,0,10,10"></map><img usemap="#m" alt=""><div id="host"></div>');
  assert.equal(p.press('ar'), true);
  const root = p.doc.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<a id="sh" href="https://shadow.example/"><span id="in">s</span></a>';
  // (a person's click crosses the shadow root: composed)
  const event = new p.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
  root.getElementById('in').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(p.acted.map(a => a.href), ['https://area.example/', 'https://shadow.example/']);
});