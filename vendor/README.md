# GLib compatibility backport

`glib/` is the unmodified crates.io source for **glib 0.18.5**, except for the
two-line fix in `src/variant_iter.rs` and `tests/variant_str_security.rs`.
Its MIT license and copyright notices are included.

Tauri's GTK 3 dependencies require glib 0.18, so adding glib 0.20 alongside it
would leave the vulnerable copy installed. Both desktop Cargo manifests instead
patch crates.io to this local copy. The version remains 0.18.5; this is not an
upstream release.

The fix passes a mutable out-pointer to `g_variant_get_child`, matching
[upstream PR 1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343), commit
`05dff0ee696f9bcd8617cd48c4b812d046d440cb`, for
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).

Validate on Linux with GLib development headers and pkg-config installed:

```sh
cargo test --manifest-path vendor/glib/Cargo.toml --release --test variant_str_security
```

Run this in release mode: compiler optimization exposed the original bug.
Remove this patch when Tauri's GTK dependency supports a fixed upstream GLib
release, then regenerate both desktop lockfiles and repeat the desktop checks.
Do not suppress the advisory merely because a Windows build does not compile GTK.
