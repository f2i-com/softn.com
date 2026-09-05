# RFC: portable SoftN rooms, authority and routing

**Proposal, not an implemented or standardized SoftN API.** Prepared 5 September 2026. Existing application APIs should continue working during an additive transition. See `docs/audit-2026-09.md` for the findings this responds to and what has been implemented.

## 1. Design position

SoftN already exposes `softn.net.fetch`, XDB/Yjs peer synchronization, server synchronization, capability-mediated host calls and a Rust server. Add a high-level room abstraction above these building blocks. Do not replace them with unrestricted browser `fetch`, WebSocket or RTCPeerConnection objects inside the VM.

Four concepts must remain distinct:

**Application identity** defines who owns storage, grants, code and services. **Membership** defines which authenticated player/viewer belongs to a room. **Authority** defines who decides the game state. **Transport** carries permitted messages. Swapping transport must not change the first three implicitly.

A room API should work for poker, quizzes, shared whiteboards, spectators and controllers, but it should not pretend they have the same consistency requirements. Support authoritative actions/views, document collaboration and ephemeral realtime updates as separate room profiles. XDB remains appropriate for collaboration; it is not an automatic privacy solution for hidden game state.

## 2. Compatibility and layering

```text
Application .logic + UI
    |
    +-- softn.net.fetch            Existing contract, hardened at the host
    +-- softn.net.rooms            New high-level room facade
    +-- softn.router               New namespaced navigation facade
    |
Host capability + identity + lifecycle layer
    |
    +-- room coordinator / protocol / membership / quotas
    |       +-- local trusted actor
    |       +-- same-partition tab transport
    |       +-- authenticated server actor + WebSocket
    |       +-- optional WebRTC direct/relay
    |       +-- trusted LAN host binding
    |
    +-- existing XDB document/service adapters where appropriate
```

All guest-visible room and subscription values are ordinary data/opaque handles. The host binds handles to the calling runtime and its effective grants. A guessed or copied handle is not sufficient to use another app's room. Never expose browser socket objects, authentication tokens, arbitrary listener registration or an unfiltered server URL as room authority.

### Identity model

Use separate identifiers for:

- **Artifact digest:** full cryptographic digest of a specific bundle; integrity, caching and version-specific grant review.
- **Application identity:** publisher-qualified stable identity across compatible releases.
- **Installation identity:** this app's local storage and user configuration.
- **Protocol/schema version:** room interoperability and migration.
- **Room ID + authority epoch:** session identity, including recovery generations.
- **Member/seat identity:** authenticated principal within a room, separate from a transient transport connection.

The existing room-only XDB registry must be repaired before using it underneath the new surface. A different app is not permitted to join a shared store merely by choosing the same label.

## 3. Proposed guest API

The existing `softn.net.fetch` signature stays compatible. The new API uses one result-envelope callback per async operation, avoiding requirements for a new guest Promise ABI or host Error objects. A future Promise facade can be generated on top.

```js
// Proposed API. Not runnable on the current release without implementing this RFC.
let pokerRoom = null;
let roomSubscription = null;
let connectionStatus = "disconnected";
let table = null;
let myCards = [];

function onRoomView(view) {
  // Only the server-authorized projection reaches this runtime.
  table = view.public;
  myCards = view.you ? view.you.holeCards : [];
}

function createPrivateGame() {
  softn.net.rooms.create({
    service: "poker",
    mode: "online",
    visibility: "private",
    authority: "server",
    transport: "auto",
    maxPlayers: 6
  }, function (result) {
    if (!result.ok) { connectionStatus = result.error.code; return; }
    pokerRoom = result.room;
    roomSubscription = softn.net.rooms.onState(pokerRoom.handle, onRoomView);
    softn.net.rooms.onStatus(pokerRoom.handle, function (event) {
      connectionStatus = event.state;
    });
    softn.router.navigate("room", { roomId: pokerRoom.code });
  });
}

function joinGame(inviteCode) {
  softn.net.rooms.join({ invite: inviteCode, role: "player" }, function (result) {
    if (!result.ok) { connectionStatus = result.error.code; return; }
    pokerRoom = result.room;
    roomSubscription = softn.net.rooms.onState(pokerRoom.handle, onRoomView);
  });
}

function raiseTo(amount) {
  softn.net.rooms.send(pokerRoom.handle, {
    action: "raiseTo",
    amount: amount
  }, function (result) {
    // Accepted means the authority committed it, not merely that a socket sent it.
    if (!result.ok) connectionStatus = result.error.code;
  });
}

function reconnectGame() {
  // Resume credentials stay in the host. The app never receives a bearer token.
  softn.net.rooms.reconnect(pokerRoom.handle, function (result) {
    if (!result.ok) connectionStatus = result.error.code;
  });
}

function leaveGame() {
  if (roomSubscription) softn.net.rooms.unsubscribe(roomSubscription);
  if (pokerRoom) softn.net.rooms.leave(pokerRoom.handle, function () {});
}
```

