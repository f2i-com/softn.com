/**
 * The `softn.*` namespace as the script sees it: every capability is a call
 * into `host.call`, which the engine queues for whichever thread hosts the
 * VM to drain. It lives on its own so the Web Worker runtime can prepend it
 * too, without pulling the main-thread runtime — and its DOM — into the
 * worker bundle.
 */
/**
 * Bridge preamble for the softn.* namespace.
 * Builds a JS object that delegates to host.call() for each capability.
 */
export const SOFTN_BRIDGE_PREAMBLE = `
let softn = {
  net: {
    fetch: function(url, options, callback) {
      host.call("net.fetch", [url, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    }
  },
  qr: {
    encode: function(text, options, callback) {
      host.call("qr.encode", [text, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    decode: function(imageDataUrl, callback) {
      host.call("qr.decode", [imageDataUrl], callback);
    }
  },
  camera: {
    capturePhoto: function(options, callback) {
      host.call("camera.capturePhoto", [typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    recordVideo: function(options, callback) {
      host.call("camera.recordVideo", [typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    startLive: function(options, callback) {
      host.call("camera.startLive", [typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    stopLive: function() {
      host.call("camera.stopLive", [], function(){});
    }
  },
  mic: {
    record: function(options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("mic.record", [typeof options === "object" ? JSON.stringify(options) : "{}"], callback || function(){});
    },
    stop: function(callback) {
      host.call("mic.stop", [], callback || function(){});
    },
    isRecording: function(callback) {
      host.call("mic.isRecording", [], callback || function(){});
    }
  },
  audio: {
    play: function(src, options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("audio.play", [src, typeof options === "object" ? JSON.stringify(options) : "{}"], callback || function(){});
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
  files: {
    pickFile: function(options, callback) {
      host.call("files.pickFile", [typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    readText: function(fileRef, callback) {
      host.call("files.readText", [fileRef], callback);
    },
    readBase64: function(fileRef, callback) {
      host.call("files.readBase64", [fileRef], callback);
    }
  },
  ai: {
    getCapabilities: function(callback) {
      host.call("ai.getCapabilities", [], callback);
    },
    onnx: {
      loadModel: function(source, options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.onnx.loadModel", [typeof source === "object" ? JSON.stringify(source) : source, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      run: function(sessionId, feeds, options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.onnx.run", [sessionId, typeof feeds === "object" ? JSON.stringify(feeds) : feeds, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      release: function(sessionId, callback) {
        host.call("ai.onnx.release", [sessionId], callback);
      }
    },
    pipeline: function(task, model, options, callback) {
      if (typeof model === "function") { callback = model; model = ""; options = {}; }
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("ai.pipeline", [task, model || "", typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    generate: function(pipelineId, prompt, options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("ai.generate", [pipelineId, prompt, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    embed: function(pipelineId, texts, callback) {
      host.call("ai.embed", [pipelineId, typeof texts === "object" ? JSON.stringify(texts) : texts], callback);
    },
    classify: function(pipelineId, text, callback) {
      host.call("ai.classify", [pipelineId, text], callback);
    },
    run: function(pipelineId, input, options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      host.call("ai.run", [pipelineId, typeof input === "object" ? JSON.stringify(input) : input, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
    },
    releaseAll: function(callback) {
      host.call("ai.releaseAll", [], callback);
    },
    model: {
      load: function(modelId, options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.model.load", [modelId, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      generate: function(modelHandle, messages, options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.model.generate", [modelHandle, typeof messages === "object" ? JSON.stringify(messages) : messages, typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
      },
      release: function(modelHandle, callback) {
        host.call("ai.model.release", [modelHandle], callback);
      }
    },
    gpu: {
      requestDevice: function(options, callback) {
        if (typeof options === "function") { callback = options; options = {}; }
        host.call("ai.gpu.requestDevice", [typeof options === "object" ? JSON.stringify(options) : "{}"], callback);
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
        host.call("ai.gpu.createPipeline", [typeof options === "object" ? JSON.stringify(options) : options], callback);
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
  }
};
`;
