# Export the open Blender scene as one .glb that SoftN's <Scene3D> plays as it stands in Blender:
# its objects and materials, its animation as one clip, its cameras, its lights, and (in the
# file's `extras`, where glTF keeps what it has no field for) the things a film has that glTF does
# not: which camera the film looks through and from when (Blender's timeline markers bound to
# cameras), each camera's lens over time, and what each camera focuses on.
#
# From a terminal:
#   blender film.blend --background --python softn_export.py -- <out.glb> [--mode ACTIVE_ACTIONS] [--meshopt]
# From another script:  import softn_export; softn_export.export("out.glb")
#
# What it writes:
#   out.glb         the scene. `scenes[0].extras.softn` is the record described below.
#   out.softn.json  the same record, for an app's logic to read before the model has loaded.
#   out.hdr/.exr    the world's panorama, when the world is lit by an image (beside the .glb).
#
# The record:
#   { "version": 1,
#     "fps": 30, "duration": 62.0,                 seconds of the clip
#     "clip": "Animation",                         the clip that holds the whole film
#     "cuts": [ { "time": 0, "camera": "Cam.Wide" }, ... ],
#     "cameras": { "Cam.Close": {
#         "fov": [[0, 0.42], [2, 0.31], ...],      vertical field of view in radians over time,
#                                                  when the lens changes (glTF holds one value)
#         "focus": { "object": "Rover", "fstop": 2.8, "sensorHeight": 15.06 }
#                  or { "distance": 3.2, "fstop": 2.8, ... }, with "distances": [[0, 3.2], [1.5, 6.0]]
#                  when the focus moves during the shot
#     } },
#     "view": { "transform": "AgX", "exposure": 0.0, "look": "None" },
#     "environment": { "file": "out.hdr", "strength": 1.0, "rotation": 0.0 } }
import bpy, json, math, os, shutil, struct, sys


def _vertical_fov(scene, data):
    """The vertical field of view of a camera at the render's shape, in radians (glTF's yfov)."""
    width = scene.render.resolution_x * scene.render.pixel_aspect_x
    height = scene.render.resolution_y * scene.render.pixel_aspect_y
    aspect = width / height
    fit = data.sensor_fit
    if fit == "AUTO":
        fit = "HORIZONTAL" if aspect >= 1 else "VERTICAL"
    if fit == "VERTICAL":
        return 2 * math.atan(data.sensor_height / (2 * data.lens))
    horizontal = 2 * math.atan(data.sensor_width / (2 * data.lens))
    return 2 * math.atan(math.tan(horizontal / 2) / aspect)


def _thin(keys, tolerance=2e-4):
    """Leave out the keys a straight line between their neighbours already gives."""
    if len(keys) < 3:
        return keys
    kept = [keys[0]]
    for index in range(1, len(keys) - 1):
        (t0, v0), (t1, v1), (t2, v2) = kept[-1], keys[index], keys[index + 1]
        line = v0 + (v2 - v0) * (t1 - t0) / (t2 - t0)
        if abs(line - v1) > tolerance:
            kept.append(keys[index])
    kept.append(keys[-1])
    return kept


def film_record(scene):
    fps = scene.render.fps / scene.render.fps_base
    first, last = scene.frame_start, scene.frame_end

    def seconds(frame):
        return round((frame - first) / fps, 5)

    cameras = [o for o in scene.objects if o.type == "CAMERA"]
    cuts = [{"time": seconds(max(first, m.frame)), "camera": m.camera.name}
            for m in sorted(scene.timeline_markers, key=lambda m: m.frame) if m.camera is not None and m.frame <= last]
    if not cuts and scene.camera is not None:
        cuts = [{"time": 0, "camera": scene.camera.name}]

    record = {"version": 1, "fps": round(fps, 5), "duration": seconds(last), "cuts": cuts, "cameras": {}}

    # A lens that changes: glTF has one field of view for a camera, so the rest is said here.
    # So is a focus that moves (a rack from one thing to another).
    zooming = [c for c in cameras if c.data.animation_data is not None and c.data.animation_data.action is not None]
    lens = {c.name: [] for c in zooming}
    reach = {c.name: [] for c in zooming}
    if zooming:
        was = scene.frame_current
        for frame in range(first, last + 1):
            scene.frame_set(frame)
            for c in zooming:
                lens[c.name].append((seconds(frame), round(_vertical_fov(scene, c.data), 6)))
                reach[c.name].append((seconds(frame), round(c.data.dof.focus_distance, 5)))
        scene.frame_set(was)

    def changing(keys, tolerance):
        """The keys of something that changes, thinned; nothing for what stays as it is."""
        if not keys or max(v for _, v in keys) - min(v for _, v in keys) <= tolerance:
            return None
        return [list(k) for k in _thin(keys, tolerance)]

    for c in cameras:
        about = {}
        keys = changing(lens.get(c.name, []), 2e-4)
        if keys:
            about["fov"] = keys
        dof = c.data.dof
        if dof.use_dof:
            # The sensor's height at the render's shape, in millimetres: with the f-stop and the
            # lens it says how large the blur of what is out of focus is.
            tall = 2 * c.data.lens * math.tan(_vertical_fov(scene, c.data) / 2)
            focus = {"fstop": round(dof.aperture_fstop, 4), "sensorHeight": round(tall, 3)}
            if dof.focus_object is not None:
                focus["object"] = dof.focus_object.name
            else:
                focus["distance"] = round(dof.focus_distance, 5)
                keys = changing(reach.get(c.name, []), 2e-3)
                if keys:
                    focus["distances"] = keys           # [seconds, metres], for a focus that moves
            about["focus"] = focus
        if about:
            record["cameras"][c.name] = about

    view = scene.view_settings
    record["view"] = {"transform": view.view_transform, "exposure": round(view.exposure, 4), "look": view.look}
    return record


