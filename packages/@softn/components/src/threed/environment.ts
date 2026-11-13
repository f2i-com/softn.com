/**
 * A scene lit by a picture of its surroundings.
 *
 * `environment="studio"` lights a scene from a room that is worked out on the
 * spot, and that was the only light of the kind there was: a scene made in
 * another program, with a sky photographed or painted for it, could not be
 * lit by that sky, and metal had only the studio room to reflect. An
 * `environment` may now name a panorama: a picture of everything around one
 * point, twice as wide as it is tall. It lights the scene, it is what shiny
 * things reflect, and it can be shown behind everything.
 *
 * Three kinds of file. Radiance `.hdr` and OpenEXR `.exr` hold real light
 * values (a sun thousands of times brighter than the sky beside it), which is
 * what makes the lighting look right; each has a reader of its own, fetched
 * only by a scene that names such a file. A `.jpg`, `.png` or `.webp` is an
 * ordinary picture: it lights more faintly and evenly, since nothing in it is
 * brighter than white.
 *
 * The scene is given the panorama itself, and three.js filters it for
 * lighting the first time it draws with it (the same filtering the studio
 * room is given), keeps the filtered copy beside the picture, and frees it
 * when the picture is disposed. So one `dispose()` here frees both.
 *
 * What is showing stays until what replaces it has arrived: a scene that
 * changes sky does not go dark between the two, and a file that cannot be
 * loaded leaves the scene as it was.
 *
 * A file's own account of itself is not believed (panorama-headers.ts): its
 * header is read here first, a picture larger than 8192 by 4096, larger than
 * the device draws, or declared by a file too short to hold it is refused
 * before anything is made of it, and what the reader hands back is checked
 * against what the header declared. Only then does it replace what is
 * showing.
 */

import * as THREE from 'three';
import { isSafeUrl } from '@softn/core';
import { importEXRLoader, importRGBELoader } from './model-loaders';
import { createLoadResources, type ModelResourcePolicySource } from './model-resources';
import {
  exrWithAnEnd,
  hdrPixels,
  hdrWithOwnHeader,
  readExrHeader,
  readHdrHeader,
  refuseOtherThanDeclared,
  refusePanoramaSize,
  refuseShortExr,
} from './panorama-headers';

/** The kind of file a panorama is: what reads it. */
export type EnvironmentFormat = 'hdr' | 'exr' | 'image';

/** A panorama the scene is lit by, as `environment` takes one. */
export interface Scene3DEnvironment {
  /**
   * Where the panorama is: a picture of everything around one point, twice
   * as wide as it is tall (equirectangular). A path with no scheme
   * (`"assets/sky.hdr"`) names a file in the app's own bundle; a path the
   * bundle does not have is fetched as written. `.hdr` and `.exr` hold real
   * light values; `.jpg`, `.png` and `.webp` are ordinary pictures. An
   * `.hdr` or `.exr` may be 8192 by 4096 at most (that is already a quarter
   * of a gigabyte once unpacked) and no larger than the device can draw; a
   * larger one, or a file that is not what its header says, is not loaded:
   * a warning says why, and the scene stays lit as it was.
   */
  url: string;
  /**
   * The kind of file, for an address whose ending does not say: 'hdr',
   * 'exr' or 'image'. Left out, the ending decides (`.hdr`, `.exr`; anything
   * else is taken for an ordinary picture).
   */
  format?: EnvironmentFormat;
  /**
   * Show the panorama behind everything as well as lighting the scene with
   * it (default false: the scene's `background` or `sky` is shown). Not
   * with an orthographic camera, which has no view outward to show.
   */
  background?: boolean;
  /**
   * Turn the panorama about the upright (y) axis, in radians (default 0):
   * the lighting, the reflections and the background turn together, to put
   * its sun where the scene wants it.
   */
  rotation?: number;
  /**
   * How blurred the background is, from 0 (sharp, the default) to 1 (a soft
   * wash of its colours). The lighting is not changed by it.
   */
  blur?: number;
  /**
   * How bright the background is shown, as a multiple (default 1). The
   * lighting is not changed by it: that is `environmentIntensity`.
   */
  backgroundIntensity?: number;
}

