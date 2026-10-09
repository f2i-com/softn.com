// Host bridge preamble, prepended to every server script the engine compiles.
//
// The engine this replaces implemented `db`, `http`, `fs` and `env` as VM
// builtins in Rust. zipp is a plain JavaScript engine, so they are ordinary JS
// here and the only channel to the host is __zippHostCall — strings in, one
// string out, anything structured crossing as JSON.
//
// Every call is synchronous by necessity: handlers do `let rows = db.query(c)`
// mid-expression and have nothing to await on.
//
// `console` is defined here too. It streams straight to the host's tracing
// subscriber rather than buffering in the VM, so runaway logging cannot grow
// the heap — and being declared here means the runtime treats it as plumbing
// rather than as a script global it has to isolate between requests.

var db = {
  // The records of a collection, or with a filter those whose data has every
  // one of its fields with that value: what db.query(collection, filter) is
  // in a page's logic. The second argument used to be dropped, so
  // db.query("notes", {owner: id}) answered with everybody's notes.
  // The host applies the filter in its query, so the 10,000 records it
  // reads at most (pool.rs, MAX_COLLECTION_ROWS) are 10,000 that match;
  // filtered here alone, as it first was, a match past the oldest 10,000
  // records of a collection was never found. What comes back is filtered
  // here as well: this is the comparison a script means, and the host's is
  // allowed to be a little wider.
  query: function (c, filter) {
    if (filter === undefined || filter === null || typeof filter !== "object") {
      return JSON.parse(__zippHostCall("db.query", String(c)));
    }
    var keys = Object.keys(filter);
    var rows = JSON.parse(keys.length === 0
      ? __zippHostCall("db.query", String(c))
      : __zippHostCall("db.query", String(c), JSON.stringify(filter)));
    if (keys.length === 0) return rows;
    var has = Object.prototype.hasOwnProperty;
    return rows.filter(function (row) {
      var data = row.data;
      if (data === null || typeof data !== "object") return false;
      for (var i = 0; i < keys.length; i++) {
        if (!has.call(data, keys[i]) || data[keys[i]] !== filter[keys[i]]) return false;
      }
      return true;
    });
  },
  get: function (c, id) {
    return JSON.parse(__zippHostCall("db.get", String(c), String(id)));
  },
  create: function (c, d) {
    return JSON.parse(__zippHostCall("db.create", String(c), JSON.stringify(d === undefined ? {} : d)));
  },
  update: function (id, d) {
    return JSON.parse(__zippHostCall("db.update", String(id), JSON.stringify(d === undefined ? {} : d)));
  },
  // Write only if the record's top-level `field` still equals `expected`:
  // {updated: true, record} or {updated: false, reason: "conflict" | "missing"}.
  updateIf: function (id, d, field, expected) {
    return JSON.parse(__zippHostCall("db.updateIf", String(id), JSON.stringify(d === undefined ? {} : d), String(field), JSON.stringify(expected === undefined ? null : expected)));
  },
  delete: function (id) { __zippHostCall("db.delete", String(id)); },
  hardDelete: function (c, id) { __zippHostCall("db.hardDelete", String(c), String(id)); },
  startSync: function (room) { __zippHostCall("db.startSync", String(room)); },
  stopSync: function (room) { __zippHostCall("db.stopSync", room === undefined ? "" : String(room)); },
  getSyncStatus: function (room) {
    return JSON.parse(__zippHostCall("db.getSyncStatus", room === undefined ? "" : String(room)));
  },
  getSavedSyncRoom: function () { return JSON.parse(__zippHostCall("db.getSavedSyncRoom")); },
};

// A body that is not already a string is sent as JSON, which is what a script
// passing an object plainly means. Content-Type follows the same decision so
// the two can never disagree.
function __zBody(b) {
  return typeof b === "string" ? b : JSON.stringify(b === undefined ? null : b);
}
function __zType(b, t) {
  if (t !== undefined && t !== null) return String(t);
  return typeof b === "string" ? "text/plain" : "application/json";
}

var http = {
  get: function (url) {
    return JSON.parse(__zippHostCall("http.get", String(url)));
  },
  post: function (url, body, contentType) {
    return JSON.parse(__zippHostCall("http.post", String(url), __zBody(body), __zType(body, contentType)));
  },
  put: function (url, body, contentType) {
    return JSON.parse(__zippHostCall("http.put", String(url), __zBody(body), __zType(body, contentType)));
  },
  delete: function (url) {
    return JSON.parse(__zippHostCall("http.delete", String(url)));
  },
};

var fs = {
  readFile: function (p) { return __zippHostCall("fs.readFile", String(p)); },
  writeFile: function (p, c) { __zippHostCall("fs.writeFile", String(p), String(c)); },
  appendFile: function (p, c) { __zippHostCall("fs.appendFile", String(p), String(c)); },
  exists: function (p) { return JSON.parse(__zippHostCall("fs.exists", String(p))); },
  listDir: function (p) { return JSON.parse(__zippHostCall("fs.listDir", String(p))); },
  deleteFile: function (p) { __zippHostCall("fs.deleteFile", String(p)); },
  mkdir: function (p) { __zippHostCall("fs.mkdir", String(p)); },
};