### Method semantics

`create` requests a room using a named, granted service/profile. It does not ask the browser to listen on an arbitrary TCP port. `join` resolves an invitation through the host, verifies application/protocol compatibility and obtains membership. `getInfo` returns permitted room/presence metadata. `onState` immediately supplies a current authorized snapshot and then updates, with a cursor so subscription establishment cannot lose the first update. `onPresence` is not a game-state authority signal.

`send` is for application actions; the host supplies principal, action ID, sequence, epoch and expected state revision. The server validates them and the actual action. An action is not successful merely because it entered a local queue. Do not silently replay an obsolete raise after reconnect. Return stable errors such as `STALE_VIEW`, `NOT_YOUR_TURN`, `ROOM_FULL`, `PERMISSION_DENIED`, `RATE_LIMITED`, `AUTHORITY_UNAVAILABLE` and `INCOMPATIBLE_VERSION`.

Optional `broadcast` or targeted peer messages belong only to explicitly peer-message profiles. Poker clients must not gain a general write/broadcast channel to authoritative state. Ephemeral channels, where permitted, have separate latest/accumulation/drop semantics and never carry durable game actions.

`leave` revokes membership/resume rights according to room policy. A transient disconnect retains the seat for a bounded grace period. `unsubscribe` removes one callback; runtime disposal removes every subscription, connection, pending operation and host-owned resource.

## 4. State and lifecycle contract

The host exposes a small state machine:

```text
idle → creating/joining → connected → reconnecting → connected
                                     |               |
                                     +→ expired       +→ leaving → closed
```

Room lifecycle (lobby/running/finished/closed) is separate from connection status. A room may continue while one display disconnects.

For authoritative actions, carry protocol version, room identity, epoch, member/client sequence, action identifier and expected state revision. Use authenticated transport metadata for principal identity; never trust a principal supplied in the message body. Apply validation, rule evaluation, durable state change and deduplication in one authority transaction/actor turn. Acknowledgments can be repeated; accepted effects cannot.

Do not claim exactly-once network delivery. Guarantee idempotent accepted effects within a documented replay window. After that window expires, reject old sequences rather than interpreting old commands as new. Reordered/delayed commands receive a stale-state error or a new snapshot. Private view generation is part of the authority, not UI hiding on the client.

Bound the action journal and give it a retention policy tied to epoch/sequence recovery. Log action IDs, revisions and validation outcomes without publishing private cards or credentials. Trace IDs should connect client, relay and authority diagnostics without revealing a persistent cross-app user identity.

## 5. Transports and automatic selection

