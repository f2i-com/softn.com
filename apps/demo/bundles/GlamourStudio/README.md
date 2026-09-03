# Glamour Studio

A salon's front desk, built in SoftN: appointments, clients, staff and
services in a local-first database that syncs between devices. It is one of
the **Examples** on softn.com, there to show what a data-driven app looks like
in the language rather than to run a real salon.

## Running

- **softn.com** — open it from the directory, or `http://localhost:1420/web/?open=/demos/GlamourStudio.softn`
  with `npm run dev` running.
- **softn-web** — drop `GlamourStudio.softn` onto the runtime, or use its file picker.
- **softn-loader** — the desktop runtime lists it with the other demo bundles.

Rebuild the bundle after editing the source with
`node scripts/build-bundle.cjs GlamourStudio` from `apps/demo`.

## What it shows

- A dashboard of counts, today's appointments and the activity log
- Full create, edit and delete for clients, staff, services and appointments
- `SmartGrid` tables with search, sort and paging, and `SmartForm` modals whose
  client, stylist and service fields are selects filled from the database
- Light and dark themes, a collapsible sidebar, and a bottom tab bar on phones
- Peer-to-peer sync through XDB and Yjs, behind the `sync` permission

The headings use a local serif stack; a bundle runs sandboxed and cannot load
a web font.