/** What of an environment can change while its picture stays. */
export interface EnvironmentLook {
  background: boolean;
  rotation: number;
  blur: number;
  backgroundIntensity: number;
}

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** An environment's look as numbers: each one left out, or not a number, is its default. */
export function environmentLookOf(environment: Scene3DEnvironment | null | undefined): EnvironmentLook {
  return {
    background: environment?.background === true,
    rotation: finiteOr(environment?.rotation, 0),
    blur: Math.max(0, Math.min(1, finiteOr(environment?.blur, 0))),
    backgroundIntensity: Math.max(0, finiteOr(environment?.backgroundIntensity, 1)),
  };
}

/** Whether `environment` names a panorama: an object with an address in it. */
export function isEnvironmentImage(environment: unknown): environment is Scene3DEnvironment {
  return (
    typeof environment === 'object' &&
    environment !== null &&
    typeof (environment as Scene3DEnvironment).url === 'string' &&
    (environment as Scene3DEnvironment).url !== ''
  );
}

/**
 * The kind of file a panorama is: the `format` it was given, when that is
 * one of the three, and otherwise what the ending of `name` says. A name
 * that says nothing is an ordinary picture, which the browser reads whatever
 * it is called.
 */
export function environmentFormatOf(format: unknown, name: string): EnvironmentFormat {
  if (format === 'hdr' || format === 'exr' || format === 'image') return format;
  const clean = name.split('?')[0].split('#')[0].toLowerCase();
  if (clean.endsWith('.hdr')) return 'hdr';
  if (clean.endsWith('.exr')) return 'exr';
  return 'image';
}

export interface EnvironmentRequest {
  /** The address to fetch: the host's own URL for a file of the bundle. */
  url: string;
  format: EnvironmentFormat;
  /** The scene's policy, or a getter for it, as a model's load is given. */
  policy: ModelResourcePolicySource;
  /** The largest picture the scene's renderer can draw, either way, where it says: a larger panorama is refused. */
  maxTextureSize?: number;
}

function fetchBytes(url: string, manager: THREE.LoadingManager): Promise<ArrayBuffer> {
  const loader = new THREE.FileLoader(manager);
  loader.setResponseType('arraybuffer');
  return loader.loadAsync(url).then((data) => {
    if (!(data instanceof ArrayBuffer)) throw new Error(`The environment at ${url} did not arrive as bytes`);
    return data;
  });
}

/** What three's two readers make of a file's bytes: the light of each pixel, and how it is stored. */
interface LightValues {
  width: number;
  height: number;
  /** The values, in an array of numbers: its length is how many there are. */
  data: ArrayBufferView & { length: number };
  type: THREE.TextureDataType;
  format?: THREE.PixelFormat;
  colorSpace?: string;
}

/**
 * A texture of the light a reader found. The bytes are fetched and read
 * here, not by the reader's own `load`: that one, given a file it cannot
 * read, reports it and then goes on with nothing in hand, which the page
 * sees as an error of its own that no one caught.
 */
function lightTexture(values: LightValues, rowsFromTheTop: boolean): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    values.data as ArrayBufferView<ArrayBuffer>,
    values.width,
    values.height,
    (values.format ?? THREE.RGBAFormat) as THREE.PixelFormat,
    values.type
  );
  // Light itself, not the colours of a screen: a file of one channel is read as it stands.
  texture.colorSpace = (values.colorSpace ?? THREE.LinearSRGBColorSpace) as THREE.ColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  // A Radiance file's rows run from the top, three's own from the bottom.
  texture.flipY = rowsFromTheTop;
  texture.needsUpdate = true;
  return texture;
}

function loadPicture(url: string, manager: THREE.LoadingManager): Promise<THREE.Texture> {
  return new Promise<THREE.Texture>((resolve, reject) => {
    new THREE.TextureLoader(manager).load(url, resolve, undefined, (err) =>
      reject(err instanceof Error ? err : new Error('the picture could not be read'))
    );
  });
}

/**
 * Fetch and read one panorama, ready to be a scene's `environment`. The URL
 * has the scheme check a model's has, and is fetched through a manager of
 * its own, never three's page-wide one. The caller disposes what it is
 * given.
 */
