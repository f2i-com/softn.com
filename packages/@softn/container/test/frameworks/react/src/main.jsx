// The app the container's framework tests build with Vite and run as its dist/ folder
// (test/frameworks.test.ts, e2e/tests/web-container-frameworks.spec.ts). Written as an app
// is, for a browser, with nothing in it for SoftN: each part is something a React app of
// any size does, and its Vue twin (../../vue/src/App.vue) shows the same page.
import './index.css';
import markUrl from './mark.svg';
import React, {
  Component, Suspense, createContext, lazy, useContext, useDeferredValue, useEffect, useId, useLayoutEffect,
  useMemo, useReducer, useRef, useState, useSyncExternalStore, startTransition,
} from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';

const Lazy = lazy(() => import('./Lazy.jsx'));
const Counter = createContext(null);

function reducer(state, action) {
  return action.type === 'inc' ? { count: state.count + 1 } : state;
}

class Boundary extends Component {
  constructor(props) { super(props); this.state = { failed: null }; }
  static getDerivedStateFromError(error) { return { failed: error.message }; }
  render() { return this.state.failed ? <p id="caught">Caught: {this.state.failed}</p> : this.props.children; }
}

function Bomb({ armed }) {
  if (armed) throw new Error('boom');
  return <span id="calm">calm</span>;
}

function Count() {
  const { state } = useContext(Counter);
  return <p id="count">Count: {state.count}</p>;
}

const widthStore = {
  subscribe(listener) { window.addEventListener('resize', listener); return () => window.removeEventListener('resize', listener); },
  get() { return window.innerWidth > 0 ? 'wide' : 'none'; },
};

