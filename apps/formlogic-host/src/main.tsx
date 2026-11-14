import React, { Component } from 'react';
import { createRoot } from 'react-dom/client';
import { LoadingIndicator, SoftNWithXDB, XDBStorageNotice, ZIPP_GLUE_EXPORTS, bundlePageAt, composeBundleSource, composePage, configureZippGlue, configureZippTorchSource, configureZippWasmSource, createLiveApp, getXDB, mainPage, parseXDBFile, seedXDBBundleData, zippLanguages, type LiveApp } from '@softn/core';
import { registerRuntimeComponents } from '@softn/components/lazy';
import { ThemeProvider } from '@softn/components/theme';
import { declaredThemeMode } from './appTheme';
import { installAppStorage, storageLimits, STORAGE_LIMITS, STORAGE_PROTOCOL } from './storage';
import { grantedPermissions, type FramePermissions } from './permissions';
import { createBackendQueue, BACKEND_UNREADABLE } from './backendQueue';
import { acceptEngine, acceptZippAddress, acceptZippBytes, bundleLanguages, documentEngines, readyEngines, requireBundleLanguages, requireEngineLanguages, servableEngines, zippIdentities } from './engineInit';
import { createNativeNetFetch } from './nativeFetch';
import { framePolicy, zippDirectory } from './framePolicy';
import { mediaUrl, releaseMedia, sameMedia, textFileUrl } from './media';
import { seedBundledData } from './seed';
import { createUpdater, importsFrom, type ImportResolver } from './update';
import { isOtherPage, linkedPage, startPlace, writePlace } from './place';
import { decideLink, watchLinks } from './links';
import zippSource from '../../../packages/@softn/core/wasm-zipp/SOURCE.json';

// This shell is trusted code, run in an opaque-origin iframe. The parent owns
// authentication and accepts only named action calls for the selected app.
// Which document this is comes first: the policy depends on it, a meta policy
// can be tightened afterwards but never relaxed, and the same list decides what
// `init` is accepted and what `ready` announces. Nothing the parent sends is
// read before this point.
//
// The ZIPP engines are named by the installed release: the web-python build
// is the install itself, and the JavaScript-only web build is its
// `variants.web`, verified against the same SHA256SUMS. A ZIPP id the install
// cannot name (a local engine build has no variant) is neither accepted nor
// announced, by the one filter, so the two lists cannot disagree.
const identities = zippIdentities(zippSource);
const served = servableEngines(documentEngines(document.documentElement.getAttribute('data-softn-logic-engine')), identities);
// Pin all loading to this trusted runtime directory before accepting app source.
const policy = document.createElement('meta');
policy.httpEquiv = 'Content-Security-Policy';
const assets = new URL('./', document.baseURI).href;
policy.content = framePolicy(assets, served);
document.head.appendChild(policy);
// Where a host keeps a ZIPP of its own, the one other folder the policy lets the shell load from.
const zippFolder = zippDirectory(assets);
registerRuntimeComponents();
const root = createRoot(document.getElementById('root')!);
// A wheel while the engine and the app's data load (core's LoadingIndicator). A parent that said
// it would cover the frame until the app is shown (FormLogic's own splash) shows that instead.
root.render(<LoadingIndicator label="Opening app" />);
let started = false;
let port: MessagePort | undefined;
let appStorage: ReturnType<typeof installAppStorage> | undefined;
let terminated = false;
// The app's first page has been drawn, and the parent told so.
let drawn = false;
// A failure to load has been reported: the parent was told the app is not showing.
let failed = false;
// Four calls at a time to the parent, which is the parent's own limit,
// thirty-two waiting behind them. A slot is the parent's until it answers (see
// backendQueue.ts). The parent validates every call on its side.
//
// Thirty-five seconds for an answer, longer than FormLogic gives a native
// app's request on its server (twenty-five): at twenty, a write that committed
// in its last five seconds reached the app as a failure, and an app that tried
// again made it twice.
const CALL_DEADLINE_MS = 35000;
const calls = createBackendQueue({
  post: message => port!.postMessage(message),
  maxInFlight: 4, maxQueued: 32, timeoutMs: CALL_DEADLINE_MS,
});
/**
 * The native app's storage saves, in a lane of their own, where the parent
 * says it takes them apart from its four calls (`init.storageLane`). In the
 * shared lane a screen whose own calls filled the four slots and the
 * thirty-two places behind them had its save refused as busy, and that failed
 * save held the app's imports and restores until it was opened again. Its ids
 * start far past any call's, so a reply names one call in one lane.
 */
