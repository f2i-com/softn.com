/**
 * What a film has that glTF has no field for.
 *
 * A scene made in Blender exports its objects, materials, animation, cameras
 * and lights. It does not export which camera the film looks through and
 * from when (Blender's timeline markers bound to cameras), a lens that
 * changes while the camera rolls (glTF holds one field of view for a camera),
 * or what a camera is focused on. SoftN's export script for Blender
 * (tools/blender/softn_export.py) writes those into the file's `extras`,
 * which is where glTF keeps what it has no field for, as a record under
 * `softn`. This is the reading of that record, and the questions the scene
 * asks of it: which camera at this second, how wide its lens then, how much
 * what is out of focus blurs.
 *
 * The record comes out of a file, so nothing in it is taken on trust: a
 * number is finite or it is left out, a name is a short string, a list has
 * an end. What is read here is also what the "loaded" report hands to the
 * app's logic, so it is plain data of a bounded size.
 */

/** From this second of the film, the picture is this camera's. */
export interface FilmCut {
  time: number;
  camera: string;
}

/** What a camera is focused on, and how wide its lens is open. */
export interface FilmFocus {
  /** The name of the node the camera keeps in focus. */
  object?: string;
  /** With no `object`: how far from the camera is sharp, in scene units. */
  distance?: number;
  /** With `distance`, for a focus that moves during the shot (a rack from one thing to another): `[seconds, distance]`, in order. */
  distances?: [number, number][];
  /** The lens's f-number: 1.4 is wide open (much blur), 16 nearly closed (hardly any). */
  fstop: number;
  /** The height of the camera's sensor at the picture's shape, in millimetres (24 for a full frame at 3:2). */
  sensorHeight?: number;
}

export interface FilmCamera {
  /** The vertical field of view in radians over the film's seconds, for a lens that changes: `[seconds, radians]`, in order. */
  fov?: [number, number][];
  focus?: FilmFocus;
}

export interface FilmRecord {
  version: 1;
  /** Frames a second, as the film was made. */
  fps: number;
  /** How long the film is, in seconds. */
  duration: number;
  /** The clip that holds the film, or `"*"` for a file whose clips play together. */
  clip?: string;
  /** Where the film's first frame is in the clip's own seconds. */
  clipStart: number;
  cuts: FilmCut[];
  cameras: Record<string, FilmCamera>;
  /** How Blender showed it: the view transform's name, the exposure in stops, the look. */
  view?: { transform?: string; exposure?: number; look?: string };
  /** The panorama the world was lit by: its file beside the model, its strength, its turn about the upright axis in radians. */
  environment?: { file: string; strength?: number; rotation?: number };
}

const MAX_NAME = 200;
const MAX_CUTS = 2000;
const MAX_CAMERAS = 256;
const MAX_KEYS = 20000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const positive = (value: unknown): number | undefined => {
  const n = finite(value);
  return n !== undefined && n > 0 ? n : undefined;
};

const name = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' && value.length <= MAX_NAME ? value : undefined;

function readFocus(value: unknown): FilmFocus | undefined {
  if (!isRecord(value)) return undefined;
  const fstop = positive(value.fstop);
  if (fstop === undefined) return undefined;
  const focus: FilmFocus = { fstop };
  const object = name(value.object);
  const distance = positive(value.distance);
  if (object !== undefined) focus.object = object;
  else if (distance !== undefined) {
    focus.distance = distance;
    const distances = readKeys(value.distances, (d) => d > 0);
    if (distances) focus.distances = distances;
  } else return undefined;
  const sensorHeight = positive(value.sensorHeight);
  if (sensorHeight !== undefined) focus.sensorHeight = sensorHeight;
  return focus;
}

/** Keys of something over time: pairs of finite numbers, each value one that `allowed` passes, in order of time. */
function readKeys(value: unknown, allowed: (v: number) => boolean): [number, number][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys: [number, number][] = [];
  for (const entry of value.slice(0, MAX_KEYS)) {
    if (!Array.isArray(entry)) continue;
    const time = finite(entry[0]);
    const v = finite(entry[1]);
    if (time === undefined || v === undefined || !allowed(v)) continue;
    if (keys.length > 0 && time <= keys[keys.length - 1][0]) continue;
    keys.push([time, v]);
  }
  return keys.length > 0 ? keys : undefined;
}