export async function loadEnvironmentTexture(request: EnvironmentRequest): Promise<THREE.Texture> {
  const { url, format, policy, maxTextureSize } = request;
  if (!url.startsWith('data:') && !isSafeUrl(url)) throw new Error(`Unsafe environment URL: ${url}`);
  const { manager } = createLoadResources(url, policy);
  let texture: THREE.Texture;
  if (format === 'image') {
    // The browser reads an ordinary picture, and three scales one that is
    // too large for the device down, as for any texture.
    texture = await loadPicture(url, manager);
    // An ordinary picture is in the colours of a screen.
    texture.colorSpace = THREE.SRGBColorSpace;
  } else {
    const bytes = fetchBytes(url, manager);
    // The reader's chunk and the bytes travel together; if the chunk fails
    // the bytes' own rejection must not surface as an unhandled one.
    bytes.catch(() => undefined);
    if (format === 'hdr') {
      const [{ RGBELoader }, data] = await Promise.all([importRGBELoader(), bytes]);
      // The header, read here: how big a picture it declares, and whether
      // the file could hold one. The reader is then shown a header written
      // here, never the file's own.
      const file = new Uint8Array(data);
      const header = readHdrHeader(file);
      refusePanoramaSize(header.width, header.height, maxTextureSize);
      const values = new RGBELoader(manager).parse(hdrWithOwnHeader(header, hdrPixels(file, header))) as LightValues;
      refuseOtherThanDeclared(values, header.width, header.height, 4);
      texture = lightTexture(values, true);
    } else {
      const [{ EXRLoader }, data] = await Promise.all([importEXRLoader(), bytes]);
      // The same for an OpenEXR file, whose reader also walks off the end of
      // a file whose names do not end: its header is walked here first, and
      // it is given the file with an end it cannot walk past.
      const file = new Uint8Array(data);
      const header = readExrHeader(file);
      refusePanoramaSize(header.width, header.height, maxTextureSize);
      refuseShortExr(file, header);
      const values = new EXRLoader(manager).parse(exrWithAnEnd(file)) as LightValues;
      // Four values to a pixel for a picture in colour, one for a picture of brightness alone.
      refuseOtherThanDeclared(values, header.width, header.height, (values.format ?? THREE.RGBAFormat) === THREE.RGBAFormat ? 4 : 1);
      texture = lightTexture(values, false);
    }
  }
  // A picture of everything around a point, laid out by longitude and latitude.
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
}

/** What a scene asks its environment to show: a panorama, by address. */
export interface EnvironmentAsk extends EnvironmentRequest {
  /** The address as the app wrote it, for a warning to name. */
  written: string;
}

/** The studio room, as the scene makes it: the picture it lights by, and how to free it. */
export interface EnvironmentRoom {
  texture: THREE.Texture;
  dispose(): void;
}

/** What lights the scene: a panorama, or the studio room. */
interface Lighting extends EnvironmentRoom {
  /** A panorama of the app's own, which may be turned and shown behind the scene; the room is neither. */
  panorama: boolean;
}

const ROOM = 'studio';

/**
 * What lights one scene by its surroundings: the panorama or the studio
 * room lighting it now, the one on its way, and how a panorama is shown.
 * Made with the scene and disposed with it.
 *
 * The room and a panorama are one thing here so that a scene changing from
 * either to the other is lit throughout: what was lighting it stays until
 * the new one is ready, whichever way it goes.
 */
export class SceneEnvironment {
  /** What lights the scene now. */
  private current: Lighting | null = null;
  /** What `current` was made from, and what was last asked for. */
  private shown = '';
  private wanted = '';
  /** The number of the load in flight, or of the last: one that arrives under another is disposed. */
  private version = 0;
  /** A panorama is on its way. (The room is not waited for by the scene's readiness, and never was.) */
  private pending = false;
  /** Whether the picture is the scene's background at the moment. */
  private backdrop = false;
  private look: EnvironmentLook = environmentLookOf(null);
  /** Addresses a failure has been reported for. */
  private readonly warned = new Set<string>();

  constructor(
    private readonly scene: THREE.Scene,
    /** The scene's own background (its colour, its sky, or none): what stands when the picture is not shown behind it. */
    private readonly ownBackground: () => THREE.Scene['background'],
    /** A load that was being waited for has settled: arrived, failed, or been given up. */
    private readonly settled: () => void,
    private readonly load: (request: EnvironmentRequest) => Promise<THREE.Texture> = loadEnvironmentTexture
  ) {}

  /** Whether a picture is on its way. */
  get loading(): boolean {
    return this.pending;
  }

