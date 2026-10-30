/**
 * The media an app's page is served from its bundle's `assets/`: pictures,
 * sound, video, fonts, 3D models, and shader and text files, by extension, each
 * under the type SoftN's other hosts give it (core's asset classification;
 * test/media.test.mjs holds the two to the same types). Nothing that runs is
 * served (HTML, JavaScript): an app can show these and read them, no more.
 *
 * They were pictures, sound and two font formats only, so an app's video, its
 * TrueType fonts, its models or a compute shader came back from `asset()` as
 * an empty string. FormLogic holds uploads to the same list, so what it keeps
 * is what the page can be given.
 */
export const FRAME_MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  // Pictures
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', svg: 'image/svg+xml',
  hdr: 'image/vnd.radiance', exr: 'image/x-exr',
  // Sound
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', m4a: 'audio/mp4',
  // Video
  mp4: 'video/mp4', webm: 'video/webm',
  // Fonts
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  // 3D models, and a glTF's buffer
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj', stl: 'model/stl', fbx: 'application/octet-stream', bin: 'application/octet-stream',
  // Shaders and text an app reads
  wgsl: 'text/plain', txt: 'text/plain', md: 'text/markdown',
});

/** The `data:` URL a bundle asset is served as, or null for one the page is not given. */
export function mediaUrl(path: string, base64: unknown): string | null {
  if (typeof base64 !== 'string') return null;
  const type = FRAME_MEDIA_TYPES[path.split('.').pop()?.toLowerCase() || ''];
  return type ? `data:${type};base64,${base64}` : null;
}
