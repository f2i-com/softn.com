# Imported model appearance

`Scene3DObject.appearance` adds declarative, named controls for GLTF and other imported objects:

```js
{ id: 'figure', type: 'model', modelUrl: url,
  appearance: {
    morphs: { BodyFull: 0.5 },
    colors: { Fabric: '#88aacc' },
    hiddenMeshes: ['Coat']
  }
}
```

Morph weights are finite values clamped to 0–1. Only names present in each mesh dictionary are applied, with a maximum of 64 requested targets. The renderer reapplies requested weights after animation updates; unrequested face/expression targets keep animating. Removing a requested target restores its imported default.

Colours address material names and accept six-digit hexadecimal values only. They multiply existing albedo maps and do not replace textures or compile shaders. Removing a colour restores its original value. Up to 128 named nodes or multipart mesh groups can be hidden; removing the visibility override restores the original visibility. Use loader-safe node names without spaces or reserved animation-path characters when exporting assets.

The host does not generate topology, fit garments or invent morph targets. Asset authors must provide matching shapes and appropriate clothing clearance. These controls are data, not executable avatar commands, and need no additional permission.

Tests cover bounds, unknown/inherited names, nonfinite values, preservation of facial channels, restoration of defaults, invalid colour rejection and multipart visibility. Existing studio lighting and camera regression tests also pass.
