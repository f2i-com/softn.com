/**
 * The `softn.*` namespace as the script sees it: every capability is a call
 * into `host.call`, which the engine queues for whichever thread hosts the
 * VM to drain. It lives on its own so the Web Worker runtime can prepend it
 * too, without pulling the main-thread runtime — and its DOM — into the
 * worker bundle.
 */

/** The `host.call` kind that says a key listener tried to cancel a key it could not; its arguments are the event's type, key and code. */
export const KEY_PREVENTED = 'input.keyPrevented';

/**
 * What tells the host that a key listener on the window called
 * `preventDefault()` for a key the page had not kept from the browser.
 *
 * The call does nothing there: the listener runs after the browser has
 * acted on the key, in the engine or a worker away, so the arrows scroll the
 * page under a game whatever the listener says. Eight of the shipped games
 * make that call, forty times between them, and none says which keys it
 * wants with `softn.input.captureKeys`. Nothing told their authors. So the
 * listeners a script puts on its window for keys are heard through a
 * function that gives each event a `preventDefault` of this file's: for a
 * key that was kept from the browser (`defaultPrevented` is true by then) it
 * does nothing, as before, and for any other it tells the host, once for
 * each key, and the host says so in the console, once for the app
 * (script-runtime.ts).
 *
 * A function is given the same stand-in every time it is added, so adding
 * it twice and taking it away behave as they did.
 *
 * Put after {@link SOFTN_BRIDGE_PREAMBLE} by both runtimes, and kept out of
 * it, as the timers are: that preamble is the list of what an app can ask
 * of its host, in either language, and this is not something an app asks.
 */
export const KEY_LISTENER_PREAMBLE = `
;(function () {
  if (typeof window !== "object" || window === null || typeof window.addEventListener !== "function") return;
  var add = window.addEventListener, remove = window.removeEventListener;
  var heard = new Map(), told = Object.create(null);
  function isKey(type) { return type === "keydown" || type === "keyup" || type === "keypress"; }
  function through(fn) {
    var stand = heard.get(fn);
    if (stand) return stand;
    stand = function (e) {
      if (e !== null && typeof e === "object") {
        try {
          e.preventDefault = function () {
            var key = String(e.key);
            if (e.defaultPrevented === true || told[key]) return;
            told[key] = true;
            host.call("${KEY_PREVENTED}", [String(e.type), key, String(e.code)], function () {});
          };
        } catch (_) {}
      }
      return fn.call(this, e);
    };
    heard.set(fn, stand);
    return stand;
  }
  try {
    window.addEventListener = function (type, fn, options) {
      return add.call(window, type, isKey(type) && typeof fn === "function" ? through(fn) : fn, options);
    };
    if (typeof remove === "function") {
      window.removeEventListener = function (type, fn, options) {
        return remove.call(window, type, isKey(type) && heard.has(fn) ? heard.get(fn) : fn, options);
      };
    }
  } catch (_) {}
})();
`;

/**
 * Bridge preamble for the softn.* namespace.
 * Builds a JS object that delegates to host.call() for each capability.
 *
 * Two parts of it are not calls to the host but names for values the page
 * and the logic share on the window, so that they can be written down in a
 * guide and found:
 *
 * `softn.input.keys` and `softn.input.down(name)`: the keys a
 * `<Scene3D gameControls>` holds, by name: `w`, `a`, `s`, `d`, `up`, `down`,
 * `left`, `right`, `space` and `shift`, each true while it is down, and an
 * empty record where no such scene is drawn. It is the window's
 * `__softnKeys`. For any other keys, and for touch and a gamepad, a page
 * binds a `<Controls>` to a variable instead.
 *
 * `softn.scene`: the mouse-look `<Scene3D>` on screen (`mouseLook` or
 * `pointerLock`).
 * - `softn.scene.yaw` and `softn.scene.pitch`: which way its camera faces,
 *   in radians. Read them to move the player that way; set them to turn the
 *   camera (a new game, a teleport).
 * - `softn.scene.locked`: true while a `pointerLock` scene holds the
 *   pointer. A game pauses when it turns false: the player pressed Escape.
 * - `softn.scene.lock()`: ask the scene to take the pointer. Call it from
 *   the handler of a click (a Start or Resume button), which is when a
 *   browser allows it.
 * - `softn.scene.unlock()`: give the pointer back, for a menu or a panel
 *   opened over the game.
 * These are the window's `__scene3dYaw`, `__scene3dPitch`, `__scene3dLocked`,
 * `__scene3dWantLock` and `__scene3dReleaseLock`, which work as they did.
 *
 * Each is read as it stood when the call into the logic began, and what the
 * logic sets is put on the page when the call ends (window-bridge.ts).
 *
 * That is on the page's thread, where every app's logic runs unless its
 * manifest asks for a worker. Logic in a worker shares no `window.__…`
 * value with the page, by these names or by the window's: there the keys
 * are an empty record, `yaw` and `pitch` read 0, `locked` reads false, and
 * `lock()` and `unlock()` reach no scene.
 */
