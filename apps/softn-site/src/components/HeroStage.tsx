import React, { useEffect, useState } from 'react';
import { loadDemoIndex, formatBytes, type Demo } from '../lib/demos';
import { runtimeUrlFor } from '../lib/appUrls';
import './HeroStage.css';

/**
 * The page's first claim, made with the apps themselves, in the hero.
 *
 * Six workloads that have nothing in common but the format: a voiced 3D
 * story, an x86 emulator, a card game, a voxel world, a local language model
 * and a layered image editor. Each is one `.softn` file in the same runtime
 * the directory serves, launched into the same web runtime the Player uses.
 *
 * Nothing runs until the visitor asks. A closed stage holds no iframe and
 * boots no engine; one app runs at a time, and the parent suspends this stage
 * while the source explorer further down has its own runtime open, so the
 * page never carries two. The preview frame denies the camera, the microphone
 * and the rest of the device APIs outright — a demonstration must never raise
 * a permission prompt — and the full runtime opens in its own tab.
 *
 * Apps are matched against the deployment's own demo index rather than a
 * list of invented routes: one this deployment does not ship is labelled as
 * such, not linked to a 404.
 */

interface Feature {
  key: string;
  title: string;
  kind: string;
  detail: string;
  /** Normalised forms of the demo id, name or file this matches. */
  aliases: string[];
}

const FEATURES: Feature[] = [
  {
    key: 'last-sound',
    title: 'Last Sound',
    kind: 'A voiced 3D story',
    detail: 'A fully voiced first-person survey from inside a sealed pressure hull.',
    aliases: ['lastsound', 'lastsound3d'],
  },
  {
    key: 'softdos',
    title: 'SoftDOS',
    kind: 'An x86 PC',
    detail: 'A 386, VGA, BIOS and DOS, written in the same language as everything else here. It runs real programs.',
    aliases: ['softdos'],
  },
  {
    key: 'texas-holdem',
    title: 'Texas Hold’em',
    kind: 'A card game',
    detail: 'Poker against bots, with peer play between people who trust each other. Not adversarially secure online poker yet.',
    aliases: ['texasholdem'],
  },
  {
    key: 'blockscape',
    title: 'Blockscape',
    kind: 'A voxel world',
    detail: 'A first-person world of blocks, chunked and saved, inside a portable app.',
    aliases: ['blockscape'],
  },
  {
    key: 'ai-chat',
    title: 'AI Chat',
    kind: 'A local model',
    detail: 'A small language model that downloads once and runs in your browser. Nothing you type leaves the machine.',
    aliases: ['aichat'],
  },
  {
    key: 'photostudio',
    title: 'PhotoStudio',
    kind: 'An image editor',
    detail: 'A layered image editor with PSD import and export.',
    aliases: ['photostudio'],
  },
];

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The index is the runtime's, but a file name is still a path fragment. */
function safeBundleFile(value: string): boolean {
  return /^[a-z0-9][a-z0-9 ._-]*\.softn$/i.test(value) && !value.includes('..');
}

function findDemo(feature: Feature, demos: Demo[]): Demo | undefined {
  return demos.find(
    (demo) =>
      safeBundleFile(demo.file) &&
      [demo.id, demo.name, demo.file.replace(/\.softn$/i, '')].some(
        (v) => typeof v === 'string' && feature.aliases.includes(normalized(v))
      )
  );
}

/** The icon the runtime extracted beside each bundle at build time. */
function iconFor(demo: Demo): string {
  return `/demos/icons/${demo.file.replace(/\.softn$/i, '')}.svg`;
}

