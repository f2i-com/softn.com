#!/usr/bin/env node
/**
 * SoftN Integration Test — Full Loader + Server Round-Trip
 *
 * Tests the complete lifecycle of a .softn bundle:
 * 1. Server loads the bundle (ZIP or directory) and serves it
 * 2. Client fetches manifest + .ui + .logic files (simulating softn-loader)
 * 3. Client connects via XDBServerSync WebSocket protocol
 * 4. Data flows: client xdb.create → sync_push → server SQLite → sync_pull (other clients)
 * 5. HTTP API routes also access the same SQLite data
 * 6. Security: path traversal, auth, server files protected
 */

import http from "node:http";
import { WebSocket } from "ws";

const BASE = "http://localhost:9876";
const WS_URL = "ws://localhost:9876/sync";
let pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { console.log(`  PASS: ${name}`); pass++; }
  else { console.log(`  FAIL: ${name}${detail ? "\n    " + detail : ""}`); fail++; }
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString(),
        headers: res.headers
      }));
    }).on("error", reject);
  });
}

function post(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let out = "";
      res.on("data", (c) => out += c);
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Connect a WebSocket client, mimicking XDBServerSync.createConnection() */
function connectSync(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const messages = [];
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token, appVersion: "1.0.0" }));
    });
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });
    ws.on("error", () => {});
    resolve({ ws, messages });
  });
}

function waitForMsg(messages, type, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      const found = messages.find((m) => m.type === type);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(poll, 50);
    };
    poll();
  });
}