/** The keys of a lens over time: a field of view inside (0, pi). */
const readFov = (value: unknown): [number, number][] | undefined => readKeys(value, (fov) => fov > 0 && fov < Math.PI);

/**
 * A file's `extras.softn`, as far as it can be relied on; undefined for
 * anything that is not such a record. A part that is wrong is left out and
 * the rest is kept: a film with one bad cut is still a film.
 */
export function readFilmRecord(value: unknown): FilmRecord | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const record: FilmRecord = {
    version: 1,
    fps: positive(value.fps) ?? 30,
    duration: Math.max(0, finite(value.duration) ?? 0),
    clipStart: finite(value.clipStart) ?? 0,
    cuts: [],
    cameras: {},
  };
  const clip = name(value.clip);
  if (clip !== undefined) record.clip = clip;

  if (Array.isArray(value.cuts)) {
    for (const entry of value.cuts.slice(0, MAX_CUTS)) {
      if (!isRecord(entry)) continue;
      const time = finite(entry.time);
      const camera = name(entry.camera);
      if (time === undefined || camera === undefined) continue;
      record.cuts.push({ time, camera });
    }
    record.cuts.sort((a, b) => a.time - b.time);
  }

  if (isRecord(value.cameras)) {
    let count = 0;
    for (const key of Object.keys(value.cameras)) {
      if (count >= MAX_CAMERAS) break;
      const about = value.cameras[key];
      if (name(key) === undefined || key === '__proto__' || !isRecord(about)) continue;
      const camera: FilmCamera = {};
      const fov = readFov(about.fov);
      const focus = readFocus(about.focus);
      if (fov) camera.fov = fov;
      if (focus) camera.focus = focus;
      if (fov || focus) {
        record.cameras[key] = camera;
        count += 1;
      }
    }
  }

  if (isRecord(value.view)) {
    const view: NonNullable<FilmRecord['view']> = {};
    const transform = name(value.view.transform);
    const exposure = finite(value.view.exposure);
    const look = name(value.view.look);
    if (transform !== undefined) view.transform = transform;
    if (exposure !== undefined) view.exposure = exposure;
    if (look !== undefined) view.look = look;
    record.view = view;
  }

  if (isRecord(value.environment)) {
    const file = name(value.environment.file);
    if (file !== undefined) {
      const environment: NonNullable<FilmRecord['environment']> = { file };
      const strength = finite(value.environment.strength);
      const rotation = finite(value.environment.rotation);
      if (strength !== undefined && strength >= 0) environment.strength = strength;
      if (rotation !== undefined) environment.rotation = rotation;
      record.environment = environment;
    }
  }
  return record;
}

/** What the copy of a record handed to an app's logic holds at most: it crosses to the logic with every model that loads. */
const REPORT_CUTS = 256;
const REPORT_CAMERAS = 64;
const REPORT_KEYS = 256;

/** Keys over time cut down to `most`: every so-manyth one, and the last, so the line through them keeps its ends. */
function thinned(keys: [number, number][], most: number): [number, number][] {
  if (keys.length <= most) return keys.map(([t, v]): [number, number] => [t, v]);
  const step = Math.ceil((keys.length - 1) / (most - 1));
  const out: [number, number][] = [];
  for (let i = 0; i < keys.length - 1; i += step) out.push([keys[i][0], keys[i][1]]);
  const last = keys[keys.length - 1];
  out.push([last[0], last[1]]);
  return out;
}

/**
 * A copy of a record for an app's logic: its own to keep, and of a size
 * that does not grow with the file. The first 256 cuts, the first 64
 * cameras, and of a lens or a focus that changes, 256 keys along it at most
 * (a longer list is thinned evenly, keeping its first and last). The scene
 * itself reads the whole record.
 */
