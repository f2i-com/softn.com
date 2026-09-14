# Local speech host

The trusted runtime provides optional local speech through declarative `softn.audio` calls. Bundle logic receives bounded status records, never executable worker code, audio buffers, or browser objects. The default system provider uses only browser voices marked `localService`; the neural provider is Kokoro 82M with q8 weights and a single-thread WASM backend. Neither provider silently falls back to a remote service or to the other provider.

## Bundle interface

All methods take a callback as their last argument. The equivalent `host.call` names are prefixed `audio.`.

| Method | Result and meaning |
| --- | --- |
| `speechCapabilities(callback)` | Local system `available`, `voices`, optional `reason`, and a `neural` capability record. No network activity. |
| `loadSpeechModel({provider: "kokoro"}, callback)` | Explicitly downloads/loads the optional neural dependencies. Returns `{loaded: true, provider: "kokoro"}` or `{loaded: false, reason}`. |
| `releaseSpeechModel(callback)` | Stops owned neural playback, terminates its worker and releases memory. Returns `{released: true}`. Browser download caches are retained. |
| `speak({provider, text, voiceURI, rate, volume}, callback)` | Returns `{started: true, handle, local: true, provider, voiceURI}` only after playback starts, or `{started: false, reason}`. Omitted provider means `system`; explicit unsupported values fail. |
| `speechState(handle, callback)` | Returns `handle`, `status`, `provider`, `amplitude`, `positionMs`, `durationMs`, and an optional bounded `reason`. |
| `whenSpeechEnded(handle, callback)` | Resolves on actual completion, stop, or error. Check the returned status before advancing a director. |
| `stopSpeech(handle, callback)` | Stops that runtime's handle. An empty handle also cancels pending speech before a start handle has been returned. |

`neural` includes `supported`, `loaded`, `loading`, `provider`, `model`, `dtype`, `device`, `modelBytes`, `engineBytes`, `engineLicense`, `voices`, `phase`, `loadedBytes`, and `totalBytes`. Progress is best-effort dependency progress; it is not a reliable overall percentage. The model identifier is `onnx-community/Kokoro-82M-v1.0-ONNX`; `dtype` is `q8`, and `device` is `wasm`.

The six supported neural `voiceURI` values are `af_heart`, `af_bella`, `af_sarah`, `bf_emma`, `am_michael`, and `bm_george`. System voice IDs come from the capability query. System speech also accepts bounded `pitch`; neural pitch is not exposed.

Applications must make downloads an explicit user action, explain the download sources, and retain text/chat controls when speech fails. Neural loading and speaking require the existing consented AI permission, `huggingface` in `allowedSources` when that list is configured, and `maxModelSizeMB` of at least 96. There is no microphone requirement. No local speech data needs storage or sync permission.

## Playback and mouth movement

Neural speech is generated as bounded sentence chunks and queued with the Web Audio clock. `speechState.amplitude` is a normalized 0–1 RMS sample of the actual current PCM window. Silence, gaps, completion, and stop produce zero. It is an audio envelope, not phoneme recognition or a viseme sequence. System speech has no portable raw PCM access and reports zero amplitude.

A bundle can poll `speechState` at approximately 15–20 Hz while playing, map amplitude to a named jaw morph, and use the Scene3D appearance transition duration for smoothing. Keep one poll in flight, retain a speech generation token, reject stale callbacks, and explicitly set the jaw to zero on stop/end/error or reduced motion. Start body talking only after `speak` reports `started`; use `whenSpeechEnded` for the next gesture. `durationMs` during synthesis describes queued audio so far and may increase as chunks arrive.

Handles, PCM sources, outcomes, pending downloads, and inference belong to one runtime. Disposing it terminates its worker and clears owned playback. Stopping pending neural speech settles the caller immediately and rejects late PCM. It does not pretend to interrupt a current ONNX inference; that bounded chunk may finish in the worker before another request can start. Releasing the model terminates the worker. A fatal worker error clears loaded state and requires an explicit reload.

