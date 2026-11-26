// node --test apps/formlogic-host/test/media.test.mjs
// (Node 24 runs the TypeScript modules directly; they use only erasable syntax.)
//
// The media an app's page is served from its bundle: every kind SoftN's other
// hosts show (pictures, sound, video, fonts, models) under the type they give
// it, shader and text files to read, and nothing that runs. Each is a `blob:`
// address of the file's own bytes, from the base64 text or the bytes the parent
// sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as media from '../src/media.ts';
const { FRAME_MEDIA_TYPES, FRAME_TEXT_TYPES, mediaBytes, mediaUrl, releaseMedia, sameMedia, svgTextOf, textFileUrl } = media;
import { ASSET_CLASSIFICATIONS } from '../../../packages/@softn/core/src/bundle/asset-classification.ts';

/** What an address serves as a page's fetch reads it: its type and its bytes, or null where it serves nothing. */
async function served(url) {
  try {
    const response = await fetch(url);
    return { type: response.headers.get('content-type'), bytes: new Uint8Array(await response.arrayBuffer()) };
  } catch {
    return null;
  }
}

test('each served extension has the type SoftN classifies it under', () => {
  for (const [extension, type] of Object.entries(FRAME_MEDIA_TYPES)) {
    const known = ASSET_CLASSIFICATIONS[extension];
    assert.ok(known, `${extension} is an extension core classifies`);
    assert.equal(type, known.mime, extension);
    assert.ok(['image', 'audio', 'video', 'font', 'model', 'text', 'program'].includes(known.kind), extension);
  }
});

test('a WebAssembly module is served as bytes of its own type, for SoftN to run in a worker', async () => {
  // Under application/wasm, which a browser opens as no page; the page reads its bytes (softn.wasm, <WasmApp>).
  assert.equal(FRAME_MEDIA_TYPES.wasm, 'application/wasm');
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const url = mediaUrl('assets/game.wasm', bytes);
  assert.ok(url && url.startsWith('blob:'), url);
  const read = await served(url);
  assert.equal(read.type, 'application/wasm');
  assert.deepEqual([...read.bytes], [...bytes]);
  releaseMedia(url);
});

test('every picture, sound, video, font and model core knows is served, but the rarest formats', () => {
  const left = Object.entries(ASSET_CLASSIFICATIONS)
    .filter(([, value]) => ['image', 'audio', 'video', 'font', 'model'].includes(value.kind))
    .map(([extension]) => extension)
    .filter((extension) => !(extension in FRAME_MEDIA_TYPES));
  // TIFF has no browser that draws it; EOT is Internet Explorer's font format.
  assert.deepEqual(left.sort(), ['eot', 'tif', 'tiff']);
});

test('nothing that runs or styles the page is served', () => {
  for (const extension of ['html', 'js', 'xml', 'css', 'json', 'ui', 'logic', 'py', 'softn', 'pdf', 'sql']) {
    assert.equal(FRAME_MEDIA_TYPES[extension], undefined, extension);
    assert.equal(mediaUrl(`assets/file.${extension}`, 'AAAA'), null, extension);
  }
});

test('the app\'s own data files are served from their text, and nothing that runs or styles the page', () => {
  assert.deepEqual(Object.keys(FRAME_TEXT_TYPES), ['json']);
  const url = textFileUrl('data/levels.json', '{"name":"Ünïcode & more","rows":[1,2]}');
  assert.ok(url.startsWith('data:application/json;charset=utf-8,'), url);
  // What a fetch of it reads is the text as it was, every character.
  assert.equal(decodeURIComponent(url.slice(url.indexOf(',') + 1)), '{"name":"Ünïcode & more","rows":[1,2]}');
  assert.equal(textFileUrl('data/LEVELS.JSON', '{}'), 'data:application/json;charset=utf-8,%7B%7D');
  for (const extension of ['html', 'ui', 'js', 'logic', 'py', 'css', 'xdb', 'sql', 'txt']) {
    assert.equal(textFileUrl(`file.${extension}`, 'x'), null, extension);
  }
  assert.equal(textFileUrl('data.json', null), null, 'a value that is not text is not served');
});

test('an asset is served as a blob: URL of its type holding exactly its bytes, matched without regard to case', async () => {
  for (const [path, type] of [
    ['assets/clip.mp4', 'video/mp4'], ['assets/scene.GLB', 'model/gltf-binary'], ['assets/shaders/add.wgsl', 'text/plain'],
    ['assets/font.ttf', 'font/ttf'], ['assets/logo.svg', 'image/svg+xml'], ['assets/sky.hdr', 'image/vnd.radiance'],
  ]) {
    const url = mediaUrl(path, 'AAEC/w==');
    assert.match(url, /^blob:/, path);
    assert.deepEqual(await served(url), { type, bytes: new Uint8Array([0, 1, 2, 255]) }, path);
  }
  // A new address each time one is made.
  assert.notEqual(mediaUrl('assets/a.png', 'AAAA'), mediaUrl('assets/a.png', 'AAAA'));
  assert.equal(mediaUrl('assets/noextension', 'AAAA'), null);
});