def _world_panorama(scene):
    """The image the world is lit by, its strength and its turn about the upright axis, or None."""
    world = scene.world
    if world is None or not world.use_nodes:
        return None
    image, strength, rotation = None, 1.0, 0.0
    for node in world.node_tree.nodes:
        if node.type == "TEX_ENVIRONMENT" and node.image is not None:
            image = node.image
        elif node.type == "BACKGROUND":
            strength = node.inputs["Strength"].default_value
        elif node.type == "MAPPING":
            rotation = node.inputs["Rotation"].default_value[2]
    if image is None:
        return None
    return image, strength, rotation


def _patch_extras(path, record):
    """Put the record in the .glb's JSON as scenes[scene].extras.softn."""
    with open(path, "rb") as f:
        data = f.read()
    magic, version, _total = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise RuntimeError("not a .glb: " + path)
    length, kind = struct.unpack_from("<II", data, 12)
    if kind != 0x4E4F534A:
        raise RuntimeError("the first chunk of the .glb is not its JSON")
    doc = json.loads(data[20:20 + length].decode("utf-8"))
    rest = data[20 + length:]
    # The clip's name and how long it really is, as the file has it.
    animations = doc.get("animations") or []
    if animations:
        # One clip holds the film ("Active actions merged", "Scene"); with Blender's default
        # ("Actions") every object's action is its own clip and they all play together: "*".
        record["clip"] = animations[0].get("name", "") if len(animations) == 1 else "*"
        samplers = [s for a in animations for s in a.get("samplers", [])]
        ends = [doc["accessors"][s["input"]].get("max", [0])[0] for s in samplers]
        starts = [doc["accessors"][s["input"]].get("min", [0])[0] for s in samplers]
        if ends:
            # Where the first frame is in the clip's own seconds: 0 when the exporter slid the
            # animation to start at 0, the first frame's number over the frame rate when not.
            record["clipStart"] = round(min(starts), 5)
            record["clipEnd"] = round(max(ends), 5)
    record["clips"] = [a.get("name", "") for a in animations]
    scene = doc["scenes"][doc.get("scene", 0)]
    scene.setdefault("extras", {})["softn"] = record
    text = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    text += b" " * ((4 - len(text) % 4) % 4)
    body = struct.pack("<II", len(text), 0x4E4F534A) + text + rest
    with open(path, "wb") as f:
        f.write(struct.pack("<III", magic, version, 12 + len(body)) + body)


