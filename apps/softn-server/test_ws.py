import json, asyncio, uuid
import websockets

WS_URL = "ws://localhost:3001/sync?token=test-secret-token"
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

def rid():
    """Generate a unique record ID for create ops."""
    return str(uuid.uuid4())

async def test_ws():
    print("=== WebSocket Tests ===")

    # 1: Auth flow (pre-upgrade: auth_ok is sent automatically on connect)
    try:
        async with websockets.connect(WS_URL) as ws:
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "auth_ok" and "clientId" in resp and "serverTime" in resp:
                ok("auth flow + serverTime")
            else:
                fail("auth flow", str(resp))
    except Exception as e:
        fail("auth flow", str(e))

    # 2: Subscribe after auth (should be silently ignored, not an error)
    try:
        async with websockets.connect(WS_URL) as ws:
            await asyncio.wait_for(ws.recv(), timeout=5)  # auth_ok
            await ws.send(json.dumps({"type": "subscribe"}))
            try:
                resp = await asyncio.wait_for(ws.recv(), timeout=1)
                fail("subscribe ignored", f"got response: {resp}")
            except asyncio.TimeoutError:
                ok("subscribe silently ignored")
    except Exception as e:
        fail("subscribe ignored", str(e))

    # 3: Invalid JSON after auth
    try:
        async with websockets.connect(WS_URL) as ws:
            await asyncio.wait_for(ws.recv(), timeout=5)  # auth_ok
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
        async with websockets.connect(WS_URL) as ws:
            await asyncio.wait_for(ws.recv(), timeout=5)  # auth_ok
            await ws.send(json.dumps({"type": "sync_pull", "collections": ["nonexistent"]}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "sync_state" and resp.get("records") == []:
                ok("sync_pull empty collection")
            else:
                fail("sync_pull empty collection", str(resp))
    except Exception as e:
        fail("sync_pull empty collection", str(e))

    # 5: sync_push create + ack + broadcast + clientId stamped
    try:
        async with websockets.connect(WS_URL) as ws1, \
                   websockets.connect(WS_URL) as ws2:
            r1 = json.loads(await asyncio.wait_for(ws1.recv(), timeout=5))
            cid1 = r1["clientId"]
            await asyncio.wait_for(ws2.recv(), timeout=5)

            record_id = rid()
            await ws1.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "test-op-1",
                    "collection": "notes",
                    "operation": "create",
                    "recordId": record_id,
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

    # 6: delete rejected by onBeforeSync hook
    try:
        async with websockets.connect(WS_URL) as ws:
            await asyncio.wait_for(ws.recv(), timeout=5)  # auth_ok
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

    # 7: Self-echo prevention
    try:
        async with websockets.connect(WS_URL) as ws:
            await asyncio.wait_for(ws.recv(), timeout=5)  # auth_ok
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "echo-test",
                    "collection": "notes",
                    "operation": "create",
                    "recordId": rid(),
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

    # 8: Broadcast has recordId from client
    try:
        async with websockets.connect(WS_URL) as ws1, \
                   websockets.connect(WS_URL) as ws2:
            await asyncio.wait_for(ws1.recv(), timeout=5)
            await asyncio.wait_for(ws2.recv(), timeout=5)

            record_id = rid()
            await ws1.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "rid-test",
                    "collection": "notes",
                    "operation": "create",
                    "recordId": record_id,
                    "data": {"title": "RecordId test"},
                    "timestamp": "2025-01-01T00:00:00Z"
                }]
            }))
            await asyncio.wait_for(ws1.recv(), timeout=5)  # ack
            delta = json.loads(await asyncio.wait_for(ws2.recv(), timeout=5))
            ops = delta.get("ops", [])
            if ops and ops[0].get("recordId") == record_id:
                ok("broadcast has correct recordId")
            else:
                fail("broadcast recordId", f"got: {ops[0].get('recordId', '') if ops else 'no ops'}")
    except Exception as e:
        fail("broadcast recordId", str(e))

    # 9: Multiple ops in single sync_push
    try:
        async with websockets.connect(WS_URL) as ws:
            await asyncio.wait_for(ws.recv(), timeout=5)  # auth_ok
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [
                    {"id": "multi-1", "collection": "notes", "operation": "create", "recordId": rid(), "data": {"title": "Multi1"}},
                    {"id": "multi-2", "collection": "notes", "operation": "create", "recordId": rid(), "data": {"title": "Multi2"}},
                ]
            }))
            ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if ack.get("type") == "sync_ack" and len(ack.get("opIds", [])) == 2:
                ok("multiple ops in single push")
            else:
                fail("multiple ops", str(ack))
    except Exception as e:
        fail("multiple ops", str(e))

    # 10: sync_pull multiple collections at once
    try:
        async with websockets.connect(WS_URL) as ws:
            await asyncio.wait_for(ws.recv(), timeout=5)  # auth_ok
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

    # 11: Empty sync_push ops (should return error)
    try:
        async with websockets.connect(WS_URL) as ws:
            await asyncio.wait_for(ws.recv(), timeout=5)  # auth_ok
            await ws.send(json.dumps({"type": "sync_push", "ops": []}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "error":
                ok("empty push returns error")
            else:
                fail("empty push", str(resp))
    except Exception as e:
        fail("empty push", str(e))

    # 12: Unknown message type after auth (should be silently ignored)
    try:
        async with websockets.connect(WS_URL) as ws:
            await asyncio.wait_for(ws.recv(), timeout=5)  # auth_ok
            await ws.send(json.dumps({"type": "bogus_type", "foo": "bar"}))
            try:
                resp = await asyncio.wait_for(ws.recv(), timeout=1)
                fail("unknown type ignored", f"got response: {resp}")
            except asyncio.TimeoutError:
                ok("unknown type ignored")
    except Exception as e:
        fail("unknown type ignored", str(e))

    # 13: Bad JSON after auth (should send error, not disconnect)
    try:
        async with websockets.connect(WS_URL) as ws:
            await asyncio.wait_for(ws.recv(), timeout=5)  # auth_ok
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

    # 14: Update operation via sync_push
    try:
        async with websockets.connect(WS_URL) as ws:
            await asyncio.wait_for(ws.recv(), timeout=5)  # auth_ok
            # Create a record with known ID
            record_id = rid()
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{"id": "upd-create", "collection": "notes", "operation": "create", "recordId": record_id, "data": {"title": "ToUpdate"}}]
            }))
            ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if ack.get("type") != "sync_ack":
                fail("update operation", f"create failed: {ack}")
            else:
                # Now update it using the known record ID
                await ws.send(json.dumps({
                    "type": "sync_push",
                    "ops": [{"id": "upd-op", "collection": "notes", "operation": "update", "recordId": record_id, "data": {"title": "Updated!"}}]
                }))
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                if resp.get("type") == "sync_ack":
                    ok("update operation")
                else:
                    fail("update operation", str(resp))
    except Exception as e:
        fail("update operation", str(e))

    # 15: sync_pull returns created records
    try:
        async with websockets.connect(WS_URL) as ws:
            await asyncio.wait_for(ws.recv(), timeout=5)  # auth_ok
            await ws.send(json.dumps({"type": "sync_pull", "collections": ["notes"]}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "sync_state" and len(resp.get("records", [])) > 0:
                ok("sync_pull returns records")
            else:
                fail("sync_pull records", str(resp))
    except Exception as e:
        fail("sync_pull records", str(e))

    print(f"\nResults: {PASS} passed, {FAIL} failed")

asyncio.run(test_ws())
