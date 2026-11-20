import { describe, expect, it } from 'vitest';
import { skyViewFactor } from '../src/terrain/skyView';

const flat = (h: number, n = 16) => Array.from({ length: n }, () => h);
const UP: [number, number, number] = [0, 1, 0];

describe('sky-view factor (irradiance definition)', () => {
  it('open flat ground sees the whole sky: SVF = 1', () => {
    expect(skyViewFactor(flat(0), UP)).toBeCloseTo(1, 3);
  });
  it.each([10, 30, 45, 60])('flat surface under a uniform %i° horizon: SVF = cos²h', (deg) => {
    const h = (deg * Math.PI) / 180;
    expect(skyViewFactor(flat(h), UP, 128)).toBeCloseTo(Math.cos(h) ** 2, 3);
  });
  it('a vertical wall over open flat ground: SVF = 1/2', () => {
    expect(skyViewFactor(flat(0, 64), [1, 0, 0], 128)).toBeCloseTo(0.5, 2);
  });
  it('a 30° slope over open terrain (horizon below it on the downhill side) sees (1 + cos 30°)/2', () => {
    // Classic isotropic-sky result for a tilted plane: (1 + cos S) / 2. It assumes the sky is
    // the upper hemisphere and everything below the horizontal is ground, so the horizon is the
    // plane itself uphill and the horizontal (0) downhill: max(plane elevation, 0).
    const S = Math.PI / 6;
    const n: [number, number, number] = [Math.sin(S), Math.cos(S), 0];
    const N = 128;
    const horizons = Array.from({ length: N }, (_, i) => {
      const phi = ((i + 0.5) * 2 * Math.PI) / N;
      // Elevation of the tilted plane along azimuth phi: tan(e) = -tan(S) cos(phi).
      return Math.max(Math.atan(-Math.tan(S) * Math.cos(phi)), 0);
    });
    expect(skyViewFactor(horizons, n, 256)).toBeCloseTo((1 + Math.cos(S)) / 2, 2);
  });
  it('never exceeds 1 or goes below 0', () => {
    for (const h of [-1, -0.3, 0, 0.5, 1.4]) {
      const v = skyViewFactor(flat(h), [0.3, 0.9, 0.3]);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

import { skyOcclusion } from '../src/terrain/skyView';

describe('sky occlusion (relative to open terrain)', () => {
  it('an open slope keeps all its skylight, whatever its tilt', () => {
    for (const tilt of [0, 0.3, 0.8]) {
      expect(skyOcclusion(flat(0), [Math.sin(tilt), Math.cos(tilt), 0])).toBeCloseTo(1, 6);
    }
  });
  it('a flat pit floor with a 30° rim keeps cos²(30°) = 0.75', () => {
    expect(skyOcclusion(flat(Math.PI / 6), UP, 128)).toBeCloseTo(0.75, 3);
  });
  it('horizons below 0° count as open (the env map already holds the ground)', () => {
    expect(skyOcclusion(flat(-0.4), UP)).toBeCloseTo(1, 6);
  });
  it('a gully wall facing a 40° opposite wall loses more than a third of its skylight', () => {
    const N = 32;
    const horizons = Array.from({ length: N }, (_, i) => {
      const phi = ((i + 0.5) * 2 * Math.PI) / N;
      return Math.cos(phi) > 0 ? (40 * Math.PI) / 180 : 0; // wall across the gully on the +x side
    });
    const v = skyOcclusion(horizons, [Math.sin(0.5), Math.cos(0.5), 0]);
    expect(v).toBeLessThan(0.67);
    expect(v).toBeGreaterThan(0.2);
  });
});
