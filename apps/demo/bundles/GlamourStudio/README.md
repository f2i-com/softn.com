# GlamourStudio

A salon management demo app built with SoftN. Features client management, staff scheduling, service catalogues, and appointment booking — all powered by XDB local-first storage with P2P sync.

## Running

Load the `GlamourStudio.softn` bundle in either:

- **softn-web** (browser): Drag-and-drop or file picker at `http://localhost:1422`
- **softn-loader** (Tauri desktop): Auto-loaded from demo bundles

## Features

- Dashboard with stats (client count, revenue, VIP clients)
- Full CRUD for clients, staff, services, and appointments
- Edit modals with SmartForm integration
- Dark/light theme toggle
- P2P sync via XDB + Yjs