  /**
   * Light the scene by this panorama, or by none. The same one asked for
   * again is not fetched again. What was lighting the scene (another
   * panorama, or the studio room) stays until this one has arrived, and
   * stays for good if it cannot be loaded.
   */
  show(ask: EnvironmentAsk | null): void {
    if (!ask) {
      this.want('', null, true);
      return;
    }
    this.want(
      `${ask.format}|${ask.url}`,
      () =>
        this.load({ url: ask.url, format: ask.format, policy: ask.policy, maxTextureSize: ask.maxTextureSize }).then(
          (texture): Lighting => ({ texture, panorama: true, dispose: () => texture.dispose() })
        ),
      true,
      (err) => {
        if (this.warned.has(ask.written)) return;
        this.warned.add(ask.written);
        console.warn(
          `[Scene3D] The environment "${ask.written}" could not be loaded; the scene is lit as it was:`,
          err instanceof Error ? err.message : err
        );
      }
    );
  }

  /**
   * Light the scene by the studio room, which `make` works out (its chunk
   * is fetched first, so it is ready a moment later). `make` is told
   * whether the room is still wanted and may answer null to give up. A
   * panorama that was lighting the scene stays until the room is ready.
   */
  showRoom(make: (wanted: () => boolean) => Promise<EnvironmentRoom | null>): void {
    this.want(
      ROOM,
      (wanted) => make(wanted).then((room): Lighting | null => (room ? { texture: room.texture, dispose: () => room.dispose(), panorama: false } : null)),
      false,
      (err) => console.warn('[Scene3D] Studio environment unavailable:', err)
    );
  }

  /**
   * Ask for what `key` names, made by `make` (which is told whether it is
   * still the one wanted); or for nothing, with no `make`. `waited` says
   * whether the scene's readiness waits for it.
   */
  private want(
    key: string,
    make: ((wanted: () => boolean) => Promise<Lighting | null>) | null,
    waited: boolean,
    failed?: (err: unknown) => void
  ): void {
    if (key === this.wanted) return;
    this.wanted = key;
    const version = ++this.version;
    // Whatever was on its way is no longer the one waited for.
    if (this.pending) {
      this.pending = false;
      this.settled();
    }
    if (!make) {
      this.replace(null, '');
      return;
    }
    // Asked for again while another was on its way: it is still showing.
    if (key === this.shown) return;
    if (waited) this.pending = true;
    make(() => this.version === version).then(
      (lighting) => {
        if (this.version !== version) {
          lighting?.dispose();
          return;
        }
        if (waited) this.pending = false;
        // Given up by its maker: what was lighting the scene stays.
        if (lighting) this.replace(lighting, key);
        if (waited) this.settled();
      },
      (err: unknown) => {
        if (this.version !== version) return;
        if (waited) this.pending = false;
        failed?.(err);
        if (waited) this.settled();
      }
    );
  }

  /** How the picture is shown: whether it is the background, and its numbers. */
  setLook(look: EnvironmentLook): void {
    this.look = look;
    this.write();
  }

  /** The scene's own background was painted afresh: the picture goes back over it, if it is the background. */
  backgroundPainted(): void {
    if (this.backdrop && this.current) this.scene.background = this.current.texture;
  }

  /** Let go of everything: the scene is going. */
  dispose(): void {
    this.version += 1;
    this.pending = false;
    this.wanted = '';
    this.replace(null, '');
  }

  private replace(next: Lighting | null, key: string): void {
    const old = this.current;
    const scene = this.scene;
    this.current = next;
    this.shown = key;
    if (next) scene.environment = next.texture;
    else if (old && scene.environment === old.texture) scene.environment = null;
    this.write();
    // The filtered copy three made of a panorama goes with it; the room's own target with the room.
    old?.dispose();
  }

  private write(): void {
    const scene = this.scene;
    // Only a panorama is turned or shown behind the scene: the room is neither.
    const texture = this.current?.panorama ? this.current.texture : null;
    const look = this.look;
    if (texture) scene.environmentRotation.set(0, look.rotation, 0);
    else scene.environmentRotation.set(0, 0, 0);
    if (texture && look.background) {
      this.backdrop = true;
      scene.background = texture;
      scene.backgroundRotation.set(0, look.rotation, 0);
      scene.backgroundBlurriness = look.blur;
      scene.backgroundIntensity = look.backgroundIntensity;
    } else if (this.backdrop) {
      // The scene's own background, drawn as it always was.
      this.backdrop = false;
      scene.background = this.ownBackground();
      scene.backgroundRotation.set(0, 0, 0);
      scene.backgroundBlurriness = 0;
      scene.backgroundIntensity = 1;
    }
  }
}