| Mode | Recommended initial implementation | Limit / trust contract |
|---|---|---|
| Shared device | One local room actor, explicit keyboard/gamepad/touch player mappings | The device operator is trusted; one machine cannot hide its entire authoritative memory from its owner |
| Multi-tab | Host-mediated BroadcastChannel or a dedicated shared host, plus app/session validation | Same-origin and same storage partition; channel names are not authentication |
| Phone companion, online | Ordinary HTTPS join route and authenticated WebSocket room service | Works through the server even when devices share Wi-Fi; each phone gets only its own view |
| Local devices, offline LAN | Explicitly installed/trusted SoftN Desktop or LAN server with a reachable origin and pairing | Needs a real host/bootstrap path, trusted certificates/origin setup and platform support; no silent network scanning |
| P2P | Optional host-owned WebRTC data channels after a session/signalling grant | Requires offer/answer signalling and connectivity handling; privacy preferences can force relay |
| Online relay | WebSocket first; WebTransport only as a negotiated later option | Quotas, queue bounds and backpressure remain regardless of transport |
| Server-authoritative | Room actor/service whose authority is independent of a player's browser | A player or table display disconnect does not make another player the authority |

BroadcastChannel is restricted by storage partition as well as origin. An app embedded on another top-level site cannot assume it can communicate with a standalone same-origin tab. [R1]

WebRTC needs signalling and connectivity negotiation; “P2P” should not be marketed as “no infrastructure” or guaranteed connectivity. Candidate addressing and relay preferences are host privacy decisions. [R2]

### Selection algorithm

First intersect requested modes with granted transports/services, hosting capabilities, authority requirements and privacy preference. Then try permitted local paths or direct/relay connectivity. Report the chosen transport and reason in diagnostics. A server-authoritative room may switch its transport to that same authority; it must never fall back to trusting a browser peer. A relay-only privacy preference must not silently become direct P2P.

“Local” in the UI should say whether it means one device, same browser partition, LAN with a trusted host, or merely nearby devices using the online service. Being connected to the same Wi-Fi does not by itself provide discovery, authentication or a browser listening socket.

## 6. Permission model

Extend the existing `permission.json` structure using an explicit version. Do not reinterpret an existing empty `allowed_hosts` list as a different grant without migration and renewed review.

Illustrative v2 shape—not a current accepted schema:

```json
{
  "version": 2,
  "permissions": {
    "net": {
      "enabled": true,
      "origins": ["https://api.example.test"],
      "methods": ["GET"],
      "maxRequestBytes": 65536,
      "maxResponseBytes": 2097152,
      "maxConcurrent": 4,
      "credentials": "omit"
    },
    "multiplayer": {
      "enabled": true,
      "services": ["poker"],
      "transports": ["local", "relay"],
      "authority": ["local-trusted", "server"],
      "maxPlayers": 8,
      "maxMessageBytes": 65536
    }
  }
}
```

These values are proposed examples, not measured optimal defaults. Effective authority is the intersection of manifest request, user grant, installation policy, service policy and platform ceilings. Apps can request smaller limits, never raise a host ceiling. Native/server permissions and HTTP routes are separately granted and namespaced; a client manifest cannot register arbitrary host routes.

Normalize origins by scheme, host and port; specify wildcard/subdomain semantics explicitly. For generic guest HTTP, omit ambient credentials and disallow private-network destinations unless an explicit host-supported grant exists. Privileged authentication/payment/storage APIs use named service bindings with a restricted audience and operation set, not arbitrary URLs carrying host credentials.

Keep the existing native HTTP bridge's resolved-address SSRF checks and redirect refusal. Add service/destination restrictions and aggregate quotas rather than replacing working protection with a string-only host check. Validate actual connection addresses when native DNS is resolved. Browser asset loads, models, rendered URLs and sockets must enter the same policy system; policing `softn.net.fetch` alone is insufficient. [R3]

Local file picking grants handles chosen by the user. It is not permission to enumerate arbitrary filesystem paths. A server/native filesystem service remains scoped to its granted root/handles; high-assurance deployments should also use OS-level containment and race-resistant file operations.

## 7. Portable application routing

### Declarations

A bundle optionally declares named routes:

```json
{
  "routes": [
    { "name": "home", "path": "/" },
    { "name": "settings", "path": "/settings" },
    { "name": "room", "path": "/room/:roomId", "params": { "roomId": "room-code" } },
    { "name": "player", "path": "/player/:playerId", "params": { "playerId": "opaque-id" } }
  ]
}
```