def _keep_what_a_film_needs(position_bits=20, normal_bits=10):
    """Blender's Meshopt export rounds hard, to make a small file of a still model: 12 bits for a
    position (centimetres, across a scene a few hundred metres wide), 12 bits for the TIME of
    every key and 8 for a rotation. A film cannot take that: its cameras land centimetres and
    tenths of a degree from where they were put, and a slow pan goes in steps. For the length of
    this run the exporter's packing is replaced: positions keep `position_bits`, normals and
    tangents `normal_bits`, and everything else (every key's time, every rotation, every other
    number) is packed as it is, with nothing rounded. Says whether it could."""
    try:
        import ctypes
        import numpy as np
        import io_scene_gltf2.io.exp.meshopt as packing
        encoder = packing.MeshoptEncoder
    except Exception:
        return False
    if getattr(encoder, "_softn_precise", False):
        return True

    def encode_attribute(attribute_name, data, byteStride, export_settings):
        encoder.load_library(export_settings)
        lib = export_settings["meshopt_encoder"]
        values = np.ascontiguousarray(data)
        count = len(values)
        bits = None
        if values.dtype == np.float32:
            if attribute_name in ("POSITION", "SK_POSITION"):
                bits = position_bits
            elif attribute_name in ("NORMAL", "SK_NORMAL", "TANGENT", "SK_TANGENT"):
                bits = normal_bits
        if bits:
            filtered = np.empty(count * byteStride, dtype=np.uint8)
            lib.encodeFilterExp(filtered.ctypes.data_as(ctypes.c_void_p), count, byteStride, bits,
                                values.ctypes.data_as(ctypes.c_void_p), packing.ENCODE_EXP_SHARED_VECTOR)
            bound = lib.encodeVertexBufferBound(count, byteStride)
            buffer = (ctypes.c_ubyte * bound)()
            written = lib.encodeVertexBuffer(buffer, bound, filtered.ctypes.data_as(ctypes.c_void_p), count, byteStride)
            return bytes(buffer[:written]), "EXPONENTIAL"
        size = values.strides[0]
        bound = lib.encodeVertexBufferBound(count, size)
        buffer = (ctypes.c_ubyte * bound)()
        written = lib.encodeVertexBuffer(buffer, bound, values.ctypes.data_as(ctypes.c_void_p), count, size)
        return bytes(buffer[:written]), None

    encoder.encode_attribute = staticmethod(encode_attribute)
    encoder._softn_precise = True
    return True


def export(path, mode="ACTIVE_ACTIONS", meshopt=False, lighting="COMPAT", extra_options=None):
    """Write the scene to `path` (.glb) with its record, and say what was written."""
    scene = bpy.context.scene
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    record = film_record(scene)

    panorama = _world_panorama(scene)
    if panorama is not None:
        image, strength, rotation = panorama
        source = bpy.path.abspath(image.filepath) if image.filepath else ""
        extension = os.path.splitext(source)[1].lower() if source else ""
        on_disk = bool(source) and os.path.exists(source) and extension in (".hdr", ".exr")
        target = os.path.splitext(path)[0] + (extension if on_disk else ".hdr")
        if on_disk:
            # A .hdr or an .exr is what the scene reads: the file itself goes beside the .glb.
            if os.path.abspath(source) != target:
                shutil.copyfile(source, target)
        else:
            # Any other picture, or one that lives only inside the .blend: written out as
            # Radiance HDR.
            copy = image.copy()
            copy.file_format = "HDR"
            copy.filepath_raw = target
            copy.save()
            bpy.data.images.remove(copy)
        record["environment"] = {"file": os.path.basename(target), "strength": round(strength, 5), "rotation": round(rotation, 5)}

    options = dict(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,                 # modifiers applied, as the scene looks
        export_cameras=True,
        export_lights=True,
        # "Unitless": a Sun of strength 4 is a light of intensity 4. The default ("Standard")
        # writes lux and candela, 683 times larger, for a renderer with a camera's exposure.
        export_import_convert_lighting_mode=lighting,
        export_animations=True,
        export_animation_mode=mode,        # one clip holding everything that moves
        export_frame_range=True,
        export_anim_slide_to_zero=True,    # the first frame is the clip's second 0
        export_force_sampling=True,        # a key on every frame: constraints and drivers included
        export_optimize_animation_size=True,
        export_extras=True,
        export_meshopt_compression_enable=bool(meshopt),
    )
    options.update(extra_options or {})
    precise = _keep_what_a_film_needs() if options.get("export_meshopt_compression_enable") else None
    known = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
    left_out = sorted(k for k in options if k not in known)
    for k in left_out:
        options.pop(k)
    bpy.ops.export_scene.gltf(**options)
    _patch_extras(path, record)
    with open(os.path.splitext(path)[0] + ".softn.json", "w", encoding="utf-8") as f:
        json.dump(record, f, indent=1)
    return {"file": path, "bytes": os.path.getsize(path), "record": record, "optionsLeftOut": left_out,
            # None: no compression asked for. False: compressed with Blender's own rounding, because
            # this Blender's exporter is not the one the careful packing was written against.
            "precise": precise}


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not args:
        raise SystemExit("usage: blender file.blend --background --python softn_export.py -- <out.glb> [--mode MODE] [--meshopt]")
    mode = args[args.index("--mode") + 1] if "--mode" in args else "ACTIVE_ACTIONS"
    made = export(args[0], mode=mode, meshopt="--meshopt" in args)
    print("SOFTN EXPORT", json.dumps({k: v for k, v in made.items() if k != "record"}))
    print("SOFTN RECORD", json.dumps(made["record"]))
