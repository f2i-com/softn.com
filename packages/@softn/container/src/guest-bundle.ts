/**
 * Guest-side Platform Modules (`softn:bundle`, `softn:files`, `softn:apps`, `softn:runtime`).
 *
 * Injected into the sandboxed ZIPP VM alongside `GUEST_EXTENSIONS_SOURCE` so
 * sandboxed applications can build validated `.softn` bundles, stream large
 * binary files in bounded chunks, preview generated apps in isolated nested
 * containers, offer binary bundles to FormLogic/host deployment dialogs, and
 * discover live runtime capabilities & limits.
 */
export const GUEST_BUNDLE_MODULES_SOURCE = String.raw`
(function () {
  var g = globalThis;
  if (typeof __softnModules === 'undefined' || typeof host === 'undefined') return;

  var CHUNK_BYTES = 2 * 1024 * 1024; // 2 MiB raw (~2.67 MiB base64) — safely under ZIPP's 16 MiB bridge cap

  function b64FromBytes(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var out = '';
    for (var i = 0; i < u8.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return g.btoa(out);
  }

  function bytesFromB64(b64) {
    if (!b64) return new Uint8Array(0);
    if (typeof g.__softnBytesFrom64 === 'function') return g.__softnBytesFrom64(b64);
    var bin = g.atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toUint8(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof input === 'string') return new g.TextEncoder().encode(input);
    throw new TypeError('Expected Uint8Array, ArrayBuffer, or string');
  }

  function hostCallAsync(kind, args) {
    return new Promise(function (resolve, reject) {
      host.call(kind, args, function (reply) {
        if (!reply || reply.error) {
          reject(new Error(reply && reply.error ? String(reply.error) : (kind + ' failed')));
        } else {
          resolve(reply.result);
        }
      });
    });
  }

  async function stageBytesToWorker(rawBytes) {
    var u8 = toUint8(rawBytes);
    var started = await hostCallAsync('bytes.stage.open', [String(u8.byteLength)]);
    var token = started.token;
    if (u8.byteLength === 0) {
      await hostCallAsync('bytes.stage.chunk', [token, '', '1']);
      return token;
    }
    for (var off = 0; off < u8.byteLength; off += CHUNK_BYTES) {
      var end = Math.min(u8.byteLength, off + CHUNK_BYTES);
      var isLast = end >= u8.byteLength;
      await hostCallAsync('bytes.stage.chunk', [token, b64FromBytes(u8.subarray(off, end)), isLast ? '1' : '0']);
    }
    return token;
  }

  async function readStagedBytesFromWorker(token, totalLength) {
    var len = Number(totalLength) || 0;
    if (len === 0) {
      await hostCallAsync('bytes.read.close', [token]).catch(function () {});
      return new Uint8Array(0);
    }
    var out = new Uint8Array(len);
    var offset = 0;
    try {
      while (offset < len) {
        var want = Math.min(CHUNK_BYTES, len - offset);
        var res = await hostCallAsync('bytes.read.chunk', [token, String(offset), String(want)]);
        var chunk = bytesFromB64(res && res.base64 ? res.base64 : '');
        if (chunk.byteLength === 0) break;
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } finally {
      await hostCallAsync('bytes.read.close', [token]).catch(function () {});
    }
    return offset === len ? out : out.subarray(0, offset);
  }

  // Expose chunk helpers for softn:sqlite binary import/export
  g.__softnStageBytes = stageBytesToWorker;
  g.__softnReadStagedBytes = readStagedBytesFromWorker;

  // ---------------------------------------------------------------------------
  // 1. 'softn:bundle' — Application Packaging SDK
  // ---------------------------------------------------------------------------
  function makeBuiltBundleHandle(meta) {
    var token = meta.artifactToken;
    var cachedBytes = null;
    var disposed = false;
    var handle = {
      artifactToken: token,
      artifactId: token,
      size: meta.size,
      sha256: meta.sha256,
      fileCount: meta.fileCount,
      manifest: meta.manifest,
      inspection: meta.inspection,
      validation: meta.validation,
      getBytes: async function () {
        if (cachedBytes) return cachedBytes.slice();
        if (disposed) throw new Error('Bundle artifact has been disposed');
        var opened = await hostCallAsync('bundle.op', ['open_bytes', JSON.stringify([token])]);
        cachedBytes = await readStagedBytesFromWorker(opened.readToken, opened.byteLength);
        return cachedBytes.slice();
      },
      bytes: function () {
        return this.getBytes();
      },
      download: async function (filename) {
        if (disposed) throw new Error('Bundle artifact has been disposed');
        var fname = typeof filename === 'string' && filename.trim()
          ? filename.trim()
          : ((meta.manifest && meta.manifest.id ? String(meta.manifest.id) : 'app') + '.softn');
        return hostCallAsync('bundle.op', ['download', JSON.stringify([token, fname])]);
      },
      dispose: async function () {
        if (disposed) return;
        disposed = true;
        cachedBytes = null;
        await hostCallAsync('bundle.op', ['dispose_built', JSON.stringify([token])]).catch(function () {});
      },
    };
    return handle;
  }

  function createBundleBuilder(options) {
    var ops = [];
    var filesMap = Object.create(null);
    var builderApi = {
      addText: function (path, content) {
        var p = String(path);
        var text = String(content);
        filesMap[p] = 'text';
        ops.push({ kind: 'text', path: p, content: text });
        return builderApi;
      },
      addBinary: function (path, data) {
        var p = String(path);
        var bytes = toUint8(data).slice();
        filesMap[p] = 'binary';
        ops.push({ kind: 'binary', path: p, bytes: bytes });
        return builderApi;
      },
      addJson: function (path, value) {
        var p = String(path);
        filesMap[p] = 'text';
        ops.push({ kind: 'json', path: p, value: value });
        return builderApi;
      },
      remove: function (path) {
        var p = String(path);
        delete filesMap[p];
        ops.push({ kind: 'remove', path: p });
        return builderApi;
      },
      has: function (path) {
        return Object.prototype.hasOwnProperty.call(filesMap, String(path));
      },
      listFiles: function () {
        return Object.keys(filesMap).sort();
      },
      setPermissions: function (permissions) {
        ops.push({ kind: 'permissions', permissions: permissions || {} });
        return builderApi;
      },
      _materialize: async function () {
        var created = await hostCallAsync('bundle.op', ['create', JSON.stringify([options || {}])]);
        var sid = created.sessionId;
        try {
          for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (op.kind === 'text') {
              await hostCallAsync('bundle.op', ['add_text', JSON.stringify([sid, op.path, op.content])]);
            } else if (op.kind === 'json') {
              await hostCallAsync('bundle.op', ['add_json', JSON.stringify([sid, op.path, op.value])]);
            } else if (op.kind === 'remove') {
              await hostCallAsync('bundle.op', ['remove', JSON.stringify([sid, op.path])]);
            } else if (op.kind === 'permissions') {
              await hostCallAsync('bundle.op', ['set_permissions', JSON.stringify([sid, op.permissions])]);
            } else if (op.kind === 'binary') {
              var u8 = op.bytes;
              if (u8.byteLength === 0) {
                await hostCallAsync('bundle.op', ['add_binary_chunk', JSON.stringify([sid, op.path, '', true])]);
              } else {
                for (var off = 0; off < u8.byteLength; off += CHUNK_BYTES) {
                  var end = Math.min(u8.byteLength, off + CHUNK_BYTES);
                  var isLast = end >= u8.byteLength;
                  await hostCallAsync('bundle.op', [
                    'add_binary_chunk',
                    JSON.stringify([sid, op.path, b64FromBytes(u8.subarray(off, end)), isLast]),
                  ]);
                }
              }
            }
          }
          return sid;
        } catch (err) {
          await hostCallAsync('bundle.op', ['dispose_session', JSON.stringify([sid])]).catch(function () {});
          throw err;
        }
      },
      validate: async function () {
        var sid = await builderApi._materialize();
        try {
          return await hostCallAsync('bundle.op', ['validate', JSON.stringify([sid])]);
        } finally {
          await hostCallAsync('bundle.op', ['dispose_session', JSON.stringify([sid])]).catch(function () {});
        }
      },
      build: async function (buildOpts) {
        var sid = await builderApi._materialize();
        try {
          var meta = await hostCallAsync('bundle.op', ['build', JSON.stringify([sid, buildOpts || {}])]);
          return makeBuiltBundleHandle(meta);
        } finally {
          await hostCallAsync('bundle.op', ['dispose_session', JSON.stringify([sid])]).catch(function () {});
        }
      },
    };
    return builderApi;
  }

  var softnBundle = {
    create: createBundleBuilder,
    inspect: async function (bytes) {
      var token = await stageBytesToWorker(bytes);
      return hostCallAsync('bundle.op', ['inspect_staged', JSON.stringify([token])]);
    },
    validate: async function (bytes) {
      var token = await stageBytesToWorker(bytes);
      return hostCallAsync('bundle.op', ['validate_staged', JSON.stringify([token])]);
    },
  };

  // ---------------------------------------------------------------------------
  // 2. 'softn:files' — Bounded Chunked Large Binary File Import & Export
  // ---------------------------------------------------------------------------
  function makePickedFileHandle(meta) {
    var closed = false;
    var handle = {
      id: meta.id,
      name: meta.name,
      size: meta.size,
      type: meta.type || 'application/octet-stream',
      lastModified: meta.lastModified || 0,
      readChunk: async function (offset, length) {
        if (closed) throw new Error('File handle is closed');
        var off = Math.max(0, Math.floor(Number(offset) || 0));
        var len = Math.max(0, Math.min(4 * 1024 * 1024, Math.floor(Number(length) || 512 * 1024)));
        if (off >= handle.size || len === 0) return new Uint8Array(0);
        var res = await hostCallAsync('files.op', ['read_chunk', JSON.stringify([handle.id, off, len])]);
        return bytesFromB64(res && res.base64 ? res.base64 : '');
      },
      chunks: function (opts) {
        var o = opts || {};
        var chunkSize = Math.max(4096, Math.min(2 * 1024 * 1024, Math.floor(Number(o.chunkSize) || 512 * 1024)));
        var signal = o.signal;
        var onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
        return {
          [Symbol.asyncIterator]: function () {
            var pos = 0;
            return {
              next: async function () {
                if (signal && signal.aborted) {
                  throw new Error(signal.reason ? String(signal.reason) : 'File read aborted');
                }
                if (closed || pos >= handle.size) {
                  return { value: undefined, done: true };
                }
                var chunk = await handle.readChunk(pos, Math.min(chunkSize, handle.size - pos));
                if (chunk.byteLength === 0) {
                  return { value: undefined, done: true };
                }
                pos += chunk.byteLength;
                if (onProgress) {
                  onProgress({
                    loaded: pos,
                    total: handle.size,
                    percent: handle.size > 0 ? Math.min(100, Math.round((pos / handle.size) * 100)) : 100,
                  });
                }
                return { value: chunk, done: false };
              },
            };
          },
        };
      },
      bytes: async function (opts) {
        var o = opts || {};
        var maxBytes = typeof o.maxBytes === 'number' && o.maxBytes > 0 ? o.maxBytes : 64 * 1024 * 1024;
        if (handle.size > maxBytes) {
          throw new Error('File "' + handle.name + '" (' + handle.size + ' bytes) exceeds maxBytes (' + maxBytes + ')');
        }
        var out = new Uint8Array(handle.size);
        var at = 0;
        var iter = handle.chunks(o)[Symbol.asyncIterator]();
        while (true) {
          var step = await iter.next();
          if (step.done) break;
          out.set(step.value, at);
          at += step.value.byteLength;
        }
        return at === out.byteLength ? out : out.subarray(0, at);
      },
      arrayBuffer: async function (opts) {
        var b = await handle.bytes(opts);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      text: async function (opts) {
        var b = await handle.bytes(opts);
        return new g.TextDecoder().decode(b);
      },
      close: async function () {
        if (closed) return;
        closed = true;
        await hostCallAsync('files.op', ['close', JSON.stringify([handle.id])]).catch(function () {});
      },
    };
    return handle;
  }

  var softnFiles = {
    pick: async function (opts) {
      var o = opts || {};
      var res = await hostCallAsync('files.op', ['pick', JSON.stringify([o])]);
      if (!res || !Array.isArray(res.files) || res.files.length === 0) {
        return o.multiple ? [] : null;
      }
      var handles = res.files.map(makePickedFileHandle);
      return o.multiple ? handles : handles[0];
    },
    createWriter: async function (opts) {
      var o = opts || {};
      var opened = await hostCallAsync('files.op', ['writer_open', JSON.stringify([o])]);
      var writerId = opened.writerId;
      var closed = false;
      var written = 0;
      return {
        id: writerId,
        name: opened.name,
        get bytesWritten() { return written; },
        write: async function (chunk) {
          if (closed) throw new Error('File writer is already closed');
          var u8 = toUint8(chunk);
          if (u8.byteLength === 0) return { bytesWritten: written };
          for (var off = 0; off < u8.byteLength; off += CHUNK_BYTES) {
            var end = Math.min(u8.byteLength, off + CHUNK_BYTES);
            var res = await hostCallAsync('files.op', [
              'writer_write',
              JSON.stringify([writerId, b64FromBytes(u8.subarray(off, end))]),
            ]);
            written = res && typeof res.bytesWritten === 'number' ? res.bytesWritten : written + (end - off);
          }
          return { bytesWritten: written };
        },
        close: async function () {
          if (closed) throw new Error('File writer is already closed');
          closed = true;
          return hostCallAsync('files.op', ['writer_close', JSON.stringify([writerId])]);
        },
        abort: async function () {
          if (closed) return { aborted: true };
          closed = true;
          return hostCallAsync('files.op', ['writer_abort', JSON.stringify([writerId])]);
        },
      };
    },
    save: async function (opts) {
      var o = opts || {};
      var writer = await softnFiles.createWriter({ name: o.name || 'download.bin', type: o.type, maxBytes: o.maxBytes });
      try {
        if (o.bytes !== undefined) await writer.write(o.bytes);
        else if (o.text !== undefined) await writer.write(String(o.text));
        return await writer.close();
      } catch (err) {
        await writer.abort().catch(function () {});
        throw err;
      }
    },
  };

  // ---------------------------------------------------------------------------
  // 3. 'softn:apps' — Dynamic Nested App Previews & Host Deployment Handoff
  // ---------------------------------------------------------------------------
  async function resolveArtifactSource(artifact) {
    if (!artifact) throw new TypeError('Expected a built bundle artifact or Uint8Array');
    if (typeof artifact === 'object' && typeof artifact.artifactToken === 'string' && artifact.artifactToken) {
      return { artifactToken: artifact.artifactToken };
    }
    var stageToken = await stageBytesToWorker(artifact);
    return { stageToken: stageToken };
  }

  var softnApps = {
    preview: async function (opts) {
      var o = opts || {};
      var src = await resolveArtifactSource(o.artifact);
      var targetId = '';
      var targetNodeId = 0;
      if (typeof o.target === 'string') {
        targetId = o.target.replace(/^#/, '');
      } else if (o.target && typeof o.target === 'object') {
        if (typeof o.target._softnId === 'number') targetNodeId = o.target._softnId;
        else if (typeof o.target.id === 'string') targetId = o.target.id;
      }
      if (!targetId && !targetNodeId) {
        throw new TypeError('apps.preview requires a target element or target element id');
      }
      var res = await hostCallAsync('apps.op', [
        'preview_mount',
        JSON.stringify([
          {
            artifactToken: src.artifactToken,
            stageToken: src.stageToken,
            targetId: targetId || undefined,
            targetNodeId: targetNodeId || undefined,
            initialPath: typeof o.initialPath === 'string' ? o.initialPath : undefined,
            persistence: 'temporary',
          },
        ]),
      ]);
      var previewId = res.previewId;
      var disposed = false;
      return {
        id: previewId,
        artifactId: res.artifactId,
        manifest: res.manifest,
        navigate: async function (path) {
          if (disposed) throw new Error('Preview has been disposed');
          return hostCallAsync('apps.op', ['preview_navigate', JSON.stringify([previewId, String(path || '/')])]);
        },
        dispose: async function () {
          if (disposed) return;
          disposed = true;
          await hostCallAsync('apps.op', ['preview_dispose', JSON.stringify([previewId])]).catch(function () {});
        },
      };
    },
    offerToHost: async function (opts) {
      var o = opts || {};
      var src = await resolveArtifactSource(o.artifact);
      return hostCallAsync('apps.op', [
        'offer_to_host',
        JSON.stringify([
          {
            artifactToken: src.artifactToken,
            stageToken: src.stageToken,
            name: typeof o.name === 'string' ? o.name : undefined,
            operation: o.operation === 'update' ? 'update' : 'create',
            targetAppId: typeof o.targetAppId === 'string' ? o.targetAppId : undefined,
            metadata: o.metadata && typeof o.metadata === 'object' ? o.metadata : undefined,
          },
        ]),
      ]);
    },
  };

  // ---------------------------------------------------------------------------
  // 4. 'softn:runtime' — Read-Only Host Capability & Limit Discovery
  // ---------------------------------------------------------------------------
  var softnRuntime = {
    capabilities: function () {
      return hostCallAsync('runtime.capabilities', []);
    },
  };

  g.softn = g.softn || {};
  g.softn.bundle = softnBundle;
  g.softn.files = softnFiles;
  g.softn.apps = softnApps;
  g.softn.runtime = softnRuntime;

  __softnModules.define('softn:bundle', async function (__exports) {
    __exports.bundle = softnBundle;
    __exports.create = softnBundle.create;
    __exports.inspect = softnBundle.inspect;
    __exports.validate = softnBundle.validate;
    __exports.default = softnBundle;
  });

  __softnModules.define('softn:files', async function (__exports) {
    __exports.files = softnFiles;
    __exports.pick = softnFiles.pick;
    __exports.createWriter = softnFiles.createWriter;
    __exports.save = softnFiles.save;
    __exports.default = softnFiles;
  });

  __softnModules.define('softn:apps', async function (__exports) {
    __exports.apps = softnApps;
    __exports.preview = softnApps.preview;
    __exports.offerToHost = softnApps.offerToHost;
    __exports.default = softnApps;
  });

  __softnModules.define('softn:runtime', async function (__exports) {
    __exports.runtime = softnRuntime;
    __exports.capabilities = softnRuntime.capabilities;
    __exports.default = softnRuntime;
  });
})();
`;
