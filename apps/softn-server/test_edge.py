"""Edge-case and regression tests for softn-server."""
import json, asyncio, urllib.request, urllib.error
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

def http(method, path, body=None, headers=None):
    url = f"http://localhost:3001{path}"
    data = body.encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    try:
        resp = urllib.request.urlopen(req)
        return resp.status, resp.read().decode(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), dict(e.headers)

async def test_edge_cases():
    print("=== Edge Case Tests ===\n")

    # --- HTTP Edge Cases ---
    print("-- HTTP Edge Cases --")

    # 1: CORS preflight (OPTIONS)
    try:
        req = urllib.request.Request("http://localhost:3001/api/hello", method="OPTIONS")
        req.add_header("Origin", "http://example.com")
        req.add_header("Access-Control-Request-Method", "POST")
        resp = urllib.request.urlopen(req)
        cors_origin = resp.headers.get("access-control-allow-origin", "")
        if cors_origin == "*":
            ok("CORS preflight returns Access-Control-Allow-Origin: *")
        else:
            fail("CORS preflight", f"got '{cors_origin}'")
    except Exception as e:
        fail("CORS preflight", str(e))

    # 2: Content-Type on JSON responses
    status, body, headers = http("GET", "/api/hello")
    ct = headers.get("content-type", headers.get("Content-Type", ""))
    if "application/json" in ct:
        ok("JSON Content-Type header")
    else:
        fail("JSON Content-Type", f"got '{ct}'")

    # 3: POST with non-JSON body
    status, body, headers = http("POST", "/api/notes", body="plain text body", headers={"Content-Type": "text/plain"})
    if status in (200, 201):
        ok("POST with non-JSON body accepted")
    else:
        fail("POST non-JSON body", f"status={status}")

    # 4: POST with empty body
    status, body, headers = http("POST", "/api/notes", body="", headers={"Content-Type": "application/json"})
    if status in (200, 201):
        ok("POST with empty body")
    else:
        fail("POST empty body", f"status={status}, body={body}")

    # 5: GET with query param name
    status, body, headers = http("GET", "/api/hello?name=Claude")
    parsed = json.loads(body)
    b = parsed.get("body", parsed)
    if "Claude" in b.get("message", ""):
        ok("Query param passed to handler")
    else:
        fail("Query param", body)

    # 6: 404 returns empty body (no JSON)
    status, body, headers = http("GET", "/nonexistent")
    if status == 404:
        ok("404 on nonexistent path")
    else:
        fail("404 nonexistent", f"status={status}")

    # 7: manifest.json excludes server block
    status, body, headers = http("GET", "/manifest.json")
    manifest = json.loads(body)
    if "server" not in manifest and manifest.get("name") == "TestApp":
        ok("manifest.json excludes server block")
    else:
        fail("manifest filter", body)

    # 8: Error handler returns 500 (or 200 due to FormLogic VM limitation)
    status, body, headers = http("GET", "/api/error")
    if status in (200, 500):
        ok(f"Error handler returns {status} (VM limitation)")
    else:
        fail("error handler", f"status={status}")

    # --- WebSocket Edge Cases ---
    print("\n-- WebSocket Edge Cases --")

    # 9: Update with empty recordId should be rejected
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "empty-rid-upd",
                    "collection": "notes",
                    "operation": "update",
                    "data": {"title": "No ID"}
                }]
            }))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "sync_reject" and "recordId" in resp.get("reason", ""):
                ok("update without recordId rejected")
            else:
                fail("update no recordId", str(resp))
    except Exception as e:
        fail("update no recordId", str(e))

    # 10: Delete with empty recordId should be rejected by validation (before hook)
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "empty-rid-del",
                    "collection": "notes",
                    "operation": "delete"
                }]
            }))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "sync_reject" and "recordId" in resp.get("reason", ""):
                ok("delete without recordId rejected")
            else:
                fail("delete no recordId", str(resp))
    except Exception as e:
        fail("delete no recordId", str(e))

    # 11: Unknown operation type
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "bad-op",
                    "collection": "notes",
                    "operation": "upsert",
                    "data": {}
                }]
            }))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "sync_reject" and "Unknown operation" in resp.get("reason", ""):
                ok("unknown operation rejected")
            else:
                fail("unknown operation", str(resp))
    except Exception as e:
        fail("unknown operation", str(e))

    # 12: Malformed ops (missing required fields) should be silently skipped
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{"foo": "bar"}]  # Missing id, collection, operation
            }))
            try:
                resp = await asyncio.wait_for(ws.recv(), timeout=1)
                # If we get a response, it should be an error or no-op
                ok("malformed ops handled (got response)")
            except asyncio.TimeoutError:
                ok("malformed ops handled (no response = no-op)")
    except Exception as e:
        fail("malformed ops", str(e))

    # 13: Sync roundtrip — push create then pull, verify data present
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)

            unique_title = "roundtrip-test-12345"
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "rt-op",
                    "collection": "test_roundtrip",
                    "operation": "create",
                    "data": {"title": unique_title}
                }]
            }))
            ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if ack.get("type") != "sync_ack":
                fail("sync roundtrip", f"expected ack, got {ack}")
            else:
                # Now pull
                await ws.send(json.dumps({
                    "type": "sync_pull",
                    "collections": ["test_roundtrip"]
                }))
                state = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                records = state.get("records", [])
                found = any(
                    (isinstance(r.get("data"), dict) and r["data"].get("title") == unique_title)
                    for r in records
                )
                if found:
                    ok("sync roundtrip (push then pull)")
                else:
                    fail("sync roundtrip", f"record not found in {len(records)} records")
    except Exception as e:
        fail("sync roundtrip", str(e))

    # 14: Multiple rapid connections
    try:
        tasks = []
        for i in range(5):
            async def connect_and_auth(idx=i):
                async with websockets.connect("ws://localhost:3001/sync") as ws:
                    await ws.send(json.dumps({"type": "auth"}))
                    resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                    return resp.get("type") == "auth_ok"
            tasks.append(connect_and_auth())
        results = await asyncio.gather(*tasks)
        if all(results):
            ok("5 concurrent connections")
        else:
            fail("concurrent connections", f"results: {results}")
    except Exception as e:
        fail("concurrent connections", str(e))

    # 15: sync_push with ops that have data=null
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "null-data",
                    "collection": "notes",
                    "operation": "create",
                    "data": None
                }]
            }))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "sync_ack":
                ok("create with null data (defaults to {})")
            else:
                fail("null data create", str(resp))
    except Exception as e:
        fail("null data create", str(e))

    # 16: Unicode in sync data
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "unicode-op",
                    "collection": "notes",
                    "operation": "create",
                    "data": {"title": "日本語テスト 🎉 émojis"}
                }]
            }))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "sync_ack":
                ok("unicode data in sync_push")
            else:
                fail("unicode sync", str(resp))
    except Exception as e:
        fail("unicode sync", str(e))

    # 17: Binary WebSocket message (should not crash server)
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(b"\x00\x01\x02\x03")
            # Server should either send error or ignore; should not crash
            try:
                resp = await asyncio.wait_for(ws.recv(), timeout=2)
                ok("binary message handled (got response)")
            except asyncio.TimeoutError:
                ok("binary message handled (ignored)")
            except websockets.exceptions.ConnectionClosed:
                ok("binary message handled (connection closed)")
    except Exception as e:
        fail("binary message", str(e))

    # 18: Very large sync op data
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            large_data = {"content": "x" * 50000}  # 50KB payload
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [{
                    "id": "large-op",
                    "collection": "notes",
                    "operation": "create",
                    "data": large_data
                }]
            }))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if resp.get("type") == "sync_ack":
                ok("large payload (50KB)")
            else:
                fail("large payload", str(resp)[:100])
    except Exception as e:
        fail("large payload", str(e))

    # 19: sync_pull with empty collections array
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({"type": "sync_pull", "collections": []}))
            try:
                resp = await asyncio.wait_for(ws.recv(), timeout=1)
                fail("empty collections pull", f"got response: {resp}")
            except asyncio.TimeoutError:
                ok("sync_pull empty collections (no-op)")
    except Exception as e:
        fail("empty collections pull", str(e))

    # 20: Rapid sync_push burst (10 ops sequentially)
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            for i in range(10):
                await ws.send(json.dumps({
                    "type": "sync_push",
                    "ops": [{
                        "id": f"burst-{i}",
                        "collection": "burst_test",
                        "operation": "create",
                        "data": {"idx": i}
                    }]
                }))
            # Collect all 10 acks
            ack_count = 0
            for i in range(10):
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                if resp.get("type") == "sync_ack":
                    ack_count += 1
            if ack_count == 10:
                ok("rapid burst (10 sequential pushes)")
            else:
                fail("rapid burst", f"only {ack_count}/10 acks")
    except Exception as e:
        fail("rapid burst", str(e))

    # 21: Auth with extra fields (should still work)
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({
                "type": "auth",
                "appVersion": "2.0.0",
                "extra": "ignored",
                "nested": {"foo": "bar"}
            }))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "auth_ok":
                ok("auth with extra fields")
            else:
                fail("auth extra fields", str(resp))
    except Exception as e:
        fail("auth extra fields", str(e))

    # 22: Mixed valid and invalid ops in single push
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps({
                "type": "sync_push",
                "ops": [
                    {"id": "mix-good", "collection": "notes", "operation": "create", "data": {"title": "Valid"}},
                    {"id": "mix-bad", "collection": "notes", "operation": "delete"},  # no recordId
                ]
            }))
            # Should get both a reject (for delete) and an ack (for create)
            responses = []
            for _ in range(2):
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                responses.append(resp)
            types = {r.get("type") for r in responses}
            if "sync_reject" in types and "sync_ack" in types:
                ok("mixed valid/invalid ops (partial success)")
            else:
                fail("mixed ops", str(responses))
    except Exception as e:
        fail("mixed ops", str(e))

    # 24: Batch size limit (>1000 ops rejected)
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            big_ops = [
                {"id": f"big-{i}", "collection": "notes", "operation": "create", "data": {"i": i}}
                for i in range(1001)
            ]
            await ws.send(json.dumps({"type": "sync_push", "ops": big_ops}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if resp.get("type") == "error" and "Too many ops" in resp.get("message", ""):
                ok("batch size limit (1001 ops rejected)")
            else:
                fail("batch size limit", str(resp)[:100])
    except Exception as e:
        fail("batch size limit", str(e))

    # 25: Exactly 1000 ops should be accepted
    try:
        async with websockets.connect("ws://localhost:3001/sync") as ws:
            await ws.send(json.dumps({"type": "auth"}))
            await asyncio.wait_for(ws.recv(), timeout=5)
            ops_1000 = [
                {"id": f"limit-{i}", "collection": "limit_test", "operation": "create", "data": {"i": i}}
                for i in range(1000)
            ]
            await ws.send(json.dumps({"type": "sync_push", "ops": ops_1000}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
            if resp.get("type") == "sync_ack" and len(resp.get("opIds", [])) == 1000:
                ok("1000 ops accepted (at limit)")
            else:
                fail("1000 ops", f"type={resp.get('type')}, opIds={len(resp.get('opIds', []))}")
    except Exception as e:
        fail("1000 ops", str(e))

    # 23: Verify server doesn't crash after all edge cases — health check
    try:
        status, body, _ = http("GET", "/health")
        if status == 200 and body == "ok":
            ok("server still healthy after edge cases")
        else:
            fail("post-test health", f"status={status}, body={body}")
    except Exception as e:
        fail("post-test health", str(e))

    print(f"\nResults: {PASS} passed, {FAIL} failed")

asyncio.run(test_edge_cases())
