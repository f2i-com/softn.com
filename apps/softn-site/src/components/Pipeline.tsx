import React from 'react';
import { Reveal } from './Reveal';
import { ZIPP_URL, XDB_URL } from '../lib/appUrls';

interface Stage {
  name: string;
  out: string;
  terminal?: boolean;
}

const UI_PIPE: Stage[] = [
  { name: 'Lexer', out: 'tokens' },
  { name: 'Parser', out: 'AST' },
  { name: 'Renderer', out: 'elements' },
  { name: 'React', out: 'on screen', terminal: true },
];

const LOGIC_PIPE: Stage[] = [
  { name: 'Lexer', out: 'tokens' },
  { name: 'Parser', out: 'AST' },
  { name: 'Compiler', out: 'bytecode' },
  { name: 'zipp VM', out: 'Rust, in WebAssembly', terminal: true },
];

const GUARDS = [
  {
    name: 'No eval, no new Function',
    copy: 'A script reaches nothing the engine preamble does not hand it. There is no path from bundle code to the host page.',
  },
  {
    name: 'A budget, on the server',
    copy: '`softn-server` runs untrusted `.logic` under a step budget it can abort. The browser has no equivalent yet — in a tab, a runaway loop still wedges the app it belongs to.',
  },
  {
    name: 'Bridges, not globals',
    copy: '`window` and `navigator` are purpose-built objects that expose a named list of things. The real ones are not in scope.',
  },
  {
    name: 'One app cannot read another',
    copy: 'Storage is prefixed per app, so two bundles open in two tabs never see each other’s keys.',
  },
  {
    name: 'The archive is not trusted',
    copy: 'Bundle extraction rejects `../`, absolute paths, null bytes and drive letters, and bounds how far a compressed entry may expand.',
  },
];

function Flow({ stages }: { stages: Stage[] }): React.ReactElement {
  return (
    <div className="pipe-flow">
      {stages.map((s, i) => (
        <React.Fragment key={s.name}>
          {i > 0 && (
            <span className="pipe-arrow" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 8h10M9.5 4.5 13 8l-3.5 3.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          )}
          <div className="stage" data-terminal={s.terminal ? 'true' : 'false'}>
            <div className="stage-name">{s.name}</div>
            <div className="stage-out">{s.out}</div>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

export function Pipeline(): React.ReactElement {
  return (
    <Reveal as="section" className="band" id="runtime">
      <div className="wrap">
        <div className="band-head">
          <span className="eyebrow">The runtime</span>
          <h2 className="band-title">What happens between the file and the pixels.</h2>
          <p className="band-sub">
            Two passes, no bundler in the middle. The markup becomes React elements; the logic becomes bytecode for{' '}
            <a href={ZIPP_URL} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline', textUnderlineOffset: '3px' }}>
              zipp
            </a>
            , a register VM written in Rust and compiled to WebAssembly. Before every call the runtime syncs React state
            into the VM&rsquo;s globals, and syncs them back when it returns.
          </p>
        </div>

        <div className="pipes">
          <div className="pipe">
            <div className="pipe-head">
              <span className="pipe-file">ui/main.ui</span>
              <span className="pipe-what">structure, props, control flow</span>
            </div>
            <Flow stages={UI_PIPE} />
          </div>

          <div className="pipe">
            <div className="pipe-head">
              <span className="pipe-file">logic/main.logic</span>
              <span className="pipe-what">real JavaScript — classes, async, closures, regex</span>
            </div>
            <Flow stages={LOGIC_PIPE} />
          </div>
        </div>

        <div className="guards">
          {GUARDS.map((g) => (
            <div key={g.name}>
              <h3 className="guard-name">{g.name}</h3>
              <p className="guard-copy">{renderTicks(g.copy)}</p>
            </div>
          ))}
        </div>

        <p className="band-sub" style={{ marginTop: '2.25rem' }}>
          Data lives in{' '}
          <a href={XDB_URL} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline', textUnderlineOffset: '3px' }}>
            XDB
          </a>
          , which keeps every collection in memory — so reads and writes are synchronous and only sync is awaited. Two
          copies of an app can join a room and converge through CRDTs without a server in between.
        </p>
      </div>
    </Reveal>
  );
}

/** Backticks in the guard copy mark identifiers; render them as code, not as backticks. */
function renderTicks(text: string): React.ReactNode[] {
  return text.split(/`([^`]+)`/g).map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="tok-mark" style={{ fontFamily: 'var(--mono)', fontSize: '0.9em' }}>
        {part}
      </code>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    )
  );
}
