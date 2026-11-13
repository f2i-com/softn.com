import { describe, it, expect } from 'vitest';
import { blurOfLens, cameraAt, focusDistanceAt, fovAt, readFilmRecord } from '../src/threed/film-record';

const whole = {
  version: 1,
  fps: 30,
  duration: 4,
  clip: 'Animation',
  clipStart: 0,
  cuts: [
    { time: 2, camera: 'Cam.Close' },
    { time: 0, camera: 'Cam.Wide' },
  ],
  cameras: {
    'Cam.Close': {
      fov: [
        [0, 0.4],
        [2, 0.3],
        [4, 0.2],
      ],
      focus: { object: 'Rover', fstop: 2.8, sensorHeight: 15.063 },
    },
  },
  view: { transform: 'AgX', exposure: 0.5, look: 'None' },
  environment: { file: 'film.hdr', strength: 1.2, rotation: 0.3 },
};

describe('the record a film carries in its file', () => {
  it('is read as written, with its cuts in order of time', () => {
    const record = readFilmRecord(whole);
    expect(record).toEqual({
      version: 1,
      fps: 30,
      duration: 4,
      clip: 'Animation',
      clipStart: 0,
      cuts: [
        { time: 0, camera: 'Cam.Wide' },
        { time: 2, camera: 'Cam.Close' },
      ],
      cameras: {
        'Cam.Close': {
          fov: [
            [0, 0.4],
            [2, 0.3],
            [4, 0.2],
          ],
          focus: { object: 'Rover', fstop: 2.8, sensorHeight: 15.063 },
        },
      },
      view: { transform: 'AgX', exposure: 0.5, look: 'None' },
      environment: { file: 'film.hdr', strength: 1.2, rotation: 0.3 },
    });
  });

  it('is nothing for what is not such a record', () => {
    for (const value of [undefined, null, 'film', 7, [], {}, { version: 2, cuts: [] }, { version: '1' }]) {
      expect(readFilmRecord(value)).toBeUndefined();
    }
  });

  it('leaves out what is wrong and keeps the rest', () => {
    const record = readFilmRecord({
      version: 1,
      fps: -3,
      duration: Number.NaN,
      clipStart: 'soon',
      clip: 'x'.repeat(500),
      cuts: [
        { time: 1, camera: 'A' },
        { time: Number.POSITIVE_INFINITY, camera: 'B' },
        { time: 2 },
        { time: 3, camera: '' },
        'cut',
        null,
      ],
      cameras: {
        A: { fov: [[0, 0.5], [0, 0.6], ['1', 0.4], [2, 4], [3, 0.2], [2.5, 0.3]], focus: { object: 'Rover' } },
        B: { focus: { fstop: 2, distance: -1 } },
        C: { focus: { fstop: 4, distance: 3, sensorHeight: 0 } },
        D: 'camera',
      },
      view: { transform: 9, exposure: 'bright' },
      environment: { strength: 2 },
    });
    expect(record).toEqual({
      version: 1,
      fps: 30,
      duration: 0,
      clipStart: 0,
      cuts: [{ time: 1, camera: 'A' }],
      cameras: {
        // Keys out of order, of the wrong kind or no field of view are dropped; a focus with no f-stop is none.
        A: { fov: [[0, 0.5], [3, 0.2]] },
        C: { focus: { fstop: 4, distance: 3 } },
      },
      view: {},
    });
  });

  it('does not take a name from the prototype for a camera', () => {
    const cameras = JSON.parse('{"__proto__": {"focus": {"fstop": 2, "distance": 1}}, "Real": {"focus": {"fstop": 2, "distance": 1}}}');
    const record = readFilmRecord({ version: 1, cuts: [], cameras });
    expect(Object.keys(record!.cameras)).toEqual(['Real']);
    expect(({} as Record<string, unknown>).focus).toBeUndefined();
  });

  it('has an end however long the file says it is', () => {
    const cuts = Array.from({ length: 5000 }, (_, i) => ({ time: i, camera: 'A' }));
    const fov = Array.from({ length: 50000 }, (_, i) => [i, 0.5]);
    const record = readFilmRecord({ version: 1, cuts, cameras: { A: { fov } } })!;
    expect(record.cuts.length).toBe(2000);
    expect(record.cameras.A.fov!.length).toBe(20000);
  });
});

describe('which camera the film looks through', () => {
  const record = readFilmRecord(whole)!;

  it('is the last cut at or before the moment', () => {
    expect(cameraAt(record, 0)).toBe('Cam.Wide');
    expect(cameraAt(record, 1.999)).toBe('Cam.Wide');
    expect(cameraAt(record, 2)).toBe('Cam.Close');
    expect(cameraAt(record, 400)).toBe('Cam.Close');
  });

  it('is the first cut before any, and for a moment that is no number', () => {
    const late = readFilmRecord({ version: 1, cuts: [{ time: 1, camera: 'Only' }], cameras: {} })!;
    expect(cameraAt(late, 0)).toBe('Only');
    expect(cameraAt(late, -5)).toBe('Only');
    expect(cameraAt(late, Number.NaN)).toBe('Only');
  });

  it('is none for a film with no cuts, or no film', () => {
    expect(cameraAt(readFilmRecord({ version: 1, cuts: [], cameras: {} }), 1)).toBeUndefined();
    expect(cameraAt(undefined, 1)).toBeUndefined();
  });

  it('finds its cut among many', () => {
    const cuts = Array.from({ length: 1001 }, (_, i) => ({ time: i * 0.5, camera: `C${i}` }));
    const many = readFilmRecord({ version: 1, cuts, cameras: {} })!;
    for (const i of [0, 1, 2, 499, 500, 998, 1000]) {
      expect(cameraAt(many, i * 0.5)).toBe(`C${i}`);
      expect(cameraAt(many, i * 0.5 + 0.49)).toBe(`C${i}`);
    }
  });
});