let storageCalls: ReturnType<typeof createBackendQueue> | undefined;
const STORAGE_FIRST_ID = 1_000_000_000;
function backendCall(action: string, input: Record<string, unknown>): Promise<unknown> {
  if (!port || terminated) return Promise.resolve({ error: 'The app is not connected to its backend yet.' });
  return calls.call(action, input);
}
function terminate(): void {
  if (terminated) return;
  terminated = true;
  appStorage?.dispose();
  calls.dispose(BACKEND_UNREADABLE);
  storageCalls?.dispose(BACKEND_UNREADABLE);
  port?.close();
  root.unmount();
}
// A page kept in the back/forward cache comes back as it was, port and all;
// only one that is going for good ends (a terminated frame takes no new init).
window.addEventListener('pagehide', event => { if (!event.persisted) terminate(); });
const LOAD_FAILED = 'This app could not be loaded. Check the interface and logic files.';
/** One line the app author can act on; never the stack, never more than a sentence. */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return text.split('\n')[0].slice(0, 300);
}
/**
 * `phase` says whether the app failed to open (`load`: nothing of it is shown) or failed while
 * running (`runtime`: it is still drawn, and its own error shows inside it). A parent that showed
 * "could not load" for every error put that over a working app. `reason` and `phase` are
 * additions to the protocol; a parent that reads only `type` is unaffected.
 */
function reportError(reason: string, phase: 'load' | 'runtime'): void {
  // After a load failure the parent takes the app as not showing, so a newer version is a new frame's to open.
  if (phase === 'load') failed = true;
  port?.postMessage({ type: 'error', reason, phase });
}
/**
 * A newer version of the app's files, handed over while it runs (`formlogic:update` on the port;
 * update.ts has the rules). It is taken where the app stands when it can be, and answered
 * `reopen` when only a new frame can take it: before the app's first page is drawn, after a
 * failure to load has been reported, and once the frame has ended, there is no app to hand it to.
 * Made here, before any app is open, so an update that comes early is answered like any other.
 */
const updates = createUpdater<ReturnType<typeof composeBundleSource>>({
  post: reply => port?.postMessage(reply),
  state: () => terminated ? 'closed' : failed ? 'failed' : drawn ? 'running' : 'opening',
  languages: bundleLanguages, compose: composeBundleSource, mediaUrl, themeOf: declaredThemeMode,
  // Media are blob: addresses (media.ts): a file a version sends again as it was keeps the one the page
  // has, and one no version has is let go of, unless the page was given it.
  sameMedia, releaseMedia,
  // The app's own data files, read with fetch (`fetch('data/levels.json')`) as SoftN Web reads them (media.ts).
  textUrl: textFileUrl,
  // An app showing another of its page files stays on it while a newer version has that page (place.ts).
  hasPage: (files, main, path) => isOtherPage(files, main, path, bundlePageAt),
});
/**
 * The link rules of the page on screen, once the app is open: whether a link names one of its
 * pages, and showing that page. Set by `init`, read by the click listener below.
 */
let pageLinks: { isPage(href: string): boolean; follow(href: string): boolean } | undefined;
/**
 * Every click on a link, decided once by links.ts (after the app's own handlers and core's, or
 * where the app stops the click on its way) and carried out here. A link to the outside goes to the
 * parent; anything that would take the frame off the app is kept from it and said in the console.
 * Listened for from the start, before any of the app's code can listen: the window hears a click
 * first.
 */
watchLinks(window, {
  open: () => !terminated,
  decide: (link, event, handled) => decideLink({
    written: link.written, resolved: link.resolved, download: link.download, unclear: link.unclear,
    handled, byPerson: event.isTrusted,
    isPage: href => pageLinks?.isPage(href) === true,
  }),
  act: (action, link) => {
    if (action.kind === 'hand-on') {
      // Until the app is drawn there is nothing on screen to have clicked; after the frame ends, no one to tell.
      if (port && drawn && !failed) port.postMessage({ type: 'link', href: action.href });
    } else if (action.kind === 'show-page') {
      pageLinks?.follow(link.written);
    } else {
      console.warn(`[SoftN] ${action.warning}`);
    }
  },
  later: run => {
    setTimeout(run, 0);
  },
});
/**
 * What is on screen: the app's main page, or another of its page files after a link to it
 * (`<a href="about.html">`). Another page is the app composed with that page as its main one and
 * run afresh, on the records it has, as SoftN Web and the single-app page show one. Each is a
 * renderer of its own, so each has its own live app to take a newer version of that page.
 */