export function HeroStage({
  suspended = false,
  onLaunch,
}: {
  /** True while another runtime on the page is open; the stage closes and stays closed. */
  suspended?: boolean;
  /** Called as an app is launched, so the parent can close that other runtime. */
  onLaunch?: () => void;
}): React.ReactElement {
  const [demos, setDemos] = useState<Demo[]>([]);
  const [selected, setSelected] = useState(FEATURES[0].key);
  const [launched, setLaunched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loadDemoIndex(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setDemos(items);
        // Land on something this deployment can actually run.
        setSelected((key) => {
          const current = FEATURES.find((item) => item.key === key)!;
          if (findDemo(current, items)) return key;
          return FEATURES.find((item) => findDemo(item, items))?.key ?? key;
        });
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError('The demo catalog could not be loaded. The directory below still works.');
        setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    if (suspended) setLaunched(false);
  }, [suspended]);

  const feature = FEATURES.find((item) => item.key === selected)!;
  const demo = findDemo(feature, demos);
  const playing = launched && !suspended && !!demo;

  const choose = (item: Feature): void => {
    setLaunched(false);
    setSelected(item.key);
  };

  return (
    <div className="stage" id="showcase">
      <div className="stage-picker" role="group" aria-label="Choose an app to run">
        {FEATURES.map((item) => {
          const found = findDemo(item, demos);
          const available = loading || !!found;
          return (
            <button
              type="button"
              key={item.key}
              aria-pressed={selected === item.key}
              className={`stage-pick ${selected === item.key ? 'on' : ''} ${available ? '' : 'stage-pick-missing'}`}
              onClick={() => choose(item)}
              title={available ? item.title : `${item.title} is not in this deployment yet`}
            >
              <span className="stage-pick-icon" aria-hidden="true">
                {found ? <img src={iconFor(found)} alt="" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} /> : null}
              </span>
              <span className="stage-pick-body">
                <strong>{item.title}</strong>
                <small>{item.kind}</small>
              </span>
            </button>
          );
        })}
      </div>

      <div className="stage-shell">
        <div className="stage-bar">
          <span className="stage-bar-name">
            {playing && <span className="stage-live" aria-hidden="true" />}
            {feature.title}
            <code>.softn</code>
          </span>
          {playing ? (
            <button type="button" className="stage-close" onClick={() => setLaunched(false)}>
              Close app
            </button>
          ) : (
            <span className="stage-bar-tag">{loading ? 'loading' : demo ? formatBytes(demo.size) : 'not deployed'}</span>
          )}
        </div>

        <div className="stage-screen">
          {playing && demo ? (
            <iframe
              key={demo.file}
              src={runtimeUrlFor(demo.file, { embed: true })}
              title={`${feature.title} running in the SoftN runtime`}
              loading="lazy"
              allow="fullscreen; autoplay; camera 'none'; microphone 'none'; geolocation 'none'; usb 'none'; serial 'none'"
              allowFullScreen
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="stage-intro">
              <span className="stage-watermark" aria-hidden="true">
                .softn
              </span>
              <p className="stage-kind">{feature.kind}</p>
              <h2 className="stage-detail">{feature.detail}</h2>
              {loading ? (
                <p className="stage-note" role="status">
                  Loading the demo catalog…
                </p>
              ) : error ? (
                <div className="stage-note" role="status">
                  <p>{error}</p>
                  <button type="button" className="cta" onClick={() => setAttempt((n) => n + 1)}>
                    Retry
                  </button>
                </div>
              ) : demo ? (
                <div className="stage-actions">
                  <button
                    type="button"
                    className="cta cta-primary stage-launch"
                    onClick={() => {
                      onLaunch?.();
                      setLaunched(true);
                    }}
                  >
                    Launch {feature.title}
                  </button>
                  <a className="stage-full" href={runtimeUrlFor(demo.file)} target="_blank" rel="noopener noreferrer">
                    Open in the full runtime
                  </a>
                </div>
              ) : (
                <p className="stage-note" role="status">
                  This app is not in this deployment’s demo catalog yet. The directory below has the ones that are.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="stage-foot">
          <span>Runs here in the SoftN web runtime. Camera and microphone stay off in this preview.</span>
        </div>
      </div>
    </div>
  );
}
