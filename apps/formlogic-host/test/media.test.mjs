// node --test apps/formlogic-host/test/media.test.mjs
// (Node 24 runs the TypeScript modules directly; they use only erasable syntax.)
//
// The media an app's page is served from its bundle: every kind SoftN's other
// hosts show (pictures, sound, video, fonts, models) under the type they give
// it, shader and text files to read, and nothing that runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_MEDIA_TYPES, mediaUrl } from '../src/media.ts';
import { ASSET_CLASSIFICATIONS } from '../../../packages/@softn/core/src/bundle/asset-classification.ts';

test('each served extension has the type SoftN classifies it under', () => {
  for (const [extension, type] of Object.entries(FRAME_MEDIA_TYPES)) {
    const known = ASSET_CLASSIFICATIONS[extension];
    assert.ok(known, `${extension} is an extension core classifies`);
    assert.equal(type, known.mime, extension);
    assert.ok(['image', 'audio', 'video', 'font', 'model', 'text'].includes(known.kind), extension);
  }
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

test('an asset is served as a data: URL of its type, matched without regard to case', () => {
  assert.equal(mediaUrl('assets/clip.mp4', 'AAAA'), 'data:video/mp4;base64,AAAA');
  assert.equal(mediaUrl('assets/scene.GLB', 'AAAA'), 'data:model/gltf-binary;base64,AAAA');
  assert.equal(mediaUrl('assets/shaders/add.wgsl', 'AAAA'), 'data:text/plain;base64,AAAA');
  assert.equal(mediaUrl('assets/font.ttf', 'AAAA'), 'data:font/ttf;base64,AAAA');
  assert.equal(mediaUrl('assets/logo.png', null), null, 'a value that is not base64 text is not served');
  assert.equal(mediaUrl('assets/noextension', 'AAAA'), null);
});