interface ShownPage {
  /** The page file, by its path in the bundle; null for the main page. */
  file: string | null;
  /** The page as it was composed when it was put on screen. Its later versions go to `live`. */
  composed: ReturnType<typeof composeBundleSource>;
  live: LiveApp;
  /** Where its logic's imports are answered from: the files it was composed from. */
  imports: ImportResolver;
  /** The named page it starts on, where the parent said one (`init.place`). */
  initialState?: Record<string, unknown>;
}
class Boundary extends Component<{ children: React.ReactNode }, { failed: boolean; reason: string }> {
  state = { failed: false, reason: '' };
  static getDerivedStateFromError(error: unknown) { return { failed: true, reason: reasonOf(error) }; }
  // The app is replaced by the message below: it is no longer shown, which is a load failure.
  componentDidCatch(error: unknown) { reportError(reasonOf(error), 'load'); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <p role="alert">{LOAD_FAILED}{this.state.reason ? ` (${this.state.reason})` : ''}</p>;
  }
}
window.addEventListener('message', async event => {
  if (started || terminated || event.source !== parent || event.data?.type !== 'formlogic:init' || !event.ports[0]) return;
  started = true;
  port = event.ports[0];
  if (event.data.storageLane === true) {
    storageCalls = createBackendQueue({
      post: message => port!.postMessage(message),
      // One save at a time, as the storage sends them, and as many waiting as it may hold.
      maxInFlight: 1, maxQueued: STORAGE_LIMITS.outstanding, timeoutMs: STORAGE_LIMITS.deadline,
      firstId: STORAGE_FIRST_ID,
    });
  }
  // What the parent grants, decided before the app opens: a grant changed under a running app
  // restarts its logic, so the parent asks the person first and sends the answer here.
  const framePermissions: FramePermissions = grantedPermissions(event.data.permissions);
  port.onmessage = event => {
    if (event.data?.type === 'formlogic:dispose') { terminate(); return; }
    // A newer version of the app, told apart by its type before anything is read as an answer:
    // its id is the parent's own, and may be a number one of the frame's calls has.
    if (event.data?.type === 'formlogic:update') { updates.receive(event.data); return; }
    if (!calls.settle(event.data?.id, event.data?.result)) storageCalls?.settle(event.data?.id, event.data?.result);
  };
  // A result the port could not deserialise names no id: nothing in flight
  // can be told apart, so all of it answers now rather than at its deadline.
  // The app goes on: an acknowledged (protocol 1) storage write sent before it
  // is marked unknown, which holds later ones back, so nothing is claimed
  // saved that may not be.
  port.onmessageerror = () => { calls.failInFlight(BACKEND_UNREADABLE); storageCalls?.failInFlight(BACKEND_UNREADABLE); };
  try {
    // The app's code runs in this document, so what keeps it off this site's origin is the frame's
    // sandbox. Framed without one, by a page or a server that left it out, nothing of the app runs.
    if (self.origin !== 'null') throw new Error('Apps run only in a sandboxed frame with an opaque origin');
    // `engine` is an addition: absent means the engine this document has always
    // run, so a FormLogic that predates the choice is unaffected. One it does
    // not serve is refused by name, never quietly replaced.
    const engine = acceptEngine(event.data.engine, served);
    const files = new Map<string, string>(Object.entries(event.data.client));
    // What this app's logic is written in, from its client file names, and the
    // engine held to it before anything is configured. Neither `zipp-web` nor
    // `host-js` can execute Python at all, and configuring an engine is a
    // one-way door — `configureLogicEngine` and `configureZippWasmSource` both
    // freeze — so the refusal has to come first or it comes too late.
    const languages = bundleLanguages(files.keys());
    requireBundleLanguages(engine, languages);
    if (engine === 'host-js') {
      // Host JavaScript is this document's own engine, so there are no engine
      // bytes to accept and nothing to ask what it can run. The host entry —
      // not this module — checks that the document really is the host one and
      // that the frame really has the opaque origin the shell is only safe in,
      // and configures the engine before anything renders. It is imported here
      // rather than at the top so the adapter is in a chunk of its own that
      // `index.html` never loads.
      const { installHostJsEngine } = await import('./hostEngine');
      if (terminated) return;
      installHostJsEngine();
    } else {
      // A host that serves a ZIPP of its own (v0.0.36 on) names that ZIPP's glue, and its torch
      // package, in the site's ZIPP folder, beside the engine bytes of the same ZIPP: the shell
      // runs that pair, so the host can take a ZIPP newer than this runtime was built with. The
      // glue is checked against its digest before it is imported, and refused when it lacks a
      // name core calls (zipp-glue.ts). A host that names none gets the glue built in, as before,
      // and has to send this runtime's own engine.
      if (event.data.zippGlue !== undefined) {
        configureZippGlue(acceptZippAddress(event.data.zippGlue, zippFolder, 'glue'));
        if (event.data.zippTorch !== undefined) configureZippTorchSource(acceptZippAddress(event.data.zippTorch, zippFolder, 'torch'));
      }
      configureZippWasmSource(acceptZippBytes(event.data.zippWasm));
      // Ask the engine that actually loaded what it can run, before any app code
      // does. ZIPP's builds share one glue, so the id the parent named and the
      // bytes it sent are only known to agree once the engine answers — and
      // they must agree exactly: `zipp-web` is the build that runs JavaScript
      // and nothing else, and the Python build posted under that name is
      // refused as firmly as the reverse.
      requireEngineLanguages(engine, await zippLanguages());
    }
    if (terminated) return;
    // The manifest the app runs by: the one it opened with, then that of each update it takes.
    let manifest = JSON.parse(files.get('manifest.json') || '{}');
    // What the app's tree is drawn from, read out of `init` once. The tree can be drawn again (an
    // update that brings other media), and a drawing that held the message itself would hold the
    // app's files, its media and the engine's bytes for as long as the frame lives.
    const appId = event.data.appId;
    const dark = event.data.dark === true;
    // Set for a native app; undefined otherwise, where `softn.net.fetch` is
    // refused like every other permission.
    let netFetchHandler: ReturnType<typeof createNativeNetFetch> | undefined;
    if (event.data.native === true) {
      const lane = storageCalls ?? calls;
      appStorage = installAppStorage(event.data.storage || {}, (input, lifecycle) => lane.call('nativeStorage', input, lifecycle), {
        acknowledged: event.data.storageProtocol === STORAGE_PROTOCOL,
        // An addition: a parent that keeps the store somewhere larger says how much it takes.
        limits: storageLimits(event.data.storageLimits),
      });
      // The app's source is left as it came. Its declared API origin is routed
      // by the trusted parent to this app's native backend, without direct
      // egress, from the first line of logic that runs (nativeFetch.ts).
      netFetchHandler = createNativeNetFetch(backendCall);
    }
    // Where a parent confirms saves, a refused one is news. Any other frame keeps its records in
    // memory by design: told so in red, every app it opens looks broken before it has saved a thing.
    const savesAcknowledged = appStorage?.acknowledgedPersistence.protocol === 1;
    // Each media file as it came, base64 text or bytes (ready's mediaBytes: 1), served as a blob: address (media.ts).
    const media = new Map<string, string>();
    for (const [path, value] of Object.entries(event.data.assets || {})) {
      const url = mediaUrl(path, value);
      if (url) media.set(path, url);
    }
    // The main page, composed whatever page the app starts on: an app that cannot open at its main
    // page fails to load in the same words wherever its parent says it was.
    let first = composeBundleSource(files, manifest.main, manifest.files?.logic || []);
    // Where the parent says the app was (`init.place`, an addition; place.ts): another of its page
    // files, a named page inside one, or both. It is text from an address anyone can write, so it
    // is held to this app's own files, and what is not a place of this app is its main page. A
    // parent that sends none opens the app where it always did.
    let start = startPlace(event.data.place, files, mainPage(files), bundlePageAt);
    if (start.file !== null) {
      try {
        first = composePage(files, start.file);
      } catch (problem) {
        console.warn(`[SoftN] ${start.file} cannot be shown: ${reasonOf(problem)}`);
        start = { file: null, section: null };
      }
    }
    // The records the app ships with, added once, before it first draws (seed.ts). An update adds none.
    const seeding = await seedBundledData(files, manifest, getXDB(appId), parseXDBFile, seedXDBBundleData, () => !terminated);
    if (terminated) return;
    for (const warning of seeding.warnings) console.warn(`[SoftN] ${warning}`);
    // The page on screen, as something to hand a newer version of (core's createLiveApp). The
    // version a page opens with reaches the renderer as it always has, in the props below, which
    // never change after; each later one goes through its `live.update`, which changes as little
    // of the running app as it must and answers what became of it (update.ts sends that to the
    // parent). The logic's imports are answered from the files of the version it belongs to: these
    // for the one the app opens with, and each update's own for that update (update.ts).
    let shown: ShownPage = {
      file: start.file, composed: first, live: createLiveApp(), imports: importsFrom(files),
      // As SoftN Web starts an app on a named page: the state NavItem's `page` sets.
      initialState: start.section === null ? undefined : { currentPage: start.section },
    };
    // The named page inside it: the one the parent named, then whatever the renderer reports.
    let section = start.section;
    // Where the app is, told to the parent once its first page is shown and then whenever it is
    // somewhere else: `{ type: 'place', place }`, one string the parent may keep in its address
    // bar and send back as `init.place` (place.ts). Never told twice running.
    let told: string | undefined;
    const tellPlace = () => {
      if (!drawn || failed || terminated) return;
      const place = writePlace({ file: shown.file, section });
      if (place === told) return;
      told = place;
      port?.postMessage({ type: 'place', place });
    };
    // Drawn once to open the app, again for each page of it a link goes to, and again when an
    // update brings other media or another declared theme: nothing else of this tree changes, and
    // the page inside it is not started again by a drawing that shows the same page.
    const draw = () => {
      if (terminated) return;
      // The media is read from the version the app has now. A new reader for each drawing, because
      // the page asks for its media again only when it is handed another one.
      const resolveAsset = (path: string) => updates.asset(path);
      // The page this drawing shows. What a renderer says of its named page is the app's place
      // only while that page is the one on screen: one being taken down may still say.
      const page = shown;
      const { composed, live } = page;
      // A bundle's permission.json cannot enable arbitrary network, hardware or sync access: the
      // parent grants what it grants (permissions.ts), files at most.
      // FormLogic's own theme, and the side the project declares, which wins over it (appTheme.ts).
      root.render(<Boundary><ThemeProvider defaultDarkMode={dark} declaredMode={declaredThemeMode(manifest)}>
        {savesAcknowledged && <XDBStorageNotice appId={appId} problemsOnly />}
        <SoftNWithXDB {...composed} app={live} appId={appId} resumeSavedSyncRoom={false}
          // Another page file is another run of the app (the key), on the same records. A link
          // to one is shown here (followLink), and the page's own code goes to one of the app's
          // pages or nowhere (pagesOnly): any other address the frame went to was FormLogic's own
          // page, which refuses to be framed, and the app went blank.
          key={page.file ?? ''} onLink={followLink} pagesOnly
          initialState={page.initialState}
          onPageChange={name => { if (shown === page) { section = name; tellPlace(); } }}
          permissionConfig={framePermissions} scriptExecutionMode="main"
          assetResolver={resolveAsset} functions={{asset: (...args: unknown[]) => resolveAsset(String(args[0] ?? ""))}}
          backendCall={backendCall} netFetchHandler={netFetchHandler}
          importResolver={page.imports}
          // Before its first page is drawn the app has not opened; after it, it is drawn and
          // what went wrong shows inside it.
          // shown: the app's first page is on screen, so a parent covering the frame while it opens
          // (ready's shown: 1) uncovers it. A failure to load is reported instead (error).
          // place: where it is, told after shown and not again until it is somewhere else.
          onLoad={() => { if (!drawn) port?.postMessage({ type: 'shown' }); drawn = true; tellPlace(); }}
          onError={error => reportError(reasonOf(error), drawn ? 'runtime' : 'load')} />
      </ThemeProvider></Boundary>);
    };
    // Puts a page of the app on screen: a new run of it with a live app of its own, and no named
    // page inside it until its renderer reports one.
    const show = (file: string | null, composed: ShownPage['composed'], imports: ImportResolver) => {
      shown = { file, composed, live: createLiveApp(), imports };
      section = null;
      draw();
      tellPlace();
    };
    // A link on the page showing, asked by the renderer (onLink). True for a link to a page of the
    // app, which is shown here, composed from the files of the version on screen; false leaves the
    // link to the browser, as every link was (place.ts decides, as SoftN Web's AppRunner does, by
    // core's bundlePageAt and composePage).
    const followLink = (href: string): boolean => {
      if (terminated) return false;
      const text = updates.files();
      const main = mainPage(text);
      const linked = linkedPage(text, main, shown.file, href, bundlePageAt);
      if (linked === null || main === null) return false;
      if (linked.showing) return true;
      const path = linked.file ?? main;
      let composed: ShownPage['composed'];
      try {
        composed = composePage(text, path);
      } catch (problem) {
        console.warn(`[SoftN] ${path} cannot be shown: ${reasonOf(problem)}`);
        return false;
      }
      show(linked.file, composed, importsFrom(text));
      return true;
    };
    pageLinks = {
      isPage: href => linkedPage(updates.files(), mainPage(updates.files()), shown.file, href, bundlePageAt) !== null,
      follow: followLink,
    };
    updates.open({
      files, media,
      // A newer version goes to the page on screen, composed with that page (update.ts).
      update: revision => shown.live.update(revision),
      redraw: next => { manifest = next; draw(); },
      page: () => shown.file,
      // A version without the page on screen: the app is opened at its main page from it.
      leave: revision => show(null, revision, revision.importResolver),
    });
    draw();
  } catch (error) {
    if (terminated) return;
    const reason = reasonOf(error);
    root.render(<p role="alert" style={{ padding: 24 }}>{LOAD_FAILED}{reason ? ` (${reason})` : ''}</p>);
    reportError(reason, 'load');
  }
});
// `zipp` is the primary engine's identity, exactly what it has always been:
// FormLogic compares version and sha256; release is an addition, and optional
// because a local engine build (--install-local) records none.
// engines is an addition too: the engine ids this document will accept in
// `init.engine`, each with the bytes it wants — the same record with the
// variant's digest for `zipp-web`, `true` where it wants none. A parent that
// reads only `zipp` and sends no `engine` sees what it always did, which on
// this document's other entry is a refusal by name.
// shown: 1 is an addition: this document posts shown on its port when the app's first page is
// drawn, so a parent may cover the frame until then; one that never sees it never waits for it.
// zippGlue: 1 is an addition (v0.0.36): this document runs a host's own ZIPP, whose glue and torch
// package `init` names in the site's ZIPP folder (zippGlue, zippTorch), so a parent need not send
// the engine `zipp` names. zippGlueExports is what that glue must export, which the shell checks
// when it loads it; a parent can hold its ZIPP to the same list before it offers it.
// update: 1 is an addition: once the app is shown, this document takes a newer version of its files
// on the port (`formlogic:update`) and answers what became of it (`updated`), so a parent need not
// make a new frame for every change. One that never sends an update sees nothing different.
// places: 1 is an addition: this document shows the app's other page files itself when a link goes
// to one, posts where the app is on its port (`{ type: 'place', place }`, after shown and whenever
// it changes), and opens the app at the `place` an `init` carries (place.ts). A parent that sends
// none and reads none sees an app whose links to its own pages work, and nothing else different.
// links: 1 is an addition: no link the person clicks takes this document off the app any more. A link
// to another site, a mail address or a phone number is posted on the port, `{ type: 'link', href }`
// (absolute, checked by links.ts), for the parent to open or offer; anything else that is no page of
// the app stays where it is, said in the console. A parent that reads none sees such a link do nothing,
// where it used to lose the app.
// mediaBytes: 1 is an addition: this document takes each of the app's media files as bytes (a
// Uint8Array or an ArrayBuffer) as well as base64 text, in `init.assets` and in an update's `assets`,
// file by file, so a parent need not turn its files into text and back. Either way the page is given
// `blob:` addresses (media.ts). A parent that reads none sends text, which works as it always did.
parent.postMessage({ type: 'formlogic:ready', nativeProtocol: 1, storageProtocol: STORAGE_PROTOCOL, zipp: identities['zipp-web-python'], engines: readyEngines(served, identities), shown: 1, zippGlue: 1, zippGlueExports: ZIPP_GLUE_EXPORTS, update: 1, places: 1, links: 1, mediaBytes: 1 }, '*');
