# Photo Studio

A layered image editor written entirely in `.logic`: PNG, JPEG, GIF, BMP and
PSD codecs, compositing with 16 blend modes, brushes, selections, masks,
adjustments, geometry, bitmap type and an undo history all run inside the
sandbox, so the bundle needs nothing beyond the built-in components
(`PixelCanvas`, `Loop`, `Modal`, `FileChooser`, `Slider`, `Select`,
`ColorPicker`, `Icon`).

## Running

- **softn-web** - drop `PhotoStudio.softn` onto the runtime, or open
  `http://localhost:1420/web/?open=/demos/PhotoStudio.softn` once it is served.
- **softn-loader** - the desktop runtime lists it with the other demo bundles.

Rebuild the archive after editing the source with
`node scripts/build-bundle.cjs PhotoStudio` from `apps/demo`.

## What it shows

- Whole-image work sliced into jobs pumped by `<Loop>`, so no single script
  call approaches the engine's instruction budget.
- `PixelCanvas` as the document view: the composite crosses to the host as
  one base64 frame, recomposited only where pixels changed.
- Resumable inflate/deflate, a baseline and progressive JPEG decoder with
  reduced-size decoding for large photos, and a PSD reader and writer.
- Text drawn from bundled DejaVu glyph atlases (licence in `assets/`).

Limits: 3 megapixels and 4096 px per side per document (larger photos are
downscaled on import), 32 layers, no WebP or AVIF decoding.