The host compiles a small route language, not guest-supplied regular expressions. Bound segment lengths, query size/key count and route count. Decode once, reject invalid escapes/separators/traversal, canonicalize identifiers and expose plain sanitized data. Route normalization must not become a way to escape the base path.

Proposed methods: `softn.router.current()`, `navigate(name, params, options)`, `onChange(callback)`, `unsubscribe(handle)` and `shareUrl(name, params, callback)`. `navigate` defaults to push; explicit replace does not add history. A `popstate` update publishes a route snapshot without pushing it back again. Embedded hosts may use virtual/memory history and negotiate outer navigation; desktop can use an internal route stack. Guest code does not call `window.history`, assign a browser location, or construct a platform domain.

### Host mounts

| Host | Example route for identical `.logic` |
|---|---|
| SoftN directory | `/apps/texas-holdem/room/ABC123` |
| Custom domain | `/room/ABC123` |
| Subpath installation | `/games/poker/room/ABC123` |
| Embedded runtime | Host-negotiated virtual route; share URL resolved by embedding policy |
| Desktop | Internal route mapped to the same named route/parameters |

Preserve existing `/app/:slug` application-detail links and their SEO/backend handling during migration. Introduce `/apps/:slug` only with coordinated client and deployment routing. Keep `/apps` as the directory. App-detail/play/settings/room paths must not collide with host routes such as publishing, authentication, APIs and assets.

`/join/:code` belongs to the host, not an app. It resolves app identity, pinned compatible bundle/protocol and admission policy before loading the room. The code locates a room; joining still needs a new/known principal and an admission ticket. Room URLs must not contain reusable seat credentials. A participant's share URL and a private resume credential are different objects.

### Back/forward, deep links and PWA

Test direct navigation, reload, back/forward, root and subpath mounts, custom domains, installed-PWA cold launch, browser refresh while reconnecting and offline launch. Preserve existing missing-asset 404 behavior: a `.wasm` or `.js` URL must never receive the SPA HTML fallback. A room route can load the runtime shell offline, but joining an online authority cannot be promised offline.

A PWA update must not silently replace the active runtime/worker halfway through a game. Pin runtime/bundle/schema compatibility for a session; offer activation at a safe checkpoint and restore only compatible state. Coordinate page, worker, WASM and service-worker versions.

## 8. Texas Hold'em as the reference app

### Preserve and replace deliberately

Keep the current visual table, card assets, appropriate local game-rule/evaluator logic, solo/bot experience and UI workflows where tests confirm their behavior. Replace the shared-state authority path for adversarial online play, not the entire application.

Create a pure rule module with explicit input state/action and deterministic state transition results. Run this module on the trusted authority. Random dealing uses server-controlled secure randomness; live RNG state and future cards remain private. Rule code can be public; security must not depend on concealing JavaScript source.

Maintain two projections:

**Public table:** community cards, pot/side pots, stacks, seats, turn, permitted revealed cards, status and deadlines. **Player-private:** only that player's hole cards and permitted seat/action information. Spectators and the TV display receive the public projection. Do not give the display a secretly “full” snapshot with fields merely hidden by CSS.

Server authority protects against client cheating. It does not prove a dishonest server operator is fair. A later cryptographic P2P protocol would need a separate treatment of verifiable shuffling, selective reveal, collusion and abort/recovery—not a shared secret derived from a room name.

### Product modes

**Solo:** local trusted actor plus bots, offline where required assets are present. **Couch:** shared-device controls and pass-and-play privacy conventions; acknowledge the trusted-device assumption. **Private online:** server room with code/link admission. **Companion:** shared display joins as table/spectator, phones join as individual players. **Public online:** matchmaking and abuse controls above the same room service. **Spectate:** public state only, with delay where desired. **Reconnect:** restore authenticated seat using host-managed resume credentials and authority epoch.

### Phone companion journey

