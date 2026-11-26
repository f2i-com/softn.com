/**
 * A container app's media files go out with the types the bundle directory
 * and the FormLogic host give them; a caption file must be text/vtt, or the
 * browser refuses the <track>.
 */
import { describe, expect, it } from 'vitest';
import { mimeTypeFor } from '../src/archive';

describe('mimeTypeFor', () => {
  it('names captions and the common audio and video files', () => {
    expect(mimeTypeFor('media/captions.en.vtt')).toBe('text/vtt; charset=utf-8');
    expect(mimeTypeFor('media/song.m4a')).toBe('audio/mp4');
    expect(mimeTypeFor('media/song.aac')).toBe('audio/aac');
    expect(mimeTypeFor('media/song.FLAC')).toBe('audio/flac');
    expect(mimeTypeFor('media/voice.opus')).toBe('audio/ogg');
    expect(mimeTypeFor('media/clip.ogv')).toBe('video/ogg');
  });

  it('keeps the types it already gave', () => {
    expect(mimeTypeFor('media/song.mp3')).toBe('audio/mpeg');
    expect(mimeTypeFor('media/clip.webm?v=2')).toBe('video/webm');
    expect(mimeTypeFor('media/unknown.xyz')).toBe('application/octet-stream');
  });
});
