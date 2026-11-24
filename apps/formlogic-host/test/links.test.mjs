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
import { LINK_LIMIT, asParsed, decideLink, letThrough, linkAt, linkKind, outsideAddress, watchLinks } from '../src/links.ts';

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

/**
 * A page with links in it and the frame's watch on it; `acted` is what was carried out, `followed` what the
 * frame did as the browser would have, `queued` what waits for the click's end. `svg`: the frame's own SVG
 * files, by their addresses.
 */
function page(body, { svg = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"><div id="card">${body}</div></div></body></html>`, { url: 'https://frame.test/hosted-runtime/index.html', virtualConsole: new VirtualConsole() });
  const acted = [];
  const followed = [];
  const queued = [];
  let open = true;
  const stop = watchLinks(dom.window, {
    open: () => open,
    decide: (link, event, handled) => decideLink({ ...link, handled, byPerson: true, ownHost: 'frame.test', isPage: written => written.trim() === 'about.html' }),
    act: (action, link) => acted.push({ ...action, written: link.written }),
    follow: link => followed.push(link),
    later: run => queued.push(run),
    svgText: url => svg[url],
  });
  const doc = dom.window.document;
  /**
   * Click the element `id` (left, or middle with `button: 1`), and say whether its default was prevented by the
   * end, as the browser has it (the app is shown its own cancelling alone: the frame's holding is read here).
   */
  const prevented = Object.getOwnPropertyDescriptor(dom.window.Event.prototype, 'defaultPrevented').get;
  const press = (id, { button = 0 } = {}) => {
    const event = new dom.window.MouseEvent(button === 1 ? 'auxclick' : 'click', { bubbles: true, cancelable: true, button });
    doc.getElementById(id).dispatchEvent(event);
    return prevented.call(event);
  };
  const drain = () => { while (queued.length) queued.shift()(); };
  return { dom, doc, acted, followed, queued, press, drain, stop, prevented: event => prevented.call(event), close: () => { open = false; } };
}
const LINKS = '<a id="out" href="https://other.example/?d=1">out</a><a id="page" href="about.html">page</a><a id="nowhere" href="styles.css">css</a><a id="empty" href="">empty</a>';

test('a click on a link is held as it begins and decided once it is over, and the app sees the click as it made it', () => {
  const p = page(LINKS);
  let seenByApp = null;
  p.doc.getElementById('card').addEventListener('click', event => { seenByApp = [event.defaultPrevented, event.returnValue]; });
  assert.equal(p.press('out'), true, 'the frame stays where it is');
  assert.deepEqual(seenByApp, [false, true], 'nothing cancelled the click, as far as the app can tell');
  assert.deepEqual(p.acted, [], 'not yet: the app may point it elsewhere before the click is over');
  p.drain();
  assert.deepEqual(p.acted, [{ kind: 'hand-on', href: 'https://other.example/?d=1', written: 'https://other.example/?d=1' }]);
  // A page of the app, a file that is no page, and no address at all.
  assert.equal(p.press('page'), true);
  assert.equal(p.press('nowhere'), true);
  assert.equal(p.press('empty'), true);
  p.drain();
  assert.deepEqual(p.acted.slice(1).map(a => a.kind), ['show-page', 'keep', 'keep']);
});

test('a click the app stops on its way is held all the same, and carried out once the click is over', () => {
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
  // A middle click asks for a window: held (Chromium and Firefox opened another site's in a tab), and nothing done with it.
  assert.equal(p.press('page', { button: 1 }), true);
  p.drain();
  assert.equal(p.acted.length, 1);
  p.press('out', { button: 1 });
  p.drain();
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
  p.drain();
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
  p.drain();
  assert.deepEqual(p.acted.map(a => [a.kind, a.href]), [['hand-on', 'https://other.example/drawn'], ['hand-on', 'https://other.example/drawn']]);
  assert.equal(p.press('u2'), true, 'several: kept');
  p.drain();
  assert.equal(p.acted[2].kind, 'keep');
  assert.match(p.acted[2].warning, /draws more than one/);
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
  assert.equal(p.prevented(event), true);
  p.drain();
  assert.deepEqual(p.acted.map(a => a.href), ['https://area.example/', 'https://shadow.example/']);
});

// ── A review of 2026-11-15, each case first seen to take a sandboxed frame off its app in Chromium, Firefox and
// WebKit with no watcher in it (a real mouse click, under the frame's own content policy) ──

test('a click the app stops is decided on the link as it is once the click is over: pointed elsewhere after the stop, it is that address the parent is asked about', async () => {
  const ways = {
    'set after the stop': a => { a.href = 'https://other.example/?d=sync'; },
    'set in a microtask (React commits a state change in one, before the browser follows a link)': a => queueMicrotask(() => { a.href = 'https://other.example/?d=sync'; }),
  };
  for (const [way, repoint] of Object.entries(ways)) {
    const p = page('<a id="more" href="#more">More</a>');
    const a = p.doc.getElementById('more');
    a.addEventListener('click', event => { event.stopPropagation(); repoint(a); });
    assert.equal(p.press('more'), true, `${way}: held, though it was a place on the page when it was stopped`);
    await Promise.resolve();
    p.drain();
    assert.deepEqual(p.acted.map(x => [x.kind, x.href]), [['hand-on', 'https://other.example/?d=sync']], way);
    assert.deepEqual(p.followed, [], `${way}: not followed in the frame`);
  }
  // An <a> with no address until the click: held all the same, and decided on the address it then has.
  const q = page('<a id="late">Later</a>');
  const late = q.doc.getElementById('late');
  late.addEventListener('click', event => { event.stopPropagation(); queueMicrotask(() => late.setAttribute('href', 'https://other.example/?d=late')); });
  assert.equal(q.press('late'), true);
  await Promise.resolve();
  q.drain();
  assert.deepEqual(q.acted.map(x => x.href), ['https://other.example/?d=late']);
});

test('a stopped click on a place on the page, or on a file a link saves, is done by the frame as the browser would have, and the app sees the click as it made it', () => {
  const p = page('<a id="top" href="#top">Top</a><a id="save" href="data:text/plain,hi" download="notes.txt">Save</a>');
  const seen = [];
  for (const id of ['top', 'save']) {
    p.doc.getElementById(id).addEventListener('click', event => {
      event.stopPropagation();
      seen.push([event.defaultPrevented, event.returnValue]);
    });
  }
  assert.equal(p.press('top'), true, 'held');
  assert.equal(p.press('save'), true, 'held');
  assert.deepEqual(seen, [[false, true], [false, true]], 'not cancelled, as far as the app can tell');
  p.drain();
  assert.deepEqual(p.followed.map(l => [l.written, l.download, l.saveAs]), [['#top', false, undefined], ['data:text/plain,hi', true, 'notes.txt']]);
  assert.deepEqual(p.acted, []);
  // A middle click on one asks for a window the frame cannot open: nothing is done.
  p.doc.getElementById('top').addEventListener('auxclick', event => event.stopPropagation());
  p.press('top', { button: 1 });
  p.drain();
  assert.equal(p.followed.length, 2);
});

test('a stopped click that can follow no link (an icon in a button or a label) is left to the browser', () => {
  const p = page('<svg width="0" height="0"><defs><path id="tick" d="M0 0L5 5"/></defs></svg><label id="label"><input type="checkbox" id="box"><svg><use id="icon" href="#tick"/></svg></label>');
  p.doc.getElementById('label').addEventListener('click', event => event.stopPropagation());
  assert.equal(p.press('icon'), false, 'the label is still the browser\'s to toggle its box');
  p.drain();
  assert.deepEqual([p.acted, p.followed], [[], []]);
});

test('a link an SVG <use> draws comes before a link that holds it, and where the click was cannot be told, none is followed', () => {
  // <a href="#top"><svg><use href="#a"/></svg></a> went where #a goes, where the frame had decided #top and left it to the browser.
  const p = page('<svg width="0" height="0"><defs><a id="a" href="https://other.example/?d=drawn"><rect width="9" height="9"/></a></defs></svg><a id="outer" href="#top"><svg><use id="u" href="#a"/></svg></a>');
  assert.equal(p.press('u'), true, 'kept');
  p.drain();
  assert.equal(p.acted[0].kind, 'keep');
  assert.match(p.acted[0].warning, /is itself inside a link/);
  // A drawing with no link in it, inside a link, is that link's.
  const q = page('<svg width="0" height="0"><defs><path id="i" d="M0 0L5 5"/></defs></svg><a id="o" href="https://other.example/?d=held"><svg><use id="v" href="#i"/></svg></a>');
  assert.equal(q.press('v'), true);
  q.drain();
  assert.deepEqual(q.acted.map(x => x.href), ['https://other.example/?d=held']);
});

test('what a <use> draws is read from its address as the browser reads it', () => {
  // Each draws #e: the parser drops the spaces and line breaks, a fragment is percent-decoded, and the page's own file is the page.
  for (const href of [' #e', '\n#e', '#%65', 'index.html#e', 'https://frame.test/hosted-runtime/index.html#e']) {
    const p = page(`<svg width="0" height="0"><defs><a id="e" href="https://other.example/?d=e"><rect width="9" height="9"/></a></defs></svg><svg><use id="u"/></svg>`);
    p.doc.getElementById('u').setAttribute('href', href);
    assert.equal(p.press('u'), true, JSON.stringify(href));
    p.drain();
    assert.deepEqual(p.acted.map(x => [x.kind, x.href]), [['hand-on', 'https://other.example/?d=e']], JSON.stringify(href));
  }
  // Another page of the same site is another document, which a frame with an opaque origin does not load: nothing is drawn.
  const q = page('<svg width="0" height="0"><defs><a id="e" href="https://other.example/"><rect width="9" height="9"/></a></defs></svg><svg><use id="u" href="other.html#e"/></svg>');
  assert.equal(q.press('u'), false);
});

test('a <use> of an SVG file of the app\'s: an icon from it is no link, and a link in it is not followed', () => {
  const sprite = '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="star"><path d="M0 0L5 5"/></symbol><a id="go" href="https://other.example/?d=file"><rect width="9" height="9"/></a></svg>';
  const file = 'blob:null/0f4e2a1c';
  // An icon from the file (Firefox draws from a blob: file of the frame's own, and follows a link in it).
  const p = page(`<svg><use id="star" href="${file}#star"/></svg><svg><use id="go" href="${file}#go"/></svg><svg><use id="whole" href="${file}"/></svg>`, { svg: { [file]: sprite } });
  assert.equal(p.press('star'), false, 'an icon: the browser\'s');
  assert.equal(p.press('go'), true, 'a link in the file: kept');
  p.drain();
  assert.equal(p.acted[0].kind, 'keep');
  assert.equal(p.press('whole'), true, 'the whole file, which holds a link: kept');
  // A blob: address the frame did not make cannot be read: kept. An address on the web is not loaded here: nothing is drawn.
  const q = page('<svg><use id="unknown" href="blob:null/ffff#go"/></svg><svg><use id="web" href="https://cdn.example/icons.svg#go"/></svg>');
  assert.equal(q.press('unknown'), true);
  q.drain();
  assert.equal(q.acted[0].kind, 'keep');
  assert.equal(q.press('web'), false);
  // A data: address's own text is read.
  const r = page(`<svg><use id="data" href="data:image/svg+xml,${encodeURIComponent(sprite)}#go"/></svg>`);
  assert.equal(r.press('data'), true);
  r.drain();
  assert.equal(r.acted[0].kind, 'keep');
});

test('a MathML element with an address is a link (WebKit and Firefox follow one); one with none is not', () => {
  const p = page('<math href="https://other.example/?d=math"><mi id="x">x</mi></math><math><mi id="y">y</mi></math>');
  assert.equal(p.press('x'), true);
  assert.equal(p.press('y'), false, 'a formula with no address is the browser\'s');
  p.drain();
  assert.deepEqual(p.acted.map(x => [x.kind, x.href]), [['hand-on', 'https://other.example/?d=math']]);
});

test('an address on the frame\'s own site is not another site\'s, whatever its scheme or port: kept, however it is written', () => {
  for (const href of ['https:/api/apps/1/delete', 'https:api/apps/1/delete', '//site.example/api/apps/1/delete', 'https://site.example/app/other', 'HTTPS://SITE.EXAMPLE:443/x', 'http://site.example/api/apps/1/delete', 'https://site.example:8443/x']) {
    const action = click(href, { ownHost: 'site.example' });
    assert.equal(action.kind, 'keep', href);
    assert.match(action.warning, /goes to the site this app is hosted on/, href);
  }
  assert.equal(click('https://site.example.evil.example/', { ownHost: 'site.example' }).kind, 'hand-on');
  assert.equal(click('https://sub.site.example/', { ownHost: 'site.example' }).kind, 'hand-on', 'another host of the same domain is another site');
  assert.equal(click('mailto:someone@site.example', { ownHost: 'site.example' }).kind, 'hand-on');
  // No host of its own (a frame served from no site): nothing kept for it, mail and phone links among them.
  assert.equal(click('mailto:someone@example.com', { ownHost: '' }).kind, 'hand-on');
  assert.equal(click('https://site.example/x', { ownHost: '' }).kind, 'hand-on');
});

// ── The second review of 2026-11-15, each case seen leaving the frame (or breaking a control) in a browser ──

test('a decoy whose id is a fragment as written hides no link: every element a browser may read it as is looked in', () => {
  // Browsers look up only the decoded id: `#%65` draws #e, where the frame found the plain shape with id "%65" first.
  const p = page('<svg width="0" height="0"><defs><a id="e" href="https://other.example/?d=e"><rect width="9" height="9"/></a><rect id="%65"/><a id="é" href="https://other.example/?d=utf8"><rect width="9" height="9"/></a><rect id="%C3%A9"/></defs></svg><svg><use id="u1" href="#%65"/></svg><svg><use id="u2" href="#é"/></svg>');
  assert.equal(p.press('u1'), true);
  assert.equal(p.press('u2'), true);
  p.drain();
  assert.deepEqual(p.acted.map(x => [x.kind, x.href]), [['hand-on', 'https://other.example/?d=e'], ['hand-on', 'https://other.example/?d=utf8']]);
});

test('what a <use> drew as the click began is its link: drawing another icon in the click changes nothing', () => {
  const body = '<svg width="0" height="0"><defs><a id="e" href="https://other.example/?d=drawn"><rect width="9" height="9"/></a><path id="i" d="M0 0L5 5"/></defs></svg><svg id="s"><use id="u" href="#e"/></svg>';
  for (const stopped of [false, true]) {
    const p = page(body);
    const use = p.doc.getElementById('u');
    // the app draws an icon as the click goes down (a capture handler), and may stop it after
    p.doc.getElementById('s').addEventListener('click', () => use.setAttribute('href', '#i'), true);
    if (stopped) use.addEventListener('click', event => event.stopPropagation());
    assert.equal(p.press('u'), true, `held${stopped ? ', stopped' : ''}`);
    p.drain();
    assert.deepEqual(p.acted.map(x => [x.kind, x.href]), [['hand-on', 'https://other.example/?d=drawn']], stopped ? 'stopped' : 'not stopped');
  }
});

test('a listener of the app\'s on the window, after the document\'s, cannot point a place on the page elsewhere: the click is held from its start', async () => {
  for (const later of ['at once', 'in a microtask']) {
    const p = page('<a id="more" href="#more">More</a><a id="save" href="data:text/plain,x" download>Save</a>');
    const point = a => { a.setAttribute('href', 'https://other.example/?d=late'); a.removeAttribute('download'); };
    p.dom.window.addEventListener('click', event => { const a = event.target; if (later === 'at once') point(a); else queueMicrotask(() => point(a)); });
    assert.equal(p.press('more'), true, later);
    assert.equal(p.press('save'), true, later);
    await Promise.resolve();
    p.drain();
    assert.deepEqual(p.acted.map(x => [x.kind, x.href]), [['hand-on', 'https://other.example/?d=late'], ['hand-on', 'https://other.example/?d=late']], later);
    assert.deepEqual(p.followed, [], `${later}: nothing done as the browser`);
  }
});

test('a click on a control inside a link is the control\'s: a box ticked in a label, a summary opened, a radio with a formula in its label', () => {
  const p = page([
    '<a href="#row"><label id="lab"><input type="checkbox" id="box"> Tick</label></a>',
    '<a><details><summary id="sum">More</summary>Hidden</details></a>',
    '<label><input type="radio" name="r" id="radio"><math><mi id="mi">x</mi></math></label>',
    '<a href="https://other.example/?d=button"><button id="btn" type="button">Go</button></a>',
  ].join(''));
  for (const id of ['lab', 'box', 'sum', 'mi']) {
    p.doc.getElementById(id).addEventListener('click', event => event.stopPropagation());
    assert.equal(p.press(id), false, `${id}: the browser's`);
  }
  // Through a button the browser follows the link that holds it, as it does here.
  assert.equal(p.press('btn'), true);
  p.drain();
  assert.deepEqual(p.acted.map(x => [x.kind, x.href]), [['hand-on', 'https://other.example/?d=button']]);
  assert.deepEqual(p.followed, []);
});

test('the frame\'s own click on a link it makes to save a file is let through to the browser', () => {
  const p = page('<div id="spot"></div>');
  const save = p.doc.createElement('a');
  save.id = 'own';
  save.href = 'data:text/plain,x';
  save.download = 'x.txt';
  letThrough(save);
  p.doc.getElementById('spot').append(save);
  assert.equal(p.press('own'), false);
  p.drain();
  assert.deepEqual([p.acted, p.followed], [[], []]);
});

test('decoy non-interactive <label>, orphan <summary>, and disabled <input> inside <a> cannot bypass link interception', () => {
  const p = page([
    '<a href="https://evil.example/label"><label id="orphan-lab">Click</label></a>',
    '<a href="https://evil.example/sum"><summary id="orphan-sum">Click</summary></a>',
    '<a href="https://evil.example/dis"><input id="dis-inp" type="checkbox" disabled></a>',
  ].join(''));
  assert.equal(p.press('orphan-lab'), true);
  assert.equal(p.press('orphan-sum'), true);
  assert.equal(p.press('dis-inp'), true);
  p.drain();
  assert.deepEqual(
    p.acted.map(x => [x.kind, x.href]),
    [
      ['hand-on', 'https://evil.example/label'],
      ['hand-on', 'https://evil.example/sum'],
      ['hand-on', 'https://evil.example/dis'],
    ]
  );
});

test('trailing-dot FQDN links to ownHost are still kept as same-site', () => {
  assert.equal(click('https://site.example./admin', { ownHost: 'site.example' }).kind, 'keep');
  assert.equal(click('https://SITE.EXAMPLE../api/key', { ownHost: 'site.example.' }).kind, 'keep');
  assert.equal(click('https://other.example./page', { ownHost: 'site.example' }).kind, 'hand-on');
});
