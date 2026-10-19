# Local speech host

The trusted runtime provides local speech through declarative `softn.audio` calls, on the device's own voices: only browser voices marked `localService` are offered or used, and nothing is downloaded. Bundle logic receives bounded status records, never executable code, audio buffers, or browser objects.

The neural provider this host once had (Kokoro 82M on ONNX Runtime, with a phonemizer fetched from a CDN) was removed with ONNX Runtime. An app that still asks for it is answered without breaking: `loadSpeechModel` reports `{loaded: false, reason: "neural-speech-removed"}`, and `speak({provider: "kokoro", …})` is spoken by the device's first local voice and says so with `fallbackFrom: "kokoro"`.

## Bundle interface

All methods take a callback as their last argument. The equivalent `host.call` names are prefixed `audio.`.

| Method | Result and meaning |
| --- | --- |
| `speechCapabilities(callback)` | `available`, local `voices`, optional `reason`, and `neural: {supported: false, loaded: false, reason: "neural-speech-removed"}`. No network activity. |
| `loadSpeechModel(options, callback)` | `{loaded: false, reason: "neural-speech-removed"}`. |
| `releaseSpeechModel(callback)` | `{released: true}`. |
| `speak({provider, text, voiceURI, rate, pitch, volume}, callback)` | `{started: true, handle, local: true, voiceURI}` once the voice starts, or `{started: false, reason}`. Omitted provider means `system`; `kokoro` falls back as above; anything else fails. |
| `speechState(handle, callback)` | `handle`, `status`, `provider`, `amplitude` (always 0: system speech exposes no PCM), `positionMs`, `durationMs`, optional `reason`. |
| `whenSpeechEnded(handle, callback)` | Resolves on actual completion, stop, or error. |
| `stopSpeech(handle, callback)` | Stops that runtime's handle; an empty handle stops this runtime's own pending or active speech. |

Speech needs no permission: it downloads nothing and reaches nothing but the browser's speech queue, which `local-system-speech.mjs` brokers so one runtime never cancels or appends to another's. Limits are 2,800 text characters, rate 0.75–1.3, pitch 0.8–1.2, volume 0–1, a 20,000-character serialized request, a 10-second start watchdog and 110 seconds of speech.

## Verifying

```sh
npx vitest run packages/@softn/core/test/local-speech.test.ts
```

The suite covers system voice filtering and ownership, the Kokoro fallback, the removed-model answers, and that speech asks for no permission. It does not replace a browser check of real voices and autoplay policy.