export const SOFTN_BRIDGE_PREAMBLE = `
let softn = {
  backend: {
    call: function(action, input, callback) {
      host.call("backend.call", [action, JSON.stringify(input || {})], callback || function(){});
    }
  },
  net: {
    fetch: function(url, options, callback) {
      host.call("net.fetch", [url, options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    }
  },
  qr: {
    encode: function(text, options, callback) {
      host.call("qr.encode", [text, options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    decode: function(imageDataUrl, callback) {
      host.call("qr.decode", [imageDataUrl], callback);
    }
  },
  camera: {
    capturePhoto: function(options, callback) {
      host.call("camera.capturePhoto", [options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    recordVideo: function(options, callback) {
      host.call("camera.recordVideo", [options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    startLive: function(options, callback) {
      host.call("camera.startLive", [options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    stopLive: function() {
      host.call("camera.stopLive", [], function(){});
    }
  },
  mic: {
    record: function(options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("mic.record", [options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback || function(){});
    },
    stop: function(callback) {
      host.call("mic.stop", [], callback || function(){});
    },
    isRecording: function(callback) {
      host.call("mic.isRecording", [], callback || function(){});
    }
  },
  audio: {
    speechCapabilities: function(callback) {
      host.call("audio.speechCapabilities", [], callback || function(){});
    },
    loadSpeechModel: function(options, callback) {
      if(typeof options === "function") { callback=options;options={provider:"kokoro"}; }
      host.call("audio.loadSpeechModel", [JSON.stringify(options || {provider:"kokoro"})], callback || function(){});
    },
    releaseSpeechModel: function(callback) {
      host.call("audio.releaseSpeechModel", [], callback || function(){});
    },
    speak: function(options, callback) {
      host.call("audio.speak", [JSON.stringify(options || {})], callback || function(){});
    },
    speechState: function(handle, callback) {
      host.call("audio.speechState", [handle == null ? "" : String(handle)], callback || function(){});
    },
    whenSpeechEnded: function(handle, callback) {
      host.call("audio.whenSpeechEnded", [handle == null ? "" : String(handle)], callback || function(){});
    },
    stopSpeech: function(handle, callback) {
      if(typeof handle === "function") { callback=handle;handle=""; }
      host.call("audio.stopSpeech", [handle == null ? "" : String(handle)], callback || function(){});
    },
    play: function(src, options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("audio.play", [src, options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback || function(){});
    },
    stop: function(handle, callback) {
      host.call("audio.stop", [handle == null ? "" : String(handle)], callback || function(){});
    },
    stopAll: function(callback) {
      host.call("audio.stopAll", [], callback || function(){});
    },
    setVolume: function(volume, callback) {
      host.call("audio.setVolume", [String(volume)], callback || function(){});
    },
    whenEnded: function(handle, callback) {
      host.call("audio.whenEnded", [handle == null ? "" : String(handle)], callback || function(){});
    }
  },
  input: {
    // The keys a script wants whole. The browser's default for them --
    // scrolling on the arrows and Space, focus on Tab, a search on "/" --
    // is cancelled before the event reaches the script's listener. Pass an
    // array of KeyboardEvent key or code values; an empty array releases
    // them. Text fields and the browser's own chords are never affected.
    captureKeys: function(keys, callback) {
      host.call("input.captureKeys", [JSON.stringify(Array.isArray(keys) ? keys : (keys == null ? [] : [String(keys)]))], callback || function(){});
    },
    // What a <Scene3D gameControls> holds (see the head of softn-preamble.ts).
    get keys() {
      var held = window.__softnKeys;
      return held !== null && typeof held === "object" ? held : {};
    },
    down: function(name) {
      var held = window.__softnKeys;
      return held !== null && typeof held === "object" && held[String(name)] === true;
    }
  },
  // The mouse-look <Scene3D> on screen (see the head of softn-preamble.ts).
  scene: {
    get yaw() { var v = window.__scene3dYaw; return typeof v === "number" ? v : 0; },
    set yaw(v) { window.__scene3dYaw = Number(v) || 0; },
    get pitch() { var v = window.__scene3dPitch; return typeof v === "number" ? v : 0; },
    set pitch(v) { window.__scene3dPitch = Number(v) || 0; },
    get locked() { return window.__scene3dLocked === true; },
    lock: function() { window.__scene3dWantLock = true; },
    unlock: function() { window.__scene3dReleaseLock = true; }
  },
  sandbox: {
    run: function(source, input, callback) {
      host.call("sandbox.run", [String(source), JSON.stringify(input)], callback);
    }
  },
  files: {
    readZipText: function(fileRef, callback) {host.call("files.readZipText", [fileRef], callback);},
    pickFile: function(options, callback) {
      host.call("files.pickFile", [options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    readText: function(fileRef, callback) {
      host.call("files.readText", [fileRef], callback);
    },
    readBase64: function(fileRef, callback) {
      host.call("files.readBase64", [fileRef], callback);
    },
    // Hand the user a file to save. The content is text unless
    // options.base64 is true, in which case it is base64-encoded bytes;
    // options.mime names the type. The browser shows its usual download.
    saveFile: function(name, content, options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("files.saveFile", [String(name), typeof content === "string" ? content : String(content), typeof options === "object" && options !== null ? JSON.stringify(options) : "{}"], callback || function(){});
    }
  },
  ai: {
    getCapabilities: function(callback) {
      host.call("ai.getCapabilities", [], callback);
    },
    onnx: {
      loadModel: function(source, options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.onnx.loadModel", [typeof source === "object" ? JSON.stringify(source) : source, options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      run: function(sessionId, feeds, options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.onnx.run", [sessionId, typeof feeds === "object" ? JSON.stringify(feeds) : feeds, options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      release: function(sessionId, callback) {
        host.call("ai.onnx.release", [sessionId], callback);
      }
    },
    pipeline: function(task, model, options, callback) {
      if (typeof model === "function") { callback = model; model = ""; options = {}; }
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("ai.pipeline", [task, model || "", options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    generate: function(pipelineId, prompt, options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("ai.generate", [pipelineId, prompt, options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    embed: function(pipelineId, texts, callback) {
      host.call("ai.embed", [pipelineId, typeof texts === "object" ? JSON.stringify(texts) : texts], callback);
    },
    classify: function(pipelineId, text, callback) {
      host.call("ai.classify", [pipelineId, text], callback);
    },
    run: function(pipelineId, input, options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("ai.run", [pipelineId, typeof input === "object" ? JSON.stringify(input) : input, options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    releaseAll: function(callback) {
      host.call("ai.releaseAll", [], callback);
    },
    // A local chat model, run by ZIPP: a GGUF checkpoint named by its Hugging
    // Face repository ("owner/name", or "owner/name:Q4_K_M" for one of its
    // files), or {huggingface, file}, {url} or {bundle}. generate takes chat
    // messages and answers {text}; cancel stops a reply where it is.
    model: {
      load: function(model, options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.model.load", [typeof model === "object" && model !== null ? JSON.stringify(model) : String(model), options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      generate: function(modelHandle, messages, options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.model.generate", [modelHandle, typeof messages === "object" ? JSON.stringify(messages) : messages, options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      cancel: function(modelHandle, callback) {
        host.call("ai.model.cancel", [modelHandle], callback || function(){});
      },
      release: function(modelHandle, callback) {
        host.call("ai.model.release", [modelHandle], callback);
      }
    },
    gpu: {
      requestDevice: function(options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.gpu.requestDevice", [options && typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      createBuffer: function(source, usage, callback) {
        host.call("ai.gpu.createBuffer", [typeof source === "object" ? JSON.stringify(source) : source, usage], callback);
      },
      writeBuffer: function(bufferId, data, dtype, callback) {
        if (typeof dtype === "function") { callback = dtype; dtype = ""; }
        host.call("ai.gpu.writeBuffer", [bufferId, typeof data === "object" ? JSON.stringify(data) : data, dtype || ""], callback);
      },
      createShader: function(source, callback) {
        host.call("ai.gpu.createShader", [typeof source === "object" ? JSON.stringify(source) : source], callback);
      },
      createPipeline: function(options, callback) {
        host.call("ai.gpu.createPipeline", [options && typeof options === "object" ? JSON.stringify(options) : options == null ? "{}" : options], callback);
      },
      dispatch: function(pipelineId, bindings, workgroups, callback) {
        host.call("ai.gpu.dispatch", [pipelineId, JSON.stringify(bindings), JSON.stringify(workgroups)], callback);
      },
      readBuffer: function(bufferId, callback) {
        host.call("ai.gpu.readBuffer", [bufferId], callback);
      },
      release: function(resourceId, callback) {
        host.call("ai.gpu.release", [resourceId], callback);
      },
      releaseAll: function(callback) {
        host.call("ai.gpu.releaseAll", [], callback);
      }
    }
  },
  // The app's own database on the directory that publishes it. Records live
  // in named collections; a query is {where, orderBy, limit, offset}; every
  // result arrives in the callback, and a refusal arrives as {error}.
  storage: {
    insert: function(collection, data, callback) {
      host.call("storage.op", ["insert", JSON.stringify({ collection: collection, data: data })], callback || function(){});
    },
    get: function(collection, id, callback) {
      host.call("storage.op", ["get", JSON.stringify({ collection: collection, id: id })], callback || function(){});
    },
    update: function(collection, id, data, callback) {
      host.call("storage.op", ["update", JSON.stringify({ collection: collection, id: id, data: data })], callback || function(){});
    },
    set: function(collection, id, data, callback) {
      host.call("storage.op", ["set", JSON.stringify({ collection: collection, id: id, data: data })], callback || function(){});
    },
    remove: function(collection, id, callback) {
      host.call("storage.op", ["remove", JSON.stringify({ collection: collection, id: id })], callback || function(){});
    },
    query: function(collection, options, callback) {
      var q = typeof options === "object" && options !== null ? options : {};
      host.call("storage.op", ["query", JSON.stringify({ collection: collection, where: q.where, orderBy: q.orderBy, limit: q.limit, offset: q.offset })], callback || function(){});
    },
    count: function(collection, where, callback) {
      host.call("storage.op", ["count", JSON.stringify({ collection: collection, where: where })], callback || function(){});
    },
    collections: function(callback) {
      host.call("storage.op", ["collections", "{}"], callback || function(){});
    },
    clear: function(collection, callback) {
      host.call("storage.op", ["clear", JSON.stringify({ collection: collection })], callback || function(){});
    },
    kvGet: function(key, callback) {
      host.call("storage.op", ["kvGet", JSON.stringify({ key: key })], callback || function(){});
    },
    kvSet: function(key, value, callback) {
      host.call("storage.op", ["kvSet", JSON.stringify({ key: key, value: value })], callback || function(){});
    },
    kvRemove: function(key, callback) {
      host.call("storage.op", ["kvRemove", JSON.stringify({ key: key })], callback || function(){});
    }
  }
};
`;