The laptop opens a room and displays a QR code for the host-owned join URL. A phone follows the URL, receives a clear room/app identity, chooses a name and requests a seat. The server admits it and issues scoped membership. The phone gets private cards/actions; the large display gets public table state. Reload returns to the seat after secure resume. Leaving revokes that resume path.

The room code itself should not be a secret that grants another player's seat. Optional admission tickets in a QR flow must be short-lived and single-purpose; do not encode reusable resume credentials. Apply invitation rate limits, expiry, capacity and host approval where required. A `create game` device closing should not stop a server-hosted game.

### Test matrix for the actual implementation

Use four or more browser/VM clients plus a controlled authority and deterministic transport adapter. Validate joining/leaving, capacity, private views, reconnect, stale sessions, duplicate actions, conflicting duplicate IDs, simultaneous actions, delayed/reordered delivery, disconnect during betting, display disconnect, authority restart, bounded invalid messages and permission revocation.

Add poker invariants: no duplicate dealt cards, chip conservation under defined rules, legal turns, correct min-raise/all-in rules, side-pot distribution, deterministic showdown and timeout behavior. Validate serialized messages and persisted client snapshots, not only DOM output. Fuzz bounded schema inputs locally and keep rate/queue testing within a controlled environment.

The included `tests/multiplayer-contract.test.cjs` is an executable design fixture for membership, projection and action semantics. It deliberately has no real poker rules, transport, storage, cryptographic authentication or ZIPP integration; passing it does not establish that TexasHoldem currently implements this design.

## 9. Custom-domain applications

A domain deployment supplies host configuration: application/publisher identity, pinned bundle URL and digest, trusted signing keys, base route, service bindings, branding and required runtime compatibility. A well-known deployment document is a possible convention, but it needs a versioned schema and caching/signature design before standardization.

The runtime verifies the artifact, evaluates requested capabilities against local grants, resolves relative bundle assets and mounts named routes. The app uses logical services such as `storage`, `poker` or `payments`; the deployment binds them to approved endpoints and authentication audiences. No backend secrets live in the downloadable bundle.

This supports domains such as `coffee.dating`, `mrhandy.com` or `leased.org` without hard-coding those names in `.logic`. It does not make the same storage magically available across origins. Account linking, data export/import and server-backed sync need explicit identity and consent flows. Embedded storage may be partitioned. A signature verifies provenance/integrity, not that code is harmless.

Review deployment headers for each hosting mode. The inspected site build emits restrictive framing/isolation headers; allowing third-party embedding is an explicit alternative deployment policy, not simply a runtime flag. GPU/model/device features are negotiated capabilities, not unconditional cross-platform promises.

## 10. Developer experience and rollout

Create **NetworkKit** rather than overloading one DeviceKit screen. It should show granted networking capabilities, current transport/authority, room membership, an echo/action example, public/private views, delayed/duplicate delivery simulation, reconnect state, byte/queue counters, copy/share/QR routes, and clear permission-denied screens. Do not expose raw tokens or unredacted private state in shared diagnostics.

Generate API documentation, guest facade types and validation examples from one versioned schema. Give AI-generated apps a small canonical pattern: create/join, subscribe, send action, show errors, reconnect, leave. Avoid dozens of subtly different low-level transport examples. Include negative examples in documentation: room code is not identity, client state is not authority, XDB is not a private-card vault, and local trusted mode is not a secure online fallback.

Roll out in dependency order: fix identity/grants; specify the room/route contract; implement local and server adapters; run the real multiplayer suite; migrate poker; add companion UX; then add optional P2P/LAN refinements. Keep compatibility adapters for existing XDB applications rather than forcing a platform-wide rewrite.

## Primary references

- **R1:** [Broadcast Channel API, including storage partition behavior](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API).
- **R2:** [WebRTC connectivity and signalling](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity).
- **R3:** Existing source evidence in `AUDIT.md`, especially `script-runtime.ts`, `xdb-sync.ts`, `SoftNRenderer.tsx`, and `apps/softn-server/src/{host,http,ws,sync}.rs` plus native HTTP/filesystem bridges.
