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
  query: function (c) {
    return JSON.parse(__zippHostCall("db.query", String(c)));
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
