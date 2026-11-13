# From Blender to SoftN

`softn_export.py` exports the scene open in Blender as one `.glb` that SoftN's `<Scene3D>` plays as
Blender has it: its objects and materials, its animation, its cameras with their moves and cuts,
its lamps.

```
blender film.blend --background --python softn_export.py -- film.glb
blender film.blend --background --python softn_export.py -- film.glb --meshopt
```

or, from another script running in Blender:

```python
import softn_export
softn_export.export("film.glb", meshopt=True)
```

It writes:

| File | What |
|---|---|
| `film.glb` | The scene. |
| `film.softn.json` | The film's record (below), for an app that wants it before the model has loaded. |
| `film.hdr` or `film.exr` | The world's panorama, when the world is lit by an image: the file itself when it is a `.hdr` or `.exr`, written out as `.hdr` otherwise. |

and the page that plays it is short:

```
<Scene3D fill shadows
  objects={[{ id: "film", type: "model", modelUrl: "assets/film.glb", castShadow: true, receiveShadow: true,
              animation: { clip: "*", time: time }, lights: { castShadow: true, shadowCameraSize: 20 } }]}
  camera={{ from: "film" }}
  environment={{ url: "assets/film.hdr" }}
  effects={{ depthOfField: "camera" }}
  toneMapping="agx" />
```

`docs/examples/scene-film.ui` is that page whole, and the guide's "A scene made in Blender" goes
through it.

## What the script does that Blender's own export does not

A `.glb` has no place for some of what a film is. The script writes these into the file's
`extras` (`scenes[0].extras.softn`), which is where glTF keeps what it has no field for, and
`<Scene3D>` reads them:

- **Cuts.** A timeline marker bound to a camera (Marker, Bind Camera to Markers) is a cut to that
  camera. `camera={{ from: "film" }}` follows them.
- **A lens that changes.** glTF holds one field of view for a camera; a zoom is written as keys.
- **Focus.** Each camera's depth of field: the object it follows or its distance (which may move:
  a rack focus), its f-stop, and the sensor's height. `effects={{ depthOfField: "camera" }}` uses them.
- **The look.** The view transform and exposure, and the world's panorama with its strength.

It also sets the export's options the way a film needs them:

- **One clip for everything** (`Active actions merged`), starting at second 0, with a key on every
  frame, so constraints and drivers come across as they play.
- **Lamps in Blender's own numbers** (`Unitless`). Blender's default writes them 683 times larger,
  for a renderer with a camera's exposure.
- **With `--meshopt`, nothing a film needs is rounded.** Blender's Meshopt export keeps 12 bits of a
  position, 12 of every key's time and 8 of a rotation, which is fine for a still model and puts a
  film's cameras centimetres and tenths of a degree from where they were set. The script keeps 20
  bits of a position and leaves key times and rotations as they are. Measured on a 62-second film
  in a scene 240 m across: cameras within 0.07 mm and 0.00001 degrees of Blender's, for under 1 MB
  more than Blender's own rounding.

## What comes across, and what does not

- Materials made with the Principled BSDF: colour, metal, roughness, normal, emission, clearcoat,
  glass. Anything made of procedural nodes is baked to pictures first.
- Meshopt compression, not Draco: SoftN's runtime does not read Draco.
- A lamp's or a material's own animation does not come across; an object's, a bone's and a
  camera's does.
- Blender's view transform is AgX by default: `toneMapping="agx"`. One stop of exposure in Blender
  is `toneMappingExposure={2}`.

## The record

```json
{ "version": 1, "fps": 30, "duration": 62.0,
  "clip": "Animation", "clips": ["Animation"], "clipStart": 0, "clipEnd": 62,
  "cuts": [ { "time": 0, "camera": "Cam.Plain" }, { "time": 7.5, "camera": "Cam.Close" } ],
  "cameras": {
    "Cam.Close":  { "focus": { "object": "Rover", "fstop": 2.0, "sensorHeight": 15.06 } },
    "Cam.Beacon": { "focus": { "distance": 2.79, "distances": [[42.5, 2.79], [48.5, 6.78]], "fstop": 1.8, "sensorHeight": 15.06 } },
    "Cam.Leaving": { "fov": [[51, 0.59], [62, 0.47]] }
  },
  "view": { "transform": "AgX", "exposure": 1.26, "look": "None" },
  "environment": { "file": "film.hdr", "strength": 1.0, "rotation": 0.0 } }
```

Times are seconds from the film's first frame; `fov` is the vertical field of view in radians;
distances are in scene units. The scene checks everything in it before using it, and hands it to
the app's logic in a model's "loaded" state as `film`.

Tried with Blender 5.2.
