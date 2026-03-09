import json, asyncio
import websockets

PASS = 0
FAIL = 0

def ok(name):
    global PASS
    PASS += 1
    print(f"  PASS: {name}")

def fail(name, detail=""):
    global FAIL
    FAIL += 1
    print(f"  FAIL: {name} -- {detail}")

async def test_ws():
    print("=== WebSocket Tests ===")

    # 1: Auth flow
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "auth_ok" and "clientId" in resp and "serverTime" in resp:
                ok("auth flow + serverTime")
            else:
                fail("auth flow", str(resp))
    except Exception as e:
        fail("auth flow", str(e))

    # 2: Bad first message
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "subscribe"}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "error":
                ok("bad first msg rejected")
            else:
                fail("bad first msg rejected", str(resp))
    except Exception as e:
        fail("bad first msg rejected", str(e))

    # 3: Invalid JSON
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send("not json")
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "error":
                ok("invalid JSON error")
            else:
                fail("invalid JSON error", str(resp))
    except Exception as e:
        fail("invalid JSON error", str(e))

    # 4: sync_pull empty collection
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({"type": "sync_pull", "collections": ["nonexistent"]}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "sync_state" and resp.get("records") == []:
                ok("sync_pull empty collection")
            else:
                fail("sync_pull empty collection", str(resp))
    except Exception as e:
        fail("sync_pull empty collection", str(e))

    # 5: sync_pull notes
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({"type": "sync_pull", "collections": ["notes"]}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "sync_state" and len(resp.get("records", [])) > 0:
                ok("sync_pull notes")
            else:
                fail("sync_pull notes", str(resp))
    except Exception as e:
        fail("sync_pull notes", str(e))

    # 6: sync_push create + ack + broadcast + clientId stamped
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws1, \
                   websockets.connect("ws://localhost:3001/sync") as ws2:
            await ws1.send(json.dumps({"type": "auth"}))
            r1 = json.loads(await asyncio.wait_for(ws1.recv(), timeout=5))
            cid1 = r1["clientId"]
            await ws2.send(json.dumps({"type": "auth"}))
            r2 = json.loads(await asyncio.wait_for(ws2.recv(), timeout=5))

            await ws1.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "test-op-1",
                    "collection": "notes",
                    "operation": "create",
                    "data": {"title": "Broadcast test"},
                    "timestamp": "2025-01-01T00:00:00Z"
                }]
            }))

            # Client1 should get sync_ack
            ack = json.loads(await asyncio.wait_for(ws1.recv(), timeout=5))
            if ack.get("type") == "sync_ack" and "test-op-1" in ack.get("opIds", []):
                ok("sync_push ack")
            else:
                fail("sync_push ack", str(ack))

            # Client2 should get broadcast with correct clientId stamped
            delta = json.loads(await asyncio.wait_for(ws2.recv(), timeout=5))
            if delta.get("type") == "sync_delta":
                ok("broadcast to other client")
                ops = delta.get("ops", [])
                if ops and ops[0].get("clientId") == cid1:
                    ok("clientId stamped on broadcast")
                else:
                    fail("clientId stamped", f"expected {cid1}, got {ops[0].get('clientId', '') if ops else 'no ops'}")
            else:
                fail("broadcast to other client", str(delta))

    except Exception as e:
        fail("sync_push + broadcast", str(e))

    # 7: delete rejected by onBeforeSync hook
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "test-del-1",
                    "collection": "notes",
                    "operation": "delete",
                    "data": {},
                    "recordId": "some-id",
                    "timestamp": "2025-01-01T00:00:00Z"
                }]
            }))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "sync_reject":
                ok("delete rejected by hook")
            else:
                fail("delete rejected by hook", str(resp))
    except Exception as e:
        fail("delete rejected by hook", str(e))

    # 8: Self-echo prevention
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "echo-test",
                    "collection": "notes",
                    "operation": "create",
                    "data": {"title": "Echo check"},
                    "timestamp": "2025-01-01T00:00:00Z"
                }]
            }))
            ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if ack.get("type") != "sync_ack":
                fail("self-echo prevention", f"expected sync_ack, got {ack.get('type')}")
            else:
                try:
                    extra = await asyncio.wait_for(ws.recv(), timeout=1)
                    extra_parsed = json.loads(extra)
                    if extra_parsed.get("type") == "sync_delta":
                        fail("self-echo prevention", "got own broadcast back")
                    else:
                        ok("self-echo prevention")
                except asyncio.TimeoutError:
                    ok("self-echo prevention")
    except Exception as e:
        fail("self-echo prevention", str(e))

    # 9: Broadcast has server-generated recordId
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws1, \
                   websockets.connect("ws://localhost:3001/sync") as ws2:
            await ws1.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws1.recv(), timeout=5)
            await ws2.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws2.recv(), timeout=5)

            await ws1.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "rid-test",
                    "collection": "notes",
                    "operation": "create",
                    "data": {"title": "RecordId test"},
                    "timestamp": "2025-01-01T00:00:00Z"
                }]
            }))
            await asyncio.wait_for(ws1.recv(), timeout=5)  # ack
            delta = json.loads(await asyncio.wait_for(ws2.recv(), timeout=5))
            ops = delta.get("ops", [])
            if ops and len(ops[0].get("recordId", "")) > 10:
                ok("broadcast has server-generated recordId")
            else:
                fail("broadcast recordId", f"got: {ops[0].get('recordId', '') if ops else 'no ops'}")
    except Exception as e:
        fail("broadcast recordId", str(e))

    # 10: Multiple ops in single sync_push
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [
                    {"id": "multi-1", "collection": "notes", "operation": "create", "data": {"title": "Multi1"}},
                    {"id": "multi-2", "collection": "notes", "operation": "create", "data": {"title": "Multi2"}},
                ]
            }))
            ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if ack.get("type") == "sync_ack" and len(ack.get("opIds", [])) == 2:
                ok("multiple ops in single push")
            else:
                fail("multiple ops", str(ack))
    except Exception as e:
        fail("multiple ops", str(e))

    # 11: sync_pull multiple collections at once
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({"type": "sync_pull", "collections": ["notes", "other"]}))
            r1 = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            r2 = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            collections = {r1.get("collection"), r2.get("collection")}
            if r1.get("type") == "sync_state" and r2.get("type") == "sync_state" and collections == {"notes", "other"}:
                ok("sync_pull multiple collections")
            else:
                fail("sync_pull multiple", f"{r1}, {r2}")
    except Exception as e:
        fail("sync_pull multiple", str(e))

    # 12: Empty sync_push ops (should be no-op, no response)
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({"type": "sync_push", "ops": []}))
            try:
                resp = await asyncio.wait_for(ws.recv(), timeout=1)
                fail("empty push no-op", f"got response: {resp}")
            except asyncio.TimeoutError:
                ok("empty push no-op")
    except Exception as e:
        fail("empty push no-op", str(e))

    # 13: Unknown message type after auth (should be silently ignored)
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({"type": "bogus_type", "foo": "bar"}))
            try:
                resp = await asyncio.wait_for(ws.recv(), timeout=1)
                fail("unknown type ignored", f"got response: {resp}")
            except asyncio.TimeoutError:
                ok("unknown type ignored")
    except Exception as e:
        fail("unknown type ignored", str(e))

    # 14: Bad JSON after auth (should send error, not disconnect)
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send("{bad json")
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "error":
                # Verify connection still alive after error
                await ws.send(json.dumps({"type": "sync_pull", "collections": []}))
                ok("bad JSON after auth recovers")
            else:
                fail("bad JSON after auth", str(resp))
    except Exception as e:
        fail("bad JSON after auth", str(e))

    # 15: Update operation via sync_push
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            # First create a record to get its ID
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{"id": "upd-create", "collection": "notes", "operation": "create", "data": {"title": "ToUpdate"}}]
            }))
            ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            # Now pull to get the record ID
            await ws.send(json.dumps({"type": "sync_pull", "collections": ["notes"]}))
            state = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            records = state.get("records", [])
            # Find our record
            target = None
            for r in records:
                if isinstance(r.get("data"), dict) and r["data"].get("title") == "ToUpdate":
                    target = r
                    break
                elif isinstance(r.get("data"), str) and "ToUpdate" in r["data"]:
                    target = r
                    break
            if target:
                rid = target["id"]
                # Now update it
                await ws.send(json.dumps({
                    "type": "sync_push",
                    "ops": [{"id": "upd-op", "collection": "notes", "operation": "update", "recordId": rid, "data": {"title": "Updated!"}}]
                }))
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                if resp.get("type") == "sync_ack":
                    ok("update operation")
                else:
                    fail("update operation", str(resp))
            else:
                fail("update operation", "couldn't find created record")
    except Exception as e:
        fail("update operation", str(e))

    print(f"\nResults: {PASS} passed, {FAIL} failed")

asyncio.run(test_ws())
