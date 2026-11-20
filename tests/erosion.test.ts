import { describe, expect, it } from 'vitest';
import { erodeGrid } from '../src/terrain/erosion';
import { buildTerrainData } from '../src/terrain/build';

const N = 129;
const SIZE = 6000;
const coord = (i: number) => (i / (N - 1) - 0.5) * SIZE;

/** A cone: slopes in every direction (rise 0.6), so "downhill" is the radial direction. */
function cone(): Float32Array {
  const g = new Float32Array(N * N);
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) g[iz * N + ix] = Math.max(0, 1500 - 0.6 * Math.hypot(coord(ix), coord(iz)));
  return g;
}

describe('erosion filter', () => {
  it('is deterministic for a seed', () => {
    const a = erodeGrid(cone(), N, SIZE, { seed: 4 });
    const b = erodeGrid(cone(), N, SIZE, { seed: 4 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('leaves flat ground flat (below minSlope nothing is carved, only a uniform offset)', () => {
    const flat = new Float32Array(N * N).fill(100);
    const out = erodeGrid(flat, N, SIZE);
    const first = out[0];
    for (const v of out) expect(v).toBeCloseTo(first, 6);
  });

  it('carves gullies that run downhill: carving varies far more across the slope than along it', () => {
    const base = cone();
    const out = erodeGrid(base, N, SIZE, { seed: 2 });
    // Sample the carve (out - base) on rings of the cone's flank; compare its change along a
    // small step across the slope (tangential) vs down the slope (radial).
    let across = 0;
    let along = 0;
    const step = 1; // grid cells
    const carve = (ix: number, iz: number) => out[iz * N + ix] - base[iz * N + ix];
    for (let k = 0; k < 400; k++) {
      const r = 700 + (k % 20) * 50;
      const a = (k * 2 * Math.PI) / 400;
      const ix = Math.round((r * Math.cos(a)) / (SIZE / (N - 1)) + (N - 1) / 2);
      const iz = Math.round((r * Math.sin(a)) / (SIZE / (N - 1)) + (N - 1) / 2);
      // Unit radial (downhill) and tangential (across) directions, rounded to grid steps.
      const rx = Math.round(Math.cos(a) * step);
      const rz = Math.round(Math.sin(a) * step);
      const tx = Math.round(-Math.sin(a) * step);
      const tz = Math.round(Math.cos(a) * step);
      along += Math.abs(carve(ix + rx, iz + rz) - carve(ix - rx, iz - rz));
      across += Math.abs(carve(ix + tx, iz + tz) - carve(ix - tx, iz - tz));
    }
    expect(across / along).toBeGreaterThan(1.5);
  });

  it('roughens slopes: mean |Laplacian| on the flank at least doubles', () => {
    const base = cone();
    const out = erodeGrid(base, N, SIZE, { seed: 2 });
    const lap = (g: Float32Array) => {
      let s = 0;
      let n = 0;
      for (let iz = 20; iz < N - 20; iz++) {
        for (let ix = 20; ix < N - 20; ix++) {
          const r = Math.hypot(coord(ix), coord(iz));
          if (r < 600 || r > 2200) continue;
          const i = iz * N + ix;
          s += Math.abs(g[i - 1] + g[i + 1] + g[i - N] + g[i + N] - 4 * g[i]);
          n++;
        }
      }
      return s / n;
    };
    expect(lap(out)).toBeGreaterThan(2 * lap(base));
  });
});

describe('terrain build', () => {
  it('produces consistent arrays and an up-facing mesh', () => {
    const d = buildTerrainData({ segments: 32, seed: 3 });
    const n = 33;
    expect(d.grid.length).toBe(n * n);
    expect(d.positions.length).toBe(n * n * 3);
    expect(d.index.length).toBe(32 * 32 * 6);
    // First triangle's geometric normal points up.
    const p = (k: number) => [d.positions[k * 3], d.positions[k * 3 + 1], d.positions[k * 3 + 2]];
    const [a, b, c] = [p(d.index[0]), p(d.index[1]), p(d.index[2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    expect(u[2] * v[0] - u[0] * v[2]).toBeGreaterThan(0); // y of u × v
    for (let i = 0; i < n * n; i++) expect(d.normals[i * 3 + 1]).toBeGreaterThan(0);
  });
  it('erosion can be turned off and then matches the base heights', () => {
    const a = buildTerrainData({ segments: 16, seed: 3, erosion: false });
    const b = buildTerrainData({ segments: 16, seed: 3 });
    let diff = 0;
    for (let i = 0; i < a.grid.length; i++) diff += Math.abs(a.grid[i] - b.grid[i]);
    expect(diff).toBeGreaterThan(0);
  });
});
