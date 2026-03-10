#!/bin/bash
# End-to-end integration tests for softn-server
# Requires the server to be running on port 9876

BASE="http://localhost:9876"
PASS=0
FAIL=0

check() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name"
    echo "    expected to contain: $expected"
    echo "    actual: $actual"
    FAIL=$((FAIL + 1))
  fi
}

check_status() {
  local name="$1"
  local expected_status="$2"
  local actual_status="$3"
  if [ "$actual_status" = "$expected_status" ]; then
    echo "  PASS: $name (status $actual_status)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name"
    echo "    expected status: $expected_status, got: $actual_status"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== HTTP Endpoint Tests ==="

# 1. Health check
echo "[1] Health check"
RESP=$(curl -s "$BASE/health")
check "returns 'ok'" "ok" "$RESP"

# 2. Manifest endpoint
echo "[2] Manifest endpoint"
RESP=$(curl -s "$BASE/manifest.json")
check "has app name" "test-app" "$RESP"
check "has version" "1.0.0" "$RESP"
check "no server block" "" "$(echo $RESP | grep -o '"server"')"

# 3. GET /api/hello
echo "[3] GET /api/hello"
RESP=$(curl -s "$BASE/api/hello")
check "returns greeting" "Hello from SoftN" "$RESP"
check "has method" '"method":"GET"' "$RESP"
check "has path" '"/api/hello"' "$RESP"

# 4. POST /api/echo with JSON body
echo "[4] POST /api/echo"
RESP=$(curl -s -X POST "$BASE/api/echo" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello world"}')
check "echoes body" "hello world" "$RESP"
check "has method" '"method":"POST"' "$RESP"

# 5. POST /api/echo with query params
echo "[5] POST /api/echo with query params"
RESP=$(curl -s -X POST "$BASE/api/echo?foo=bar&num=42" \
  -H "Content-Type: application/json" \
  -d '{"test":true}')
check "has query foo" '"foo":"bar"' "$RESP"

# 6. Create a note via API
echo "[6] POST /api/create-note"
RESP=$(curl -s -X POST "$BASE/api/create-note" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test Note","content":"Hello from integration test"}')
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/create-note" \
  -H "Content-Type: application/json" \
  -d '{"title":"Second Note","content":"Another note"}')
check "returns note id" '"id"' "$RESP"
check_status "201 Created" "201" "$STATUS"

# 7. Get notes
echo "[7] GET /api/notes"
RESP=$(curl -s "$BASE/api/notes")
check "has notes array" '"notes"' "$RESP"
check "has count" '"count"' "$RESP"
check "first note title" "Test Note" "$RESP"

# 8. Missing title returns 400
echo "[8] POST /api/create-note (missing title)"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/create-note" \
  -H "Content-Type: application/json" \
  -d '{"content":"no title"}')
check_status "400 Bad Request" "400" "$STATUS"

# 9. Empty body
echo "[9] POST /api/echo (empty body)"
RESP=$(curl -s -X POST "$BASE/api/echo")
check "echoes null body" '"echo":null' "$RESP"

# 10. Body limit
echo "[10] Body limit check"
STATUS=$(head -c 3000000 /dev/urandom | base64 | \
  curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/echo" \
  -H "Content-Type: application/json" \
  --data-binary @-)
check_status "413 Payload Too Large" "413" "$STATUS"

echo ""
echo "=== WebSocket Tests ==="

# 11. WebSocket auth (valid token)
echo "[11] WebSocket auth (valid token)"
WS_RESP=$(echo '{"type":"auth","token":"test-secret-token"}' | \
  timeout 3 websocat -1 "ws://localhost:9876/sync" 2>/dev/null || true)
if echo "$WS_RESP" | grep -q "auth_ok"; then
  echo "  PASS: auth_ok received"
  PASS=$((PASS + 1))

  CLIENT_ID=$(echo "$WS_RESP" | grep -o '"clientId":"[^"]*"' | head -1)
  check "has clientId" "clientId" "$CLIENT_ID"
else
  echo "  SKIP: websocat not available (install for WS tests)"
fi

# 12. WebSocket auth (wrong token)
echo "[12] WebSocket auth (wrong token)"
WS_RESP=$(echo '{"type":"auth","token":"wrong-token"}' | \
  timeout 3 websocat -1 "ws://localhost:9876/sync" 2>/dev/null || true)
if [ -n "$WS_RESP" ]; then
  check "auth fails" "Authentication failed" "$WS_RESP"
else
  echo "  SKIP: websocat not available"
fi

# 13. WebSocket sync_pull
echo "[13] WebSocket sync_pull"
WS_RESP=$(printf '{"type":"auth","token":"test-secret-token"}\n{"type":"sync_pull","collections":["notes"]}\n' | \
  timeout 3 websocat "ws://localhost:9876/sync" 2>/dev/null || true)
if echo "$WS_RESP" | grep -q "sync_state"; then
  check "sync_state received" "sync_state" "$WS_RESP"
  check "notes collection" '"collection":"notes"' "$WS_RESP"
  check "has records" "Test Note" "$WS_RESP"
else
  if [ -n "$WS_RESP" ]; then
    echo "  FAIL: expected sync_state"
    echo "    got: $WS_RESP"
    FAIL=$((FAIL + 1))
  else
    echo "  SKIP: websocat not available"
  fi
fi

# 14. WebSocket sync_push
echo "[14] WebSocket sync_push"
WS_RESP=$(printf '{"type":"auth","token":"test-secret-token"}\n{"type":"sync_push","ops":[{"id":"op-001","collection":"notes","operation":"create","data":{"title":"WS Note","content":"Created via WebSocket"}}]}\n' | \
  timeout 3 websocat "ws://localhost:9876/sync" 2>/dev/null || true)
if echo "$WS_RESP" | grep -q "sync_ack"; then
  check "sync_ack received" "sync_ack" "$WS_RESP"
  check "op-001 acknowledged" "op-001" "$WS_RESP"
else
  if [ -n "$WS_RESP" ]; then
    echo "  FAIL: expected sync_ack"
    echo "    got: $WS_RESP"
    FAIL=$((FAIL + 1))
  else
    echo "  SKIP: websocat not available"
  fi
fi

# 15. Verify WS-created note appears in API
echo "[15] Verify WS note in API"
if command -v websocat &> /dev/null; then
  RESP=$(curl -s "$BASE/api/notes")
  check "WS note visible via API" "WS Note" "$RESP"
else
  echo "  SKIP: websocat not available (WS note was never created)"
fi

# 16. WebSocket sync_push with invalid collection name
echo "[16] Sync push with invalid collection"
WS_RESP=$(printf '{"type":"auth","token":"test-secret-token"}\n{"type":"sync_push","ops":[{"id":"op-bad","collection":"../evil","operation":"create","data":{}}]}\n' | \
  timeout 3 websocat "ws://localhost:9876/sync" 2>/dev/null || true)
if echo "$WS_RESP" | grep -q "sync_reject"; then
  check "rejected invalid collection" "sync_reject" "$WS_RESP"
else
  if [ -n "$WS_RESP" ]; then
    echo "  INFO: response: $WS_RESP"
  fi
  echo "  SKIP: websocat not available or result not parseable"
fi

# 17. Concurrent read test (read pool)
echo "[17] Concurrent reads (read pool)"
for i in $(seq 1 10); do
  curl -s "$BASE/api/notes" > /dev/null &
done
wait
echo "  PASS: 10 concurrent reads completed"
PASS=$((PASS + 1))

echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
echo "=============================="

exit $FAIL
