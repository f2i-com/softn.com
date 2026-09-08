# Optional live updates

Declare an application GET route with `"transaction":"read"` and `"poll":true`.
Its handler must authenticate and authorize every request and return only that
user's permitted data. Both transports below invoke this same handler. These are
application-data updates, not the native XDB sync_push/sync_pull replication protocol.

## Polling through Apache/PHP

No extra process is required. A successful response includes ETag and
X-SoftN-Poll-Interval: 5000. Repeat the GET with If-None-Match after at least five
seconds. The host executes the handler before returning 304, including permission
and session-revocation checks. There is no shared response cache; responses retain
Cache-Control: no-store. Read exposed ETag headers from the fetch response.
Do not overlap requests. Back off on failures, stop on 401/403 or sign-out, and
refresh the displayed data only on a new successful response. Ordinary routes
continue to behave normally unless explicitly marked poll:true.

## Optional WebSocket bridge

The single-app backend ZIP includes websocket.mjs and a pinned, licensed ws library.
This service is OFF unless explicitly started. It watches the same polling routes
through HTTP and sends their updates over a persistent WebSocket connection.
Each poll rechecks authorization through PHP; the bridge has no database access.
It does not evaluate application source itself.

Run under your service manager, using the bundled Linux Node:

```sh
/path/backend/bin/node /path/backend/websocket.mjs --upstream https://app.example --port 8788
```

Use your actual application's HTTPS origin, or a loopback HTTP origin that routes
to its Apache virtual host. The service binds only to 127.0.0.1. Enable Apache
mod_proxy and mod_proxy_wstunnel, then configure the TLS virtual host:

```apache
ProxyPass /events ws://127.0.0.1:8788/events
ProxyPassReverse /events ws://127.0.0.1:8788/events
```

Keep /api/* served by PHP. Clients connect to wss://app.example/events. The bridge
checks the handshake Origin against the private manifest's allowedOrigins and
refuses routes not marked poll:true. Supply the bearer credential in the first
frame, never a URL:

```json
{"type":"subscribe","path":"/api/updates","authorization":"Bearer YOUR_SESSION_TOKEN"}
```

Returned frames are `{"type":"update","body":...}`, `{"type":"unchanged"}`,
or `{"type":"error","status":401}`. A revoked/forbidden/missing route closes the
connection. Reconnect with backoff, and never retry with revoked credentials.
Credentials are held in memory and are not logged. Clients can always use HTTP
polling when they have no WebSocket transport.

The initial bridge supports one exact route per connection, eight clients,
five-second polling, ten-second upstream deadlines, an 8 KiB incoming frame cap,
3 MiB upstream response cap and slow-client disconnection. Eight polling clients
stay below the PHP host's default shared-IP request limit. It is a small-deployment
transport, not a high-concurrency replacement for the native server. An optional
service must remain running for WebSocket connections to remain open; PHP polling
continues to work without it.