test('a file comes as base64 text or as bytes, a Uint8Array or an ArrayBuffer, and serves the same bytes either way', async () => {
  // Every byte value, and more than one read's worth.
  const bytes = new Uint8Array(300 * 1024).map((_, i) => (i * 7919 + (i >> 8)) % 256);
  for (const value of [Buffer.from(bytes).toString('base64'), bytes, bytes.buffer.slice(0)]) {
    assert.deepEqual(await served(mediaUrl('assets/scene.glb', value)), { type: 'model/gltf-binary', bytes });
  }
  // A view is the bytes it views, not the whole buffer under it.
  const view = new Uint8Array([9, 9, 1, 2, 3, 9]).subarray(2, 5);
  assert.deepEqual((await served(mediaUrl('assets/a.bin', view))).bytes, new Uint8Array([1, 2, 3]));
  // Base64 is read as a data: URL read it: spaces and line breaks passed over, the = padding optional.
  assert.deepEqual((await served(mediaUrl('assets/a.bin', 'AAEC\r\n/w=='))).bytes, new Uint8Array([0, 1, 2, 255]));
  assert.deepEqual((await served(mediaUrl('assets/a.bin', ' AAEC/w '))).bytes, new Uint8Array([0, 1, 2, 255]));
  // An empty file is a file.
  assert.deepEqual(await served(mediaUrl('assets/empty.txt', '')), { type: 'text/plain', bytes: new Uint8Array(0) });
  assert.deepEqual(await served(mediaUrl('assets/empty.txt', new ArrayBuffer(0))), { type: 'text/plain', bytes: new Uint8Array(0) });
});

test('text that is not base64, anything that is neither text nor bytes, and a type the page is not given are no file', () => {
  for (const bad of ['****', 'A', 'AA=A', 'AAAA====', 'AA AA=A', 'AAÜA', 'data:image/png;base64,AAAA']) {
    assert.equal(mediaUrl('assets/a.png', bad), null, bad);
  }
  for (const bad of [null, undefined, 7, true, {}, [0, 1], { 0: 1, length: 1 }, new Uint16Array(2), new DataView(new ArrayBuffer(2)), new Blob(['x'])]) {
    assert.equal(mediaUrl('assets/a.png', bad), null, Object.prototype.toString.call(bad));
  }
  // An extension that is the name of something every object has is no type.
  for (const extension of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(mediaUrl(`assets/file.${extension}`, 'AAAA'), null, extension);
    assert.equal(textFileUrl(`data/file.${extension}`, '{}'), null, extension);
  }
});

test('an address holds a file sent again as it was, as text or as bytes, and nothing else', async () => {
  const url = mediaUrl('assets/a.png', 'AAEC/w==');
  for (const same of ['AAEC/w==', 'AAEC/w', new Uint8Array([0, 1, 2, 255]), new Uint8Array([0, 1, 2, 255]).buffer]) {
    assert.equal(await sameMedia(url, 'assets/a.png', same), true, String(same));
  }
  assert.equal(await sameMedia(url, 'assets/A.PNG', 'AAEC/w=='), true, 'the type is compared, not how the name is written');
  // Other bytes of the same size, another size, another type, text that is not base64, no file at all.
  for (const [path, other] of [
    ['assets/a.png', new Uint8Array([0, 1, 2, 254])], ['assets/a.png', new Uint8Array([0, 1, 2])], ['assets/a.png', 'AAEC/w==AA'],
    ['assets/a.jpg', 'AAEC/w=='], ['assets/a.html', 'AAEC/w=='], ['assets/a.png', '****'], ['assets/a.png', 7],
  ]) {
    assert.equal(await sameMedia(url, path, other), false, `${path} ${String(other)}`);
  }
  // An address this module did not make holds nothing it can compare.
  assert.equal(await sameMedia('data:image/png;base64,AAEC/w==', 'assets/a.png', 'AAEC/w=='), false);
  const foreign = URL.createObjectURL(new Blob([new Uint8Array([0, 1, 2, 255])], { type: 'image/png' }));
  assert.equal(await sameMedia(foreign, 'assets/a.png', 'AAEC/w=='), false);
});