Limits include 2,800 text characters, at most 32 sentence chunks of at most 240 characters each, six preset neural voices, rate 0.75–1.3, volume 0–1, a 20,000-character serialized request, 35 seconds per PCM chunk, and 115 seconds of queued audio. Invalid or nonfinite PCM is rejected. Load, synthesis, playback start, autoplay resume, and total playback have finite watchdogs. Native local voices have separate browser-dependent availability and start behavior.

## Downloads, provenance, and distribution

The hosting assets contain the local worker, six preset voice files, the isolated ONNX WASM runtime, and license notices. Explicit neural loading downloads approximately 92.4 MB of model weights/configuration from Hugging Face and a 1,322,380-byte optional phonemizer component from this fixed URL:

`https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js`

The component's expected SHA-256 is `193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec`. The trusted worker checks exact size and hash before importing it. Cached bytes are checked again. Fetches omit credentials and reject redirects; speech text is never included in a request. The component is cached under `softn-speech-engine-v1`. Model files use Transformers' browser cache. Cache eviction or browser storage limits can require another explicit load. Offline operation must be tested separately on the deployment origin; successful cached loading alone is not proof of offline availability.

The published phonemizer wrapper declares Apache-2.0 but embeds GPL-3.0-or-later eSpeak engine/data. The upstream package does not establish the exact corresponding C source revision or toolchain for that compiled blob. Consequently the hosting distribution does **not** include that blob; it is an optional direct download after the user's load action. The checked-in notices retain this distinction and the upstream GPL/BSD texts. This is not an Apache-only dependency claim or a claim that upstream links prove corresponding source for the blob. Any future bundled replacement needs an identified engine source revision and reproducible build inputs.

See `packages/@softn/core/speech-notices/NOTICE.txt` for pinned wrapper/model provenance, six official voice checksums, upstream engine links, and the detailed license caveat. Normal hosting third-party notices cover the redistributed Kokoro, Transformers, ONNX, and other emitted dependencies.

## Building and verifying

The lockfile pins Kokoro.js 1.2.1 as a build dependency. The worker build resolves its compatible Transformers 3.x separately from the main runtime's Transformers 4.x. Do not deduplicate those into one inference implementation without rerunning the browser speech and chat tests.

`npm run build:packages` builds the worker through the core tsup hook. The worker and adjacent `speech/voices`, `speech/ort`, and notices must stay together under the copied `assets/core-runtime/runtime` tree. The normal `build-site` and `package-site` flows distribute these assets. The build rejects markers of the upstream embedded phonemizer binary in the emitted worker.

The web, builder, and studio Vite configurations share `scripts/core-worker-assets.mjs`. It serves the same tree during development, preserves binary bytes and module MIME types, rejects missing/traversal requests with 404, and copies the complete tree into each production app. Optional core-runtime assets are excluded from PWA precaching. The desktop loader already has its own core-runtime copy/serve path; desktop speech was not separately exercised in this browser-focused validation.

Run the focused suite from the repository root:

```sh
npx vitest run packages/@softn/core/test/local-speech.test.ts packages/@softn/core/test/speech-engine-integrity.test.ts
node --test scripts/core-worker-assets.test.mjs
```

These tests cover consent/source/model budget enforcement, explicit provider selection, PCM playback start and envelope, cancellation before start, stale chunks, release/disposal, chunk preservation, local system voice filtering and ownership, worker failures, progress bounds, download integrity, and absence of the embedded engine in the worker. They do not replace real browser checks of the SoftN parser, ZIPP calls, asset paths, autoplay policy, model download, actual playback completion, and UI stale-callback handling.

The implementation was exercised in a Windows browser through the actual SoftN runtime with all six neural voice capabilities, a successful explicit Kokoro load, synthetic speech, PCM-driven jaw updates, stop before generation completion, reduced motion, local system voice playback, and a chat gesture after speech. First observed synthetic speech start was approximately 2.6 seconds after a successful model load; this is a single-machine observation, not a performance guarantee or download benchmark. Physical speaker output and a network-disabled offline run were not independently recorded.