var env = {
  get: function (name) { return JSON.parse(__zippHostCall("env.get", String(name))); },
  keys: function () { return JSON.parse(__zippHostCall("env.keys")); },
  log: function (level, message) { __zippHostCall("env.log", String(level), String(message)); },
};

function __zFmt(a, b, c, d, e, f, g, h, i, j) {
  var s = "" + a;
  if (b !== undefined) { s = s + " " + b; }
  if (c !== undefined) { s = s + " " + c; }
  if (d !== undefined) { s = s + " " + d; }
  if (e !== undefined) { s = s + " " + e; }
  if (f !== undefined) { s = s + " " + f; }
  if (g !== undefined) { s = s + " " + g; }
  if (h !== undefined) { s = s + " " + h; }
  if (i !== undefined) { s = s + " " + i; }
  if (j !== undefined) { s = s + " " + j; }
  return s;
}

var console = {
  log: function (a, b, c, d, e, f, g, h, i, j) { env.log("INFO", __zFmt(a, b, c, d, e, f, g, h, i, j)); },
  warn: function (a, b, c, d, e, f, g, h, i, j) { env.log("WARN", __zFmt(a, b, c, d, e, f, g, h, i, j)); },
  error: function (a, b, c, d, e, f, g, h, i, j) { env.log("ERROR", __zFmt(a, b, c, d, e, f, g, h, i, j)); },
  info: function (a, b, c, d, e, f, g, h, i, j) { env.log("INFO", __zFmt(a, b, c, d, e, f, g, h, i, j)); },
};

// Server API v1: capability-scoped native bridges.
function __softnRpc(kind, args) {
  var values = [kind];
  for (var i = 0; i < args.length; i++) values.push(String(args[i]));
  return JSON.parse(__zippHostCall.apply(null, values));
}
var __softnConfig = __softnRpc('server.config', []);
// softn.config is the app's own settings (the manifest's config.app) with the
// operator's two flags over them, as on the PHP host: an app key named
// `development` cannot turn development on. It is frozen all the way down:
// settings are for reading. (It was frozen when a VM outlived its request, so
// that one handler could not change a setting for the next; every request
// now has a VM of its own, and the settings stay read-only.)
function __softnFreeze(value) {
  if (value !== null && typeof value === 'object') {
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) __softnFreeze(value[keys[i]]);
    Object.freeze(value);
  }
  return value;
}
var __softnSettings = {};
if (__softnConfig.app !== null && typeof __softnConfig.app === 'object' && !Array.isArray(__softnConfig.app)) {
  var __softnAppKeys = Object.keys(__softnConfig.app);
  for (var __softnI = 0; __softnI < __softnAppKeys.length; __softnI++) {
    __softnSettings[__softnAppKeys[__softnI]] = __softnConfig.app[__softnAppKeys[__softnI]];
  }
}
__softnSettings.development = __softnConfig.development === true;
__softnSettings.photos = __softnConfig.photos === true;
var softn = {
  serverApiVersion: __softnConfig.apiVersion,
  config: __softnFreeze(__softnSettings),
  media: Object.freeze({sanitizePhoto: function(dataUrl) { return __softnRpc("media.sanitizePhoto", [dataUrl]); }}),
  sql: Object.freeze({
    query: function(sql, params) { return __softnRpc('sql.query', [sql, JSON.stringify(params || [])]); },
    first: function(sql, params) { return __softnRpc('sql.first', [sql, JSON.stringify(params || [])]); },
    execute: function(sql, params) { return __softnRpc('sql.execute', [sql, JSON.stringify(params || [])]); }
  }),
  crypto: Object.freeze({
    sha256: function(text) { return __softnRpc('crypto.sha256', [text]); },
    hmac: function(text) { return __softnRpc('crypto.hmac', [text]); },
    randomHex: function(bytes) { return __softnRpc('crypto.randomHex', [bytes]); },
    randomInt: function(max) { return __softnRpc('crypto.randomInt', [max]); },
    equal: function(a, b) { return __softnRpc('crypto.equal', [a, b]); },
    seal: function(text) { return __softnRpc('crypto.seal', [text]); }
  }),
  time: Object.freeze({
    now: function() { return __softnRpc('time.now', []); },
    // No zone, a null one or an empty one is UTC, as on the PHP host. A null
    // (a column with nothing in it, say) used to cross as the text "null",
    // which is no zone, and the call failed.
    age: function(date, zone) { return __softnRpc('time.age', [date, zone === undefined || zone === null || zone === '' ? 'UTC' : zone]); },
    parseZoned: function(date, time, zone) { return __softnRpc('time.parseZoned', [date, time, zone]); },
    format: function(epoch, zone) { return __softnRpc('time.format', [epoch, zone]); }
  })
};
Object.freeze(softn);