describe('a lens that changes over time', () => {
  const camera = readFilmRecord(whole)!.cameras['Cam.Close'];

  it('is a straight line between its keys', () => {
    expect(fovAt(camera, 0)).toBeCloseTo(0.4, 12);
    expect(fovAt(camera, 1)).toBeCloseTo(0.35, 12);
    expect(fovAt(camera, 2)).toBeCloseTo(0.3, 12);
    expect(fovAt(camera, 3.5)).toBeCloseTo(0.225, 12);
  });

  it('holds its first key before them all and its last after', () => {
    expect(fovAt(camera, -1)).toBe(0.4);
    expect(fovAt(camera, 9)).toBe(0.2);
    expect(fovAt(camera, Number.NaN)).toBe(0.4);
  });

  it('is nothing for a camera whose lens does not change', () => {
    expect(fovAt({}, 1)).toBeUndefined();
    expect(fovAt(undefined, 1)).toBeUndefined();
  });
});

describe('what is in focus', () => {
  const record = readFilmRecord({
    version: 1,
    cuts: [],
    cameras: {
      Rack: { focus: { fstop: 1.8, distance: 2.8, distances: [[42.5, 2.8], [45.5, 2.8], [48.5, 6.4], [48, 9], [51, 6.4], [52, -1]] } },
      Held: { focus: { fstop: 4, distance: 3 } },
      Subject: { focus: { fstop: 2, object: 'Rover', distances: [[0, 1], [1, 2]] } },
    },
  })!;

  it('follows a focus that moves, between its keys', () => {
    const focus = record.cameras.Rack.focus!;
    // A key out of order and a distance that is none are left out.
    expect(focus.distances).toEqual([[42.5, 2.8], [45.5, 2.8], [48.5, 6.4], [51, 6.4]]);
    expect(focusDistanceAt(focus, 0)).toBe(2.8);
    expect(focusDistanceAt(focus, 45.5)).toBe(2.8);
    expect(focusDistanceAt(focus, 47)).toBeCloseTo(4.6, 12);
    expect(focusDistanceAt(focus, 60)).toBe(6.4);
  });

  it('is the one distance of a focus that stays', () => {
    expect(focusDistanceAt(record.cameras.Held.focus, 12)).toBe(3);
  });

  it('is for the scene to measure when the focus is on an object, and nothing when there is none', () => {
    // An object's distance is where it is drawn, not a list in the file.
    expect(record.cameras.Subject.focus).toEqual({ fstop: 2, object: 'Rover' });
    expect(focusDistanceAt(record.cameras.Subject.focus, 0.5)).toBeUndefined();
    expect(focusDistanceAt(undefined, 0.5)).toBeUndefined();
  });
});

describe('how much a lens blurs', () => {
  // A 50 mm lens on a full frame (24 mm tall): its vertical field of view.
  const fov50 = 2 * Math.atan(24 / (2 * 50));

  it('is the thin lens circle of confusion over the picture height', () => {
    // f^2 / (N s) / h: 0.05^2 / (2.8 * 3) / 0.024
    const k = blurOfLens(2.8, fov50, 3);
    expect(k).toBeCloseTo((0.05 * 0.05) / (2.8 * 3) / 0.024, 9);
    // A point twice as far as the focus is blurred to half of k of the picture's height.
    expect((k * Math.abs(6 - 3)) / 6).toBeCloseTo(k / 2, 12);
  });

  it('is more for a wider aperture, a longer lens, a nearer subject and a larger sensor', () => {
    const base = blurOfLens(4, fov50, 3, 24);
    expect(blurOfLens(2, fov50, 3, 24)).toBeCloseTo(base * 2, 12);
    expect(blurOfLens(4, fov50 / 2, 3, 24)).toBeGreaterThan(base * 3.9);
    expect(blurOfLens(4, fov50, 1.5, 24)).toBeCloseTo(base * 2, 12);
    expect(blurOfLens(4, fov50, 3, 36)).toBeCloseTo(base * 1.5, 12);
  });

  it('is none for what is no lens', () => {
    expect(blurOfLens(0, fov50, 3)).toBe(0);
    expect(blurOfLens(2.8, 0, 3)).toBe(0);
    expect(blurOfLens(2.8, fov50, 0)).toBe(0);
    expect(blurOfLens(Number.NaN, fov50, 3)).toBe(0);
    expect(blurOfLens(2.8, Math.PI, 3)).toBeLessThan(1e-12);
  });
});
