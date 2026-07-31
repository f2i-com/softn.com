/**
 * Camera lifecycle.
 *
 * All of these are races or leaks — the failures that look like a working
 * component until the moment they don't, and that a screenshot cannot catch:
 * a viewfinder replaced by a permanent error box, hardware left running with
 * nothing on screen, and a live feed that encodes frames and delivers none.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Camera } from '../src/utility/Camera';

let container: HTMLDivElement;
let root: Root;

/** Every stream getUserMedia has handed out this test, so leaks are visible. */
let handedOut: FakeStream[];
/** Resolvers for pending getUserMedia calls, so the race can be staged. */
let pending: Array<(stream: FakeStream) => void>;

class FakeTrack {
  readyState = 'live';
  stop() { this.readyState = 'ended'; }
}
class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks; }
}

/** Rejects like Chrome does when the element goes away mid-play. */
function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  handedOut = [];
  pending = [];

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(
        () =>
          new Promise<FakeStream>((resolve) => {
            pending.push((s) => {
              handedOut.push(s);
              resolve(s);
            });
          })
      ),
    },
  });

  // jsdom has no media pipeline; play() is a no-op that resolves.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: vi.fn(() => Promise.resolve()),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const mount = (node: React.ReactElement) => act(() => root.render(node));
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
/** Hand a stream to the oldest getUserMedia call still waiting. */
const grant = async () => {
  const next = pending.shift();
  if (next) next(new FakeStream());
  await flush();
};

const video = () => container.querySelector('video');
const errorText = () => container.textContent ?? '';

describe('Camera when play() is interrupted', () => {
  it('keeps the viewfinder instead of showing the abort as a camera failure', async () => {
    // Chrome rejects play() when the element is detached or re-sourced before
    // playback starts. That is a lifecycle race, not a broken camera — but it
    // was caught as one, and the error branch renders no <video> at all, so
    // the viewfinder never came back.
    (HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.reject(abortError('The play() request was interrupted because the media was removed from the document.'))
    );
    const onError = vi.fn();
    mount(<Camera onError={onError} />);
    await grant();

    expect(video(), 'the video element should survive an aborted play()').toBeTruthy();
    expect(errorText()).not.toContain('play() request was interrupted');
    expect(onError).not.toHaveBeenCalled();
  });

  it('still reports a camera that genuinely will not open', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
    );
    const onError = vi.fn();
    mount(<Camera onError={onError} />);
    await flush();

    expect(errorText()).toContain('Permission denied');
    expect(onError).toHaveBeenCalledWith('Permission denied');
  });

  it('clears a previous failure when it starts again', async () => {
    const gum = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    gum.mockImplementationOnce(() => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')));
    mount(<Camera />);
    await flush();
    expect(errorText()).toContain('Permission denied');

    // Turning it off and on again is the only recovery a host has.
    mount(<Camera active={false} />);
    await flush();
    mount(<Camera active />);
    await grant();

    expect(errorText()).not.toContain('Permission denied');
    expect(video()).toBeTruthy();
  });
});

describe('Camera across a remount', () => {
  it('does not let a later mount revive a cancelled attempt', async () => {
    // This is what StrictMode does on every mount in development, and what any
    // remount does in production. The cancellation flag used to belong to the
    // component, so this second run cleared the first run's flag and both
    // attempts went on to claim the hardware.
    mount(<Camera />);
    mount(<Camera active={false} />);
    mount(<Camera active />);

    // Grant the first, long-cancelled request.
    await grant();

    expect(handedOut[0].getTracks()[0].readyState,
      'a stream nobody is waiting for any more must be stopped, not adopted').toBe('ended');
  });

  it('stops the camera when it is unmounted mid-request', async () => {
    mount(<Camera />);
    act(() => root.unmount());
    await grant();

    expect(handedOut[0].getTracks()[0].readyState).toBe('ended');

    // Re-establish a root so afterEach has something to unmount.
    root = createRoot(container);
  });

  it('stops the camera when it is switched off', async () => {
    mount(<Camera />);
    await grant();
    expect(handedOut[0].getTracks()[0].readyState).toBe('live');

    mount(<Camera active={false} />);
    await flush();
    expect(handedOut[0].getTracks()[0].readyState).toBe('ended');
  });
});

describe('Camera live mode', () => {
  it('delivers the frames it captures', async () => {
    // startCamera opened an interval that captured frames and discarded them,
    // and because it claimed the shared ref first, the interval that actually
    // calls onFrame never started. Live mode encoded a JPEG ten times a second
    // and handed over nothing.
    vi.useFakeTimers();
    const onFrame = vi.fn();
    mount(<Camera mode="live" frameRate={20} onFrame={onFrame} />);
    await grant();

    const el = video() as HTMLVideoElement;
    Object.defineProperty(el, 'readyState', { configurable: true, value: 4 });
    Object.defineProperty(el, 'videoWidth', { configurable: true, value: 320 });
    Object.defineProperty(el, 'videoHeight', { configurable: true, value: 240 });
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as unknown as HTMLCanvasElement['getContext'];
    canvas.toDataURL = vi.fn(() => 'data:image/jpeg;base64,xxx');

    act(() => { vi.advanceTimersByTime(200); });

    expect(onFrame).toHaveBeenCalled();
    expect(onFrame.mock.calls[0][0]).toMatchObject({ width: 320, height: 240 });
    vi.useRealTimers();
  });
});

describe('Camera sizing', () => {
  it('does not grow past the size it was asked for', async () => {
    // `style` lands on the container, so a host writing `width: 100%` inside a
    // card widened the box; with height:auto the picture grew to match and ran
    // off the bottom of the window, taking the capture button with it, and
    // showed a wide crop that was nothing like the frame capture would save.
    mount(<Camera width={640} height={480} style={{ width: '100%' }} />);
    await grant();
    const el = video() as HTMLVideoElement;
    expect(el.style.maxWidth).toBe('640px');
    expect(el.style.maxHeight).toBe('480px');
    expect(el.style.aspectRatio).toBe('640 / 480');
  });
});