test('a JSON file whose text holds half of a surrogate pair is still served, that half read as U+FFFD', () => {
  // encodeURIComponent threw on it, and the file could not be read at all.
  const body = url => decodeURIComponent(url.slice(url.indexOf(',') + 1));
  assert.equal(body(textFileUrl('data/cut.json', '{"cut":"ab\ud83d"}')), '{"cut":"ab�"}');
  assert.equal(body(textFileUrl('data/cut.json', '"\ude00x"')), '"�x"');
  assert.equal(body(textFileUrl('data/whole.json', '"😀"')), '"😀"', 'a whole pair is as it was');
});

test('an SVG file served here can be read back by its address, as a <use> of it draws it, and its size is known', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="star"><path d="M0 0L5 5"/></symbol></svg>';
  const url = mediaUrl('assets/icons.svg', Buffer.from(svg).toString('base64'));
  assert.equal(svgTextOf(url), svg);
  assert.equal(mediaBytes(url), Buffer.byteLength(svg));
  const png = mediaUrl('assets/dot.png', 'AAAA');
  assert.equal(svgTextOf(png), undefined, 'an SVG file alone');
  assert.equal(mediaBytes(png), 3);
  releaseMedia(url);
  assert.equal(svgTextOf(url), undefined, 'let go of with the file');
  assert.equal(mediaBytes(url), 0);
  assert.equal(svgTextOf('blob:null/not-made-here'), undefined);
  releaseMedia(png);
});

test('an SVG file\'s text is kept only where it is read as a browser reads it: UTF-16 by its mark, UTF-8 otherwise, nothing else', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a id="é" href="https://x.example/"><rect/></a></svg>';
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  // UTF-16 with its byte order mark, either way round: read as such (Firefox draws from one, and follows its links)
  const le = mediaUrl('assets/le.svg', b64(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(svg, 'utf16le')])));
  assert.equal(svgTextOf(le), svg);
  const be = Buffer.from(svg, 'utf16le').swap16();
  assert.equal(svgTextOf(mediaUrl('assets/be.svg', b64(Buffer.concat([Buffer.from([0xfe, 0xff]), be])))), svg);
  // another encoding named, or bytes that are not UTF-8: not read here (unknown, so a click on a <use> of it is kept)
  assert.equal(svgTextOf(mediaUrl('assets/latin1.svg', b64(Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?>${svg.replace('é', 'e')}`)))), undefined);
  assert.equal(svgTextOf(mediaUrl('assets/bad.svg', b64(Buffer.concat([Buffer.from('<svg id="'), Buffer.from([0xe9]), Buffer.from('"/>')])))), undefined);
  // UTF-8 named, or none named: read
  assert.equal(svgTextOf(mediaUrl('assets/named.svg', b64(Buffer.from(`<?xml version="1.0" encoding="utf-8"?>${svg}`)))), `<?xml version="1.0" encoding="utf-8"?>${svg}`);
});

test('an address let go of serves nothing, and no other address is let go of', async () => {
  const url = mediaUrl('assets/a.png', 'AAAA');
  const other = mediaUrl('assets/b.png', 'AAAA');
  releaseMedia(url);
  assert.equal(await served(url), null);
  assert.equal(await sameMedia(url, 'assets/a.png', 'AAAA'), false);
  assert.deepEqual(await served(other), { type: 'image/png', bytes: new Uint8Array(3) });
  // One this module did not make is left alone, and letting go twice does nothing more.
  const foreign = URL.createObjectURL(new Blob(['x']));
  releaseMedia(foreign);
  releaseMedia(url);
  assert.deepEqual((await served(foreign)).bytes, new Uint8Array([120]));
  URL.revokeObjectURL(foreign);
});

test('when the frame ends every address made is let go of, and with it its file', async () => {
  // A frame its parent ends may stay on the parent's page (FormLogic keeps one with its error over
  // it): an ended app held all its media, up to 128 MB a version, for as long as that page was open.
  assert.equal(typeof media.releaseAllMedia, 'function');
  const picture = mediaUrl('assets/a.png', 'AAAA');
  const icon = mediaUrl('assets/icon.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><a href="https://x.example/"/></svg>').toString('base64'));
  assert.ok(svgTextOf(icon));
  const foreign = URL.createObjectURL(new Blob(['x']));
  media.releaseAllMedia();
  assert.equal(await served(picture), null);
  assert.equal(await served(icon), null);
  assert.equal(svgTextOf(icon), undefined);
  assert.equal(mediaBytes(picture), 0);
  assert.equal(await sameMedia(picture, 'assets/a.png', 'AAAA'), false);
  // One this module did not make is left alone, and a file made after is served as ever.
  assert.deepEqual((await served(foreign)).bytes, new Uint8Array([120]));
  URL.revokeObjectURL(foreign);
  const after = mediaUrl('assets/b.png', 'AAAA');
  assert.deepEqual(await served(after), { type: 'image/png', bytes: new Uint8Array(3) });
  releaseMedia(after);
});