function waitForMsgAfter(messages, type, afterIndex, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      for (let i = afterIndex; i < messages.length; i++) {
        if (messages[i].type === type) return resolve(messages[i]);
      }
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function run() {
  // ═══════════════════════════════════════════════════════
  // Phase 1: Load the .softn bundle from the server
  //   (Simulates what softn-loader does on app open)
  // ═══════════════════════════════════════════════════════
  console.log("=== Phase 1: Load .softn Bundle (Client-Side View) ===");

  // 1a. Fetch manifest (entry point for any .softn app)
  const manifestRes = await get("/manifest.json");
  check("manifest loads (200)", manifestRes.status === 200);
  const manifest = JSON.parse(manifestRes.body);
  check("manifest.name is test-app", manifest.name === "test-app");
  check("manifest.version is 1.0.0", manifest.version === "1.0.0");
  check("manifest.main points to ui/main.ui", manifest.main === "ui/main.ui");
  check("manifest has server sync config", !!manifest.config?.server?.url,
    `config=${JSON.stringify(manifest.config)}`);
  check("manifest.server block stripped (security)", !manifest.server,
    "server-side config should be hidden from clients");
  check("manifest has window config", manifest.config?.window?.title === "Notes App");

  // Extract server config (like XDBServerSync reads from manifest)
  const serverConfig = manifest.config.server;
  const authToken = serverConfig.auth_token;
  const collections = serverConfig.collections;
  check("ws url from manifest", serverConfig.url === "ws://localhost:9876/sync");
  check("auth_token from manifest", typeof authToken === "string");
  check("collections from manifest", collections?.includes("notes"));

  // 1b. Fetch the main .ui file (softn-loader reads this to render the app)
  const uiRes = await get("/ui/main.ui");
  check("main.ui loads (200)", uiRes.status === 200);
  check("main.ui has <logic> import", uiRes.body.includes('<logic src='));
  check("main.ui has <App> component", uiRes.body.includes("<App"));
  check("main.ui has xdb notes binding", uiRes.body.includes('each={getFilteredNotes()} as="note"'));
  check("main.ui has add button", uiRes.body.includes("@click={addNote}"));
  check("main.ui has delete button", uiRes.body.includes("deleteNote(note.id)"));

  // 1c. Verify server-side files are protected
  const serverBlocked = await get("/server/main.logic");
  check("server/ directory blocked (403)", serverBlocked.status === 403);

  // 1d. Health endpoint
  const health = await get("/health");
  check("health endpoint", health.body === "ok");

  // ═══════════════════════════════════════════════════════
  // Phase 2: HTTP API Routes (server-side FormLogic handlers)
  // ═══════════════════════════════════════════════════════
  console.log("\n=== Phase 2: HTTP API Routes ===");

  const hello = await get("/api/hello");
  const hj = JSON.parse(hello.body);
  check("GET /api/hello returns greeting", hj.message === "Hello from SoftN!");
  check("request method is GET", hj.method === "GET");
  check("request path correct", hj.path === "/api/hello");
  check("requestCount increments", typeof hj.requestCount === "number");

  const echo = await post("/api/echo", { msg: "from-softn-client" });
  const ej = JSON.parse(echo.body);
  check("POST /api/echo echoes body", ej.echo?.msg === "from-softn-client");
  check("echo method is POST", ej.method === "POST");

  // Create notes via HTTP API (simulates server-side db.create)
  const note1 = await post("/api/create-note", { title: "Meeting Notes", content: "Discuss Q2 roadmap" });
  check("create note 1 → 201", note1.status === 201);
  const n1 = JSON.parse(note1.body);
  check("note 1 has id", typeof n1.id === "string");

  const note2 = await post("/api/create-note", { title: "TODO List", content: "Ship v2.0" });
  check("create note 2 → 201", note2.status === 201);

  const notesRes = await get("/api/notes");
  const notesList = JSON.parse(notesRes.body);
  check("GET /api/notes returns array", Array.isArray(notesList.notes));
  check("notes count is 2", notesList.count === 2, `got ${notesList.count}`);

  // Validation
  const badNote = await post("/api/create-note", { content: "no title" });
  check("missing title → 400", badNote.status === 400);

  // ═══════════════════════════════════════════════════════
  // Phase 3: WebSocket Sync — Full XDBServerSync Protocol
  //   Simulates two .softn clients (e.g., two loader instances)
  //   syncing through the server's SQLite database
  // ═══════════════════════════════════════════════════════
  console.log("\n=== Phase 3: WebSocket Sync (XDBServerSync Protocol) ===");

  // 3a. Client A: auth using token from manifest.config.server
  console.log("  [Client A: connect + auth]");
  const clientA = await connectSync(authToken);
  const authA = await waitForMsg(clientA.messages, "auth_ok");
  check("client A: auth_ok received", !!authA);
  check("client A: has clientId", typeof authA?.clientId === "string");
  check("client A: has serverTime", typeof authA?.serverTime === "string");

  // 3b. Client A: subscribe + sync_pull (XDBServerSync.onAuthenticated flow)
  console.log("  [Client A: subscribe + sync_pull]");
  clientA.ws.send(JSON.stringify({ type: "subscribe", collections }));
  clientA.ws.send(JSON.stringify({ type: "sync_pull", collections }));

  const syncState = await waitForMsg(clientA.messages, "sync_state");
  check("client A: sync_state received", !!syncState);
  check("client A: collection is 'notes'", syncState?.collection === "notes");
  check("client A: sees HTTP-created notes", syncState?.records?.length === 2,
    `got ${syncState?.records?.length} records`);
  check("client A: record has id + data",
    syncState?.records?.[0]?.id && syncState?.records?.[0]?.data);

  // 3c. Client B: second loader instance connects
  console.log("  [Client B: connect + auth + subscribe]");
  const clientB = await connectSync(authToken);
  const authB = await waitForMsg(clientB.messages, "auth_ok");
  check("client B: auth_ok received", !!authB);
  check("client B: different clientId", authB?.clientId !== authA?.clientId);

  clientB.ws.send(JSON.stringify({ type: "subscribe", collections }));
  clientB.ws.send(JSON.stringify({ type: "sync_pull", collections }));
  const syncStateB = await waitForMsg(clientB.messages, "sync_state");
  check("client B: sees same 2 notes", syncStateB?.records?.length === 2);

  // 3d. Client A: sync_push create (xdb.create → mutation → sync_push)
  //     This simulates: user types in .ui Input → addNote() → xdb.create("notes", {...})
  //     → XDBServerSync.pushOps() → server stores in SQLite
  console.log("  [Client A: sync_push create (xdb.create)]");
  const beforePushB = clientB.messages.length;
  clientA.ws.send(JSON.stringify({
    type: "sync_push",
    ops: [{
      id: "op_1_1",
      collection: "notes",
      operation: "create",
      recordId: "rec-ws-001",
      data: { title: "Synced Note", content: "Created on Client A via xdb.create" },
      timestamp: new Date().toISOString(),
      clientId: authA.clientId,
    }]
  }));

  const ackA = await waitForMsg(clientA.messages, "sync_ack");
  check("client A: sync_ack received", !!ackA);
  check("client A: op acknowledged", ackA?.opIds?.includes("op_1_1"));

  // 3e. Client B receives broadcast (sync_delta) — real-time sync between loaders
  console.log("  [Client B: receive sync_delta broadcast]");
  const deltaB = await waitForMsgAfter(clientB.messages, "sync_delta", beforePushB);
  check("client B: sync_delta received", !!deltaB);
  check("client B: delta has 'Synced Note'",
    deltaB?.ops?.some(op => op.data?.title === "Synced Note"));
  check("client B: delta op is 'create'",
    deltaB?.ops?.some(op => op.operation === "create"));

  // 3f. Client B: sync_push (reverse direction)
  console.log("  [Client B: sync_push → Client A receives]");
  const beforePushA = clientA.messages.length;
  clientB.ws.send(JSON.stringify({
    type: "sync_push",
    ops: [{
      id: "op_2_1",
      collection: "notes",
      operation: "create",
      recordId: "rec-ws-002",
      data: { title: "Reply Note", content: "Created on Client B" },
      timestamp: new Date().toISOString(),
      clientId: authB.clientId,
    }]
  }));

  const ackB = await waitForMsg(clientB.messages, "sync_ack");
  check("client B: sync_ack received", !!ackB);

  const deltaA = await waitForMsgAfter(clientA.messages, "sync_delta", beforePushA);
  check("client A: receives Client B's broadcast", !!deltaA);
  check("client A: delta has 'Reply Note'",
    deltaA?.ops?.some(op => op.data?.title === "Reply Note"));

  // ═══════════════════════════════════════════════════════
  // Phase 4: Cross-Protocol Verification
  //   Data created via WS (simulating xdb) should be visible via HTTP API
  //   This proves the server's SQLite is the single source of truth
  // ═══════════════════════════════════════════════════════
  console.log("\n=== Phase 4: Cross-Protocol Verification (SQLite as truth) ===");

  const allNotes = await get("/api/notes");
  const allNj = JSON.parse(allNotes.body);
  check("total notes: 4 (2 HTTP + 2 WS)", allNj.count === 4, `got count=${allNj.count}`);
  check("HTTP 'Meeting Notes' in SQLite", allNj.notes.some(n => n.data.title === "Meeting Notes"));
  check("HTTP 'TODO List' in SQLite", allNj.notes.some(n => n.data.title === "TODO List"));
  check("WS 'Synced Note' in SQLite (Client A)", allNj.notes.some(n => n.data.title === "Synced Note"));
  check("WS 'Reply Note' in SQLite (Client B)", allNj.notes.some(n => n.data.title === "Reply Note"));

  // Fresh client C: sync_pull should see all 4 notes from SQLite
  console.log("  [Fresh Client C: sync_pull all from SQLite]");
  const clientC = await connectSync(authToken);
  await waitForMsg(clientC.messages, "auth_ok");
  clientC.ws.send(JSON.stringify({ type: "subscribe", collections: ["notes"] }));
  clientC.ws.send(JSON.stringify({ type: "sync_pull", collections: ["notes"] }));
  const freshState = await waitForMsg(clientC.messages, "sync_state");
  check("fresh client: sees all 4 notes via sync_pull", freshState?.records?.length === 4,
    `got ${freshState?.records?.length}`);
  clientC.ws.close();

  // ═══════════════════════════════════════════════════════
  // Phase 5: Update + Delete via XDB Sync
  //   Tests the full CRUD lifecycle through the sync protocol
  //   Note: create_record generates server-side UUIDs, so we must
  //   capture the real IDs from the sync_delta broadcasts.
  // ═══════════════════════════════════════════════════════
  console.log("\n=== Phase 5: Update + Delete via Sync ===");

  // Extract real record IDs from the sync_delta broadcasts we captured earlier
  // Client A created "Synced Note" → deltaB has the real recordId
  const syncedNoteOp = deltaB?.ops?.find(op => op.data?.title === "Synced Note");
  const syncedNoteId = syncedNoteOp?.recordId;
  check("captured 'Synced Note' real ID from delta", !!syncedNoteId,
    `recordId=${syncedNoteId}`);

  // Client B created "Reply Note" → deltaA has the real recordId
  const replyNoteOp = deltaA?.ops?.find(op => op.data?.title === "Reply Note");
  const replyNoteId = replyNoteOp?.recordId;
  check("captured 'Reply Note' real ID from delta", !!replyNoteId,
    `recordId=${replyNoteId}`);

  // 5a. Client A updates "Synced Note" using the real server-assigned ID
  const beforeUpdateB = clientB.messages.length;
  const beforeUpdateAckA = clientA.messages.length;
  clientA.ws.send(JSON.stringify({
    type: "sync_push",
    ops: [{
      id: "op_3_1",
      collection: "notes",
      operation: "update",
      recordId: syncedNoteId,
      data: { title: "Updated Synced Note", content: "Modified by Client A" },
      timestamp: new Date().toISOString(),
      clientId: authA.clientId,
    }]
  }));
  const ackUpdate = await waitForMsgAfter(clientA.messages, "sync_ack", beforeUpdateAckA);
  check("update: sync_ack received", !!ackUpdate);

  const updateDelta = await waitForMsgAfter(clientB.messages, "sync_delta", beforeUpdateB);
  check("update: Client B receives delta", !!updateDelta);
  check("update: delta has updated title",
    updateDelta?.ops?.some(op => op.data?.title === "Updated Synced Note"));

  // Verify via HTTP
  const afterUpdate = await get("/api/notes");
  const afterUpdateJ = JSON.parse(afterUpdate.body);
  check("update: HTTP shows modified note",
    afterUpdateJ.notes.some(n => n.data.title === "Updated Synced Note"));
  check("update: still 4 notes total", afterUpdateJ.count === 4, `got ${afterUpdateJ.count}`);

  // 5b. Client B deletes "Reply Note" using its real server-assigned ID
  const beforeDeleteA = clientA.messages.length;
  const beforeDeleteAckB = clientB.messages.length;
  clientB.ws.send(JSON.stringify({
    type: "sync_push",
    ops: [{
      id: "op_4_1",
      collection: "notes",
      operation: "delete",
      recordId: replyNoteId,
      timestamp: new Date().toISOString(),
      clientId: authB.clientId,
    }]
  }));
  const ackDelete = await waitForMsgAfter(clientB.messages, "sync_ack", beforeDeleteAckB);
  check("delete: sync_ack received", !!ackDelete);

  const deleteDelta = await waitForMsgAfter(clientA.messages, "sync_delta", beforeDeleteA);
  check("delete: Client A receives delta", !!deleteDelta);
  check("delete: delta op is 'delete'",
    deleteDelta?.ops?.some(op => op.operation === "delete"));

  // Verify via HTTP
  const afterDelete = await get("/api/notes");
  const afterDeleteJ = JSON.parse(afterDelete.body);
  check("delete: 3 notes remaining", afterDeleteJ.count === 3, `got ${afterDeleteJ.count}`);
  check("delete: 'Reply Note' is gone",
    !afterDeleteJ.notes.some(n => n.data.title === "Reply Note"));

  // ═══════════════════════════════════════════════════════
  // Phase 6: Error Handling & Security
  // ═══════════════════════════════════════════════════════
  console.log("\n=== Phase 6: Security & Error Handling ===");

  // Wrong token
  const badAuth = await connectSync("wrong-token");
  const authErr = await waitForMsg(badAuth.messages, "auth_error");
  check("wrong token → auth_error", !!authErr);
  check("error message is generic", authErr?.reason === "Authentication failed",
    `reason=${authErr?.reason}`);
  badAuth.ws.close();

  // Server-side files blocked
  const dataBlocked = await get("/data/test-app.sqlite");
  check("data/ directory blocked", dataBlocked.status === 403 || dataBlocked.status === 404);

  // Path traversal (percent-encoded)
  const traversal = await get("/ui/%2e%2e/server/main.logic");
  check("percent-encoded traversal blocked", traversal.status === 403 || traversal.status === 404,
    `status=${traversal.status}`);

  // Double-encoded traversal
  const dblTraversal = await get("/ui/%252e%252e/server/main.logic");
  check("double-encoded traversal blocked", dblTraversal.status === 403 || dblTraversal.status === 404,
    `status=${dblTraversal.status}`);

  // Backslash traversal (Windows)
  const bsTraversal = await get("/ui/..\\server\\main.logic");
  check("backslash traversal blocked", bsTraversal.status === 403 || bsTraversal.status === 404,
    `status=${bsTraversal.status}`);

  // Null byte
  const nullByte = await get("/ui/main.ui%00.logic");
  check("null byte injection blocked", nullByte.status === 403 || nullByte.status === 404,
    `status=${nullByte.status}`);

  // logic/ not served
  const logicDir = await get("/logic/main.logic");
  check("logic/ not in served dirs", logicDir.status === 403 || logicDir.status === 404);

  // ═══════════════════════════════════════════════════════
  // Phase 7: Edge Cases — Malformed Protocol Messages
  // ═══════════════════════════════════════════════════════
  console.log("\n=== Phase 7: Edge Cases ===");

  const edgeClient = await connectSync(authToken);
  await waitForMsg(edgeClient.messages, "auth_ok");

  // Malformed ops (string instead of array)
  const beforeMalformed = edgeClient.messages.length;
  edgeClient.ws.send(JSON.stringify({ type: "sync_push", ops: "not_an_array" }));
  const malformedErr = await waitForMsgAfter(edgeClient.messages, "error", beforeMalformed);
  check("malformed ops → error", !!malformedErr);

  // Missing ops field
  const beforeNoOps = edgeClient.messages.length;
  edgeClient.ws.send(JSON.stringify({ type: "sync_push" }));
  const noOpsErr = await waitForMsgAfter(edgeClient.messages, "error", beforeNoOps);
  check("missing ops → error", !!noOpsErr);

  // Invalid collection name (path traversal in collection)
  const beforeBadColl = edgeClient.messages.length;
  edgeClient.ws.send(JSON.stringify({
    type: "sync_push",
    ops: [{ id: "op-bad", collection: "../evil", operation: "create", data: {} }]
  }));
  const badCollResp = await waitForMsgAfter(edgeClient.messages, "sync_reject", beforeBadColl);
  check("invalid collection → sync_reject", !!badCollResp);

  // Unknown message type (should not crash)
  edgeClient.ws.send(JSON.stringify({ type: "nonexistent_type" }));
  await new Promise(r => setTimeout(r, 200));
  check("unknown message type doesn't crash", edgeClient.ws.readyState === WebSocket.OPEN);

  // Clean up
  edgeClient.ws.close();
  clientA.ws.close();
  clientB.ws.close();

  // ═══════════════════════════════════════════════════════
  // Results
  // ═══════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(55)}`);
  console.log(`SoftN Integration Test: ${pass} passed, ${fail} failed`);
  console.log(`${"=".repeat(55)}`);
  process.exit(fail);
}

run().catch((e) => { console.error("Fatal:", e); process.exit(1); });