function App() {
  const [state, dispatch] = useReducer(reducer, { count: 0 });
  const [note, setNote] = useState('');
  const [agree, setAgree] = useState(false);
  const [size, setSize] = useState('m');
  const [kind, setKind] = useState('a');
  const [notes, setNotes] = useState('');
  const [draft, setDraft] = useState('');
  const [items, setItems] = useState([{ id: 1, text: 'first' }, { id: 2, text: 'second' }]);
  const [open, setOpen] = useState(false);
  const [showLazy, setShowLazy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [at, setAt] = useState(null);
  const [sprite, setSprite] = useState('loading');
  const [blobUrl, setBlobUrl] = useState('');
  const [focused, setFocused] = useState(false);
  const [data, setData] = useState('loading');
  const [measured, setMeasured] = useState('no');
  const [path, setPath] = useState(location.pathname);
  const nextId = useRef(3);
  const box = useRef(null);
  const scroller = useRef(null);
  const field = useRef(null);
  const fieldId = useId();
  const deferred = useDeferredValue(note);
  const upper = useMemo(() => deferred.toUpperCase(), [deferred]);
  const width = useSyncExternalStore(widthStore.subscribe, widthStore.get);

  useEffect(() => { document.title = 'Count ' + state.count; }, [state.count]);
  useEffect(() => {
    let live = true;
    fetch('/data.json').then((r) => r.json()).then((json) => { if (live) setData(json.greeting); }, (e) => setData('failed: ' + e.message));
    return () => { live = false; };
  }, []);
  useLayoutEffect(() => { if (box.current && typeof box.current.getBoundingClientRect === 'function') setMeasured('yes'); }, []);
  // As a list of messages keeps itself at its end.
  useEffect(() => { scroller.current.scrollTop = scroller.current.scrollHeight; }, []);
  useEffect(() => {
    const image = new Image();
    image.onload = () => setSprite(image.naturalWidth + 'x' + image.naturalHeight);
    image.onerror = () => setSprite('failed');
    image.src = '/dot.png';
    let address = '';
    fetch('/dot.png').then((r) => r.blob()).then((blob) => { address = URL.createObjectURL(blob); setBlobUrl(address); });
    return () => { if (address) URL.revokeObjectURL(address); };
  }, []);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const add = (e) => {
    e.preventDefault();
    if (!draft) return;
    setItems((list) => [...list, { id: nextId.current++, text: draft }]);
    setDraft('');
  };

  return (
    <Counter.Provider value={{ state, dispatch }}>
      <div className={'app' + (agree ? ' agreed' : '')} ref={box} data-kind={kind} aria-label="demo">
        <Count />
        <img id="mark" src={markUrl} alt="" width="8" height="8" />
        <img id="logo" src="/vite.svg" alt="" width="16" height="16" />
        <button id="inc" type="button" onClick={() => dispatch({ type: 'inc' })}>Add</button>
        <button id="dark" type="button" onClick={() => document.documentElement.classList.toggle('dark')}>Dark</button>
        <label htmlFor={fieldId}>Note</label>
        <input id="note" name={fieldId} value={note} onChange={(e) => setNote(e.target.value)} />
        <p id="echo">{upper}</p>
        <input id="agree" type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span id="agreed">{agree ? 'yes' : 'no'}</span>
        <select id="size" value={size} onChange={(e) => setSize(e.target.value)}>
          <option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option>
        </select>
        <span id="chosen">{size}</span>
        <input id="kind-a" type="radio" name="kind" value="a" checked={kind === 'a'} onChange={() => setKind('a')} />
        <input id="kind-b" type="radio" name="kind" value="b" checked={kind === 'b'} onChange={() => setKind('b')} />
        <span id="kind">{kind}</span>
        <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <span id="length">{notes.length}</span>
        <form id="form" onSubmit={add}>
          <input id="new" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button id="push" type="submit">Push</button>
        </form>
        <button id="reverse" type="button" onClick={() => startTransition(() => setItems((list) => [...list].reverse()))}>Reverse</button>
        <ul id="list">
          {items.map((item) => (
            <li key={item.id} className="row">
              <span className="text">{item.text}</span>
              <button className="remove" type="button" onClick={() => setItems((list) => list.filter((it) => it.id !== item.id))}>x</button>
            </li>
          ))}
        </ul>
        <button id="open" type="button" onClick={() => setOpen(true)}>Open</button>
        {open ? createPortal(<div id="modal" role="dialog"><button id="close" type="button" onClick={() => setOpen(false)}>Close</button></div>, document.body) : null}
        <button id="lazy-load" type="button" onClick={() => setShowLazy(true)}>Load</button>
        <Suspense fallback={<p id="waiting">waiting</p>}>{showLazy ? <Lazy /> : null}</Suspense>
        <button id="boom" type="button" onClick={() => setArmed(true)}>Boom</button>
        <Boundary><Bomb armed={armed} /></Boundary>
        <div id="html" dangerouslySetInnerHTML={{ __html: '<b>bold</b> text' }} />
        <svg id="icon" width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red" /></svg>
        <div id="hover" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>hover</div>
        <span id="hovered">{hovered ? 'yes' : 'no'}</span>
        {/* A thing put where the pointer was, as a menu or a tooltip is: fixed, at the click's own coordinates. */}
        <div id="pad" style={{ height: 60, background: 'rgb(238, 238, 238)' }} onClick={(e) => setAt({ x: e.clientX, y: e.clientY })}>pad</div>
        {at ? <div id="marker" style={{ position: 'fixed', left: at.x, top: at.y, width: 6, height: 6, background: 'rgb(255, 0, 0)' }} /> : null}
        <span id="at">{at ? Math.round(at.x) + ',' + Math.round(at.y) : 'none'}</span>
        <input id="focus-me" ref={field} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
        <button id="focus-by-ref" type="button" onClick={() => field.current.focus()}>Focus it</button>
        <span id="focused">{focused ? 'yes' : 'no'}</span>
        <span id="data">{data}</span>
        <span id="measured">{measured}</span>
        <span id="width">{width}</span>
        <button id="go" type="button" onClick={() => { history.pushState({}, '', '/about'); setPath(location.pathname); }}>Go</button>
        {/* As a router's links are: an address to show, and a click the script keeps for itself. */}
        <a id="home-link" href="/" onClick={(e) => { e.preventDefault(); history.pushState({}, '', '/'); window.scrollTo(0, 0); setPath(location.pathname); }}>Home</a>
        <a id="team-link" href="/team" onClick={(e) => { e.preventDefault(); history.pushState({}, '', '/team'); window.scrollTo(0, 0); setPath(location.pathname); }}>Team</a>
        <span id="path">{path}</span>
        <button id="to-end" type="button" onClick={() => { scroller.current.scrollTop = scroller.current.scrollHeight; }}>To the end</button>
        {/* A picture loaded before it is anywhere on the page, and one drawn from bytes the script holds. */}
        <span id="sprite">{sprite}</span>
        {blobUrl ? <img id="from-blob" src={blobUrl} alt="" width="12" height="12" /> : null}
        <button id="to-line" type="button" onClick={() => document.getElementById('line-3').scrollIntoView()}>To line 3</button>
        <div id="scroller" ref={scroller} style={{ height: 120, overflow: 'auto' }}>
          {Array.from({ length: 25 }, (_, i) => <p key={i} id={'line-' + i} className="static">Static line {i}</p>)}
        </div>
      </div>
    </Counter.Provider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
