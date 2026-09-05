/**
 * The hardware components, against what the bundle declared.
 *
 * consent-gate.test.tsx pins the one-bit case: nothing opens while the bar is
 * unanswered. This pins the rest of the decision. Once the bar was answered
 * the components used to open the device regardless of what the bundle had
 * asked for: the browser had granted the origin, every bundle shares the
 * origin, and nothing asked which bundle the user had approved for it. So a
 * bundle allowed `net` alone got the camera.
 *
 * These mount each component under the host's published capability state and
 * count calls to getUserMedia. A denied or absent grant makes none, even when
 * the browser would say yes; a grant makes exactly one; withdrawing the grant
 * stops the tracks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { CapabilityProvider, type CapabilityState } from '@softn/core';
import { Camera } from '../src/utility/Camera';
import { Microphone } from '../src/utility/Microphone';
import { QRReader } from '../src/utility/QRReader';
import { mount } from './dom';

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
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
}

let getUserMedia: ReturnType<typeof vi.fn>;
let handedOut: FakeStream[];

beforeEach(() => {
  handedOut = [];
  getUserMedia = vi.fn(async () => {
    const stream = new FakeStream();
    handedOut.push(stream);
    return stream;
  });
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined) as unknown as () => Promise<void>;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
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

const answered = (permissions: CapabilityState['permissions']): CapabilityState => ({
  consentPending: false,
  permissions,
});

function under(state: CapabilityState, child: React.ReactElement): React.ReactElement {
  return <CapabilityProvider value={state}>{child}</CapabilityProvider>;
}

describe('a camera in a bundle that declared something else', () => {
  it('does not touch getUserMedia, even though the origin would allow it', async () => {
    const view = mount(under(answered({ net: { enabled: true } }), <Camera />));
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    view.unmount();
  });

  it('says the bundle has to declare it, rather than that the camera failed', () => {
    const view = mount(under(answered({}), <Camera />));
    expect(view.container.textContent).toMatch(/permission\.json/);
    expect(view.container.textContent).toMatch(/camera/);
    expect(view.container.querySelector('video')).toBeNull();
    view.unmount();
  });
});

describe('a camera in a bundle that declared the camera', () => {
  it('opens it once, without sound', async () => {
    const view = mount(under(answered({ camera: { enabled: true } }), <Camera />));
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({ audio: false });
    view.unmount();
  });

  it('records silent video when the microphone is not declared', async () => {
    // `camera.modes: ["video"]` is a complete declaration; the sound is the
    // microphone's to give, and it was not asked for.
    const view = mount(under(answered({ camera: { enabled: true } }), <Camera mode="video" />));
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({ audio: false });
    view.unmount();
  });

  it('refuses sound that was asked for explicitly but not declared', async () => {
    const view = mount(under(answered({ camera: { enabled: true } }), <Camera mode="video" audio />));
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/mic/);
    view.unmount();
  });

  it('records silent video when asked to explicitly', async () => {
    const view = mount(
      under(answered({ camera: { enabled: true } }), <Camera mode="video" audio={false} />)
    );
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({ audio: false });
    view.unmount();
  });

  it('records with sound when both are declared', async () => {
    const view = mount(
      under(answered({ camera: { enabled: true }, mic: { enabled: true } }), <Camera mode="video" />)
    );
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({ audio: true });
    view.unmount();
  });

  it('stops the tracks when the grant is withdrawn, with no remount', async () => {
    const view = mount(under(answered({ camera: { enabled: true } }), <Camera />));
    await settle();
    expect(handedOut[0].getTracks()[0].readyState).toBe('live');
    // What the host does when consent is withdrawn: same tree, withheld config.
    view.rerender(under({ consentPending: true, permissions: null }, <Camera />));
    await settle();
    expect(handedOut[0].getTracks()[0].readyState).toBe('ended');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

describe('a microphone against the declaration', () => {
  it('does not open for a bundle that did not declare it', async () => {
    const view = mount(under(answered({ camera: { enabled: true } }), <Microphone />));
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/permission\.json/);
    view.unmount();
  });

  it('opens once for a bundle that did', async () => {
    const view = mount(under(answered({ mic: { enabled: true } }), <Microphone />));
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

describe('a QR scanner against the declaration', () => {
  it('is not mounted for a bundle that declared neither qr nor camera', async () => {
    const view = mount(under(answered({ net: { enabled: true } }), <QRReader />));
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(view.container.querySelector('video')).toBeNull();
    view.unmount();
  });

  it('is mounted for a bundle that declared qr', async () => {
    const view = mount(under(answered({ qr: { enabled: true } }), <QRReader />));
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('is mounted for a bundle that declared the camera', async () => {
    const view = mount(under(answered({ camera: { enabled: true } }), <QRReader />));
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

describe('a host that publishes no capability list', () => {
  it('is not enforcing: the components behave as they always did', async () => {
    const view = mount(under({ consentPending: false, permissions: null }, <Camera />));
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
