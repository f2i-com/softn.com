# Hosting the poker table authority

Texas Hold'em's online table is a service the bundle carries with it:
`server/authority.logic` and `server/rules.logic`, run by softn-server as the
bundle's own server logic. The site's PHP hosting does not run it. To offer
online tables to visitors, run one softn-server process and put it where the
runtime can reach it. This page is the recipe.

## What runs

The bundle's sources are in [softn-Examples](https://github.com/f2i-com/softn-Examples); point the server at its `bundles/TexasHoldem/` directory.

```
softn-server run path/to/softn-Examples/bundles/TexasHoldem --port 9877 --host 127.0.0.1 --data-dir /var/lib/softn/poker
```

- The bundle can be the directory or the packed `TexasHoldem.softn`.
- `--data-dir` is where rooms live (a SQLite file). Rooms nobody has touched
  for six hours are swept when a new one is created.
- Workers: the default is fine. Requests racing on one room commit one at a
  time through the store's conditional write (`db.updateIf`), so extra
  workers only add throughput.
- `--dev` allows every origin and is for a laptop, not a host.
- `--trusted-proxy` when nginx sits in front, so rate limits see the visitor's
  address and not the proxy's.

Build the binary with `cargo build --release` in `apps/softn-server` (the
engine crate is the sibling `zipp.org` checkout).

## Where to put it

Two arrangements work. The first is simpler and needs no CORS.

### Same origin, behind the site's proxy

Route a path of the site to the process. In nginx, inside the site's `server`
block and **before** the single-page fallbacks:

```nginx
location /tables/ {
    proxy_pass         http://127.0.0.1:9877/;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
}
```

Then the table server, as a visitor types it in the lobby, is
`https://softn.com/tables`, and its routes are `https://softn.com/tables/api/rooms/...`.
The runtime at `/web/` is the same origin, so no cross-origin policy is
involved, and the bundle's network grant names the site's own host.

### Its own origin

Run it at `https://tables.example` with TLS at the proxy, and tell it which
origins may call it, in the bundle's `manifest.json`:

```json
"config": { "server": { "allowedOrigins": ["https://softn.com"] } }
```

Without that list, and without `--dev`, cross-origin requests are refused.

## The bundle's network grant

`permission.json` limits where the app may reach. The shipped bundle allows
`localhost` and `127.0.0.1`, which is right for a laptop and wrong for a host.
A deployment republishes the bundle with its own host in the list:

```json
"net": { "enabled": true, "allowed_hosts": ["softn.com"] }
```

(`allow_http` is only for plain-HTTP development servers; drop it on a host.)
A changed `permission.json` is a changed bundle — a new digest, and a new
version in the directory — which is what a changed grant should be.

## Telling the lobby where the server is

The lobby's "Table server" field holds the address; the runtime remembers the
last one used in this browser. A deployment that wants the field prefilled
changes the default in `logic/authority-client.logic` (`authorityUrl`) when it
republishes the bundle.

## Running it as a service

A systemd unit, for a Linux host:

```ini
[Unit]
Description=SoftN poker table authority
After=network.target

[Service]
ExecStart=/usr/local/bin/softn-server run /srv/softn/TexasHoldem.softn --port 9877 --host 127.0.0.1 --data-dir /var/lib/softn/poker --trusted-proxy
Restart=on-failure
User=softn
Group=softn

[Install]
WantedBy=multi-user.target
```

## What it is, and is not

The authority keeps the deck and every hand on the server and sends each seat
only its own cards, judges every action, and refuses stale, duplicated and
out-of-turn ones. That protects the table from a cheating client. It does not
prove the operator honest — whoever runs the process can read every room —
and it is one service's server actor, not the general room facade the
rooms-and-routing RFC proposes. Run it for people who trust the host.
