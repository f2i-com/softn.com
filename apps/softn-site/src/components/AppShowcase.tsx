import React, { useEffect, useState } from 'react';
import { loadDemoIndex, formatBytes, type Demo } from '../lib/demos';
import { runtimeUrlFor } from '../lib/appUrls';
import './AppShowcase.css';

/**
 * The page's first claim, made with the apps themselves.
 *
 * Six workloads that have nothing in common but the format: a voiced 3D
 * story, an x86 emulator, a card game, a voxel world, a local language model
 * and a layered image editor. Each is one `.softn` file in the same runtime
 * the directory serves, launched into the same web runtime the Player uses.
 *
 * Nothing runs until the visitor asks. A closed stage holds no iframe and
 * boots no engine; one app runs at a time, and the parent suspends this stage
 * while the source explorer below has its own runtime open, so the home page
 * never carries two. The preview frame denies the camera, the microphone and
 * the rest of the device APIs outright — a demonstration must never raise a
 * permission prompt — and the full runtime opens in its own tab for anyone
 * who wants the whole thing.
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
    kind: 'Explore',
    detail: 'A fully voiced first-person survey from inside a sealed pressure hull.',
    aliases: ['lastsound', 'lastsound3d'],
  },
  {
    key: 'softdos',
    title: 'SoftDOS',
    kind: 'Emulate',
    detail: 'An x86 PC — CPU, VGA, BIOS and DOS — written in the same language as everything else here.',
    aliases: ['softdos'],
  },
  {
    key: 'texas-holdem',
    title: 'Texas Hold’em',
    kind: 'Play',
    detail: 'Poker against bots, with peer play between people who trust each other. Not adversarially secure online poker yet.',
    aliases: ['texasholdem'],
  },
  {
    key: 'blockscape',
    title: 'Blockscape',
    kind: 'Build',
    detail: 'A first-person voxel world, chunked and saved, inside a portable app.',
    aliases: ['blockscape'],
  },
  {
    key: 'ai-chat',
    title: 'AI Chat',
    kind: 'Think',
    detail: 'A small language model that downloads once and runs in your browser. Nothing you type leaves the machine.',
    aliases: ['aichat'],
  },
  {
    key: 'photostudio',
    title: 'PhotoStudio',
    kind: 'Create',
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

export function AppShowcase({
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
        setError('The demo catalog could not be loaded. The directory and the tools below still work.');
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
    <section className="showcase" id="showcase" aria-labelledby="showcase-title">
      <div className="wrap">
        <div className="showcase-head">
          <div>
            <p className="eyebrow">One format. Six very different apps.</p>
            <h2 className="band-title" id="showcase-title">
              Open something unexpected.
            </h2>
          </div>
          <p className="showcase-sub">Real apps, not videos of them. Nothing starts until you launch it.</p>
        </div>

        <div className="showcase-shell">
          <div className="showcase-picker" role="group" aria-label="Choose an app to run">
            {FEATURES.map((item, index) => {
              const available = loading || !!findDemo(item, demos);
              return (
                <button
                  type="button"
                  key={item.key}
                  aria-pressed={selected === item.key}
                  className={`showcase-pick ${selected === item.key ? 'on' : ''}`}
                  onClick={() => choose(item)}
                >
                  <span className="showcase-n" aria-hidden="true">
                    0{index + 1}
                  </span>
                  <span className="showcase-pick-body">
                    <strong>{item.title}</strong>
                    <small>
                      {item.kind}
                      {!available ? ' · not in this deployment' : ''}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="showcase-main">
            <div className="showcase-bar">
              <span className="showcase-bar-name">
                {feature.title} <code>.softn</code>
              </span>
              {playing ? (
                <button type="button" className="showcase-close" onClick={() => setLaunched(false)}>
                  Close app
                </button>
              ) : (
                <span className="showcase-bar-tag">idle</span>
              )}
            </div>

            <div className="showcase-stage">
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
                <div className="showcase-intro">
                  <span className="showcase-watermark" aria-hidden="true">
                    .softn
                  </span>
                  <p className="showcase-kind">
                    {feature.kind} / {feature.title}
                  </p>
                  <h3 className="showcase-detail">{feature.detail}</h3>
                  {loading ? (
                    <p className="showcase-note" role="status">
                      Loading the demo catalog…
                    </p>
                  ) : error ? (
                    <div className="showcase-note" role="status">
                      <p>{error}</p>
                      <button type="button" className="cta" onClick={() => setAttempt((n) => n + 1)}>
                        Retry catalog
                      </button>
                    </div>
                  ) : demo ? (
                    <>
                      <button
                        type="button"
                        className="cta cta-primary showcase-launch"
                        onClick={() => {
                          onLaunch?.();
                          setLaunched(true);
                        }}
                      >
                        Launch {feature.title}
                      </button>
                      <p className="showcase-note">
                        Bundle: {formatBytes(demo.size)}. Some apps fetch more — a model, a game’s
                        voice lines — once they are running.
                      </p>
                    </>
                  ) : (
                    <p className="showcase-note" role="status">
                      This app is not in this deployment’s demo catalog yet. The directory below has
                      the ones that are.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="showcase-foot">
              <span>Runs in the SoftN web runtime. Camera and microphone are off in this preview.</span>
              {demo && (
                <a href={runtimeUrlFor(demo.file)} target="_blank" rel="noopener noreferrer">
                  Open the full runtime ↗
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="showcase-loop" aria-label="The SoftN loop">
          <p>
            <strong>Create.</strong> Write an app, or have a model write it.
          </p>
          <p>
            <strong>Run.</strong> Open the bundle in SoftN, anywhere it runs.
          </p>
          <p>
            <strong>Share.</strong> Publish it to the directory. No account.
          </p>
          <p>
            <strong>Remix.</strong> Start from anyone’s source, credited.
          </p>
        </div>
      </div>
    </section>
  );
}
