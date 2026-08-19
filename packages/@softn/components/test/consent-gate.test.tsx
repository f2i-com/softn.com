/**
 * The hardware components, before the user has answered.
 *
 * permission.json describes the softn.* scripting API. <Camera>, <QRReader>
 * and <Microphone> do not go through it — they call getUserMedia from a mount
 * effect — so nothing in the capability model was ever in front of the device.
 * That did not matter while the runtime blocked on a modal, because the app did
 * not exist until the user answered it. It renders first now, so an entry page
 * can raise the browser's own camera prompt over a permission bar nobody has
 * read; and since every bundle is served from one browser origin, a second
 * bundle gets the device with no prompt at all.
 *
 * These pin the property the modal used to provide for free: nothing reaches
 * the hardware while consent is pending, and it starts on its own when consent
 * arrives — no reload, because nobody would go looking for one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { ConsentPendingProvider } from '@softn/core';
import { Camera } from '../src/utility/Camera';
import { Microphone } from '../src/utility/Microphone';
import { QRReader } from '../src/utility/QRReader';
import { Image } from '../src/display/Image';
import { mount } from './dom';

// The real <Scanner> draws frames to a canvas jsdom does not have, so mounting
// it throws before it ever reaches the camera. The stub keeps the only part
// this file is about: constructing the scanner is what opens the device, so a
// scanner that is never constructed is a device that is never opened.
vi.mock('@yudiel/react-qr-scanner', () => ({
  Scanner: (): React.ReactElement => {
    React.useEffect(() => {
      void navigator.mediaDevices.getUserMedia({ video: true });
    }, []);
    return React.createElement('video');
  },
}));

class FakeTrack {
  readyState = 'live';
  stop(): void {
    this.readyState = 'ended';
  }
}
class FakeStream {
  tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks;
  }
}

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getUserMedia = vi.fn(async () => new FakeStream());
  // jsdom has no media playback; without this the granted paths log
  // "Not implemented: HTMLMediaElement.prototype.play" over the results.
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined) as unknown as () => Promise<void>;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  // Microphone builds an AudioContext once the stream lands. Only the call
  // count matters here, so a stub is enough to keep the path from throwing.
  (globalThis as unknown as { AudioContext?: unknown }).AudioContext = class {
    state = 'running';
    sampleRate = 48000;
    destination = {};
    async resume(): Promise<void> {}
    async close(): Promise<void> {}
    createMediaStreamSource(): unknown {
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor(): unknown {
      return { connect() {}, disconnect() {}, onaudioprocess: null };
    }
    createGain(): unknown {
      return { gain: { value: 0 }, connect() {}, disconnect() {} };
    }
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('a camera on a page the user has not consented to', () => {
  it('does not touch getUserMedia', async () => {
    const view = mount(
      <ConsentPendingProvider value={true}>
        <Camera mode="video" />
      </ConsentPendingProvider>,
    );
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    view.unmount();
  });

  it('says the camera is off and why, rather than showing a dead viewfinder', () => {
    const view = mount(
      <ConsentPendingProvider value={true}>
        <Camera />
      </ConsentPendingProvider>,
    );
    expect(view.container.textContent).toMatch(/Allow/);
    expect(view.container.querySelector('video')).toBeNull();
    view.unmount();
  });

  it('opens the device on the grant, with no remount and no reload', async () => {
    const view = mount(
      <ConsentPendingProvider value={true}>
        <Camera mode="video" />
      </ConsentPendingProvider>,
    );
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();

    // Exactly what Allow does: the same tree, re-rendered with consent
    // answered. Nothing is unmounted and nothing is reloaded.
    view.rerender(
      <ConsentPendingProvider value={false}>
        <Camera mode="video" />
      </ConsentPendingProvider>,
    );
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

describe('a microphone on a page the user has not consented to', () => {
  it('does not touch getUserMedia', async () => {
    const view = mount(
      <ConsentPendingProvider value={true}>
        <Microphone />
      </ConsentPendingProvider>,
    );
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    view.unmount();
  });

  it('opens the device on the grant', async () => {
    const view = mount(
      <ConsentPendingProvider value={true}>
        <Microphone />
      </ConsentPendingProvider>,
    );
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();

    view.rerender(
      <ConsentPendingProvider value={false}>
        <Microphone />
      </ConsentPendingProvider>,
    );
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

describe('a QR scanner on a page the user has not consented to', () => {
  // The third gated component, and the one that had no test. It does not call
  // getUserMedia itself — the <Scanner> it wraps does, from its own mount — so
  // what is pinned here is that the scanner is never constructed. `paused`
  // would not do: pausing stops the decode, not the stream, so the camera
  // would already be open.
  it('does not mount the scanner, and says why', async () => {
    const view = mount(
      <ConsentPendingProvider value={true}>
        <QRReader />
      </ConsentPendingProvider>,
    );
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(view.container.querySelector('video')).toBeNull();
    expect(view.container.textContent).toMatch(/Allow/);
    view.unmount();
  });

  it('mounts the scanner on the grant, with no remount and no reload', async () => {
    const view = mount(
      <ConsentPendingProvider value={true}>
        <QRReader />
      </ConsentPendingProvider>,
    );
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();

    view.rerender(
      <ConsentPendingProvider value={false}>
        <QRReader />
      </ConsentPendingProvider>,
    );
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('video')).not.toBeNull();
    view.unmount();
  });
});

describe('an image whose remote source the renderer withheld', () => {
  // The withholding itself is not here — it is in core's renderer, which strips
  // a remote URL from every URL-bearing prop before any component is
  // constructed, and so covers a raw <img> in the markup and every other
  // component too (core/test/markup-egress.test.tsx). What <Image> owns is what
  // the user is told about the hole where the picture was.
  it('points at the bar instead of reporting a failure the bundle did not cause', () => {
    const view = mount(
      <ConsentPendingProvider value={true}>
        <Image src="" alt="withheld" />
      </ConsentPendingProvider>,
    );
    expect(view.container.textContent).toMatch(/Allow/);
    expect(view.container.textContent).not.toMatch(/Failed to load/);
    view.unmount();
  });

  it('still says "Failed to load" once consent has been answered', () => {
    // A missing src after the grant is the bundle's own problem again, and
    // naming the permission bar then would send the user somewhere useless.
    const view = mount(
      <ConsentPendingProvider value={false}>
        <Image src="" alt="broken" />
      </ConsentPendingProvider>,
    );
    expect(view.container.textContent).toMatch(/Failed to load/);
    view.unmount();
  });

  it('renders a bundle-relative source normally while consent is pending', () => {
    const view = mount(
      <ConsentPendingProvider value={true}>
        <Image src="blob:local/logo.png" alt="own" />
      </ConsentPendingProvider>,
    );
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:local/logo.png');
    view.unmount();
  });
});

describe('a component with no consent state above it', () => {
  it('behaves exactly as it did — the gate is opt-in, not a new default', async () => {
    // The builder's palette, studio's preview and any React host importing
    // this package directly render these components outside a SoftN runtime.
    // Defaulting the gate closed would break all of them.
    const view = mount(<Camera />);
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