export function filmForReport(record: FilmRecord): FilmRecord {
  const out: FilmRecord = {
    version: 1,
    fps: record.fps,
    duration: record.duration,
    clipStart: record.clipStart,
    cuts: record.cuts.slice(0, REPORT_CUTS).map((cut) => ({ time: cut.time, camera: cut.camera })),
    cameras: {},
  };
  if (record.clip !== undefined) out.clip = record.clip;
  for (const key of Object.keys(record.cameras).slice(0, REPORT_CAMERAS)) {
    const from = record.cameras[key];
    const camera: FilmCamera = {};
    if (from.fov) camera.fov = thinned(from.fov, REPORT_KEYS);
    if (from.focus) {
      camera.focus = { ...from.focus };
      if (from.focus.distances) camera.focus.distances = thinned(from.focus.distances, REPORT_KEYS);
    }
    out.cameras[key] = camera;
  }
  if (record.view) out.view = { ...record.view };
  if (record.environment) out.environment = { ...record.environment };
  return out;
}

/**
 * The camera the film looks through at `time` seconds: the last cut at or
 * before it. Before the first cut it is the first cut's camera (a film whose
 * first marker is a little way in still has a picture from its first frame).
 * Undefined for a film with no cuts.
 */
export function cameraAt(record: FilmRecord | undefined, time: number): string | undefined {
  const cuts = record?.cuts;
  if (!cuts || cuts.length === 0) return undefined;
  let lo = 0;
  let hi = cuts.length - 1;
  if (!(time >= cuts[0].time)) return cuts[0].camera;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cuts[mid].time <= time) lo = mid;
    else hi = mid - 1;
  }
  return cuts[lo].camera;
}

/**
 * A camera's vertical field of view at `time` seconds, in radians, from the
 * keys of its lens: a straight line between two keys, the first key before
 * them all and the last after. Undefined for a camera whose lens does not
 * change (its glTF field of view stands).
 */
export function fovAt(camera: FilmCamera | undefined, time: number): number | undefined {
  return keyedAt(camera?.fov, time);
}

/**
 * How far from the camera is sharp at `time` seconds, for a focus given as a
 * distance: the keys of a focus that moves, or the one distance of a focus
 * that does not. Undefined for a focus on an object (the scene measures how
 * far that is) and for no focus.
 */
export function focusDistanceAt(focus: FilmFocus | undefined, time: number): number | undefined {
  if (!focus || focus.object !== undefined) return undefined;
  return keyedAt(focus.distances, time) ?? focus.distance;
}

/** A value at `time` from keys in order: a straight line between two, the first before them all, the last after. */
function keyedAt(keys: [number, number][] | undefined, time: number): number | undefined {
  if (!keys || keys.length === 0) return undefined;
  if (!(time > keys[0][0])) return keys[0][1];
  const last = keys[keys.length - 1];
  if (time >= last[0]) return last[1];
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid][0] <= time) lo = mid;
    else hi = mid;
  }
  const [t0, v0] = keys[lo];
  const [t1, v1] = keys[hi];
  return v0 + ((v1 - v0) * (time - t0)) / (t1 - t0);
}

/** A full frame's height in millimetres: the sensor a lens's f-number is usually thought of on. */
export const FULL_FRAME_HEIGHT_MM = 24;

/**
 * How much a lens blurs what is out of focus. The blur circle of a point at
 * depth `d`, for a lens focused at `s`, is `k * |d - s| / d` of the picture's
 * height across, and this is `k`: larger for a wider aperture (a smaller
 * f-number), a longer lens (a narrower field of view), a nearer subject and a
 * larger sensor. 0 for anything that is not a lens (no blur).
 *
 * It is the thin-lens circle of confusion, `f^2 / (N * (s - f)) * |d - s| / d`,
 * over the sensor's height, with the focal length `f` written as the field
 * of view gives it (`f = h / (2 * tan(fov / 2))`) and `s - f` taken as `s`
 * (a subject many focal lengths away).
 */
export function blurOfLens(fstop: number, verticalFov: number, focusDistance: number, sensorHeightMm?: number): number {
  const height = (sensorHeightMm !== undefined && sensorHeightMm > 0 ? sensorHeightMm : FULL_FRAME_HEIGHT_MM) / 1000;
  const half = Math.tan(verticalFov / 2);
  if (!(fstop > 0) || !(focusDistance > 0) || !(half > 0) || !Number.isFinite(half)) return 0;
  return height / (4 * half * half * fstop * focusDistance);
}
