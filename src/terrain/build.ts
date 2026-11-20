/**
 * Pure terrain generation: heights, erosion, normals, colours and mesh arrays, with no
 * three.js and no DOM, so it can run in a Web Worker (terrainWorker.ts) and hand typed arrays
 * back without copying. Terrain.ts wraps the result in a mesh.
 */
import { Noise2D } from './noise';
import { erodeGrid, type ErosionOptions } from './erosion';

export interface TerrainOptions {
  /** Side length, metres. Default 20 000 (a 20 km valley). */
  size?: number;
  /** Grid resolution per side. Default 512 (39 m spacing at 20 km). */
  segments?: number;
  /** Peak relief above the valley floor, metres. Default 1900. */
  height?: number;
  /** Altitude of the snow line, metres above the valley floor. Default 1300. */
  snowLine?: number;
  seed?: number;
  /** Carve branching gullies (erosion filter). Default on; false to turn off, or options. */
  erosion?: boolean | ErosionOptions;
}

export interface TerrainData {
  size: number;
  segments: number;
  /** (segments+1)² heights, row-major: z rows, x columns. */
  grid: Float32Array;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  index: Uint32Array;
  maxHeight: number;
}

// Linear albedos (estimates within published ranges, e.g. the ASTER/ECOSTRESS spectral
// library: meadow grass ~0.1-0.2, conifer canopy ~0.03-0.08, granite/gneiss ~0.1-0.3,
// old snow ~0.6-0.9). Labelled estimates, not measured values.
const GRASS = [0.075, 0.115, 0.035];
const DRY = [0.16, 0.15, 0.085];
const FOREST = [0.022, 0.038, 0.018];
const ROCK = [0.13, 0.122, 0.112];
const SNOW = [0.78, 0.8, 0.84];

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The un-eroded valley: a gentle floor along the z axis, ridged mountains rising towards the
 * edges so the tile's border is hidden behind peaks.
 */
export function baseHeight(noise: Noise2D, size: number, relief: number, x: number, z: number): number {
  const half = size / 2;
  // Domain warp: bend the coordinates by a low-frequency noise so ridges meander.
  const wx = x + 900 * noise.fbm(x / 5000 + 11, z / 5000, 3);
  const wz = z + 900 * noise.fbm(x / 5000, z / 5000 + 23, 3);
  const ridges = noise.ridged(wx / 3400, wz / 3400, 8);
  const d = Math.hypot(x / half, (z / half) * 0.62);
  const mask = smooth(0.07, 0.62, d + 0.12 * noise.fbm(x / 2500, z / 2500, 2));
  const floor = 35 * noise.fbm(x / 900, z / 900, 4);
  return floor + relief * mask * (0.25 + 0.75 * ridges) * (0.75 + 0.5 * mask);
}

export function buildTerrainData(opts: TerrainOptions = {}): TerrainData {
  const size = opts.size ?? 20000;
  const segments = opts.segments ?? 512;
  const relief = opts.height ?? 1900;
  const seed = opts.seed ?? 7;
  const snowLine = opts.snowLine ?? 1300;
  const noise = new Noise2D(seed);
  const n = segments + 1;
  const cell = size / segments;

  let grid: Float32Array = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      grid[iz * n + ix] = baseHeight(noise, size, relief, (ix / segments - 0.5) * size, (iz / segments - 0.5) * size);
    }
  }
  const er = opts.erosion ?? true;
  if (er !== false) grid = erodeGrid(grid, n, size, { seed, ...(typeof er === 'object' ? er : {}) });

  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const at = (ix: number, iz: number) => grid[Math.min(n - 1, Math.max(0, iz)) * n + Math.min(n - 1, Math.max(0, ix))];
  let maxHeight = -Infinity;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      const x = (ix / segments - 0.5) * size;
      const z = (iz / segments - 0.5) * size;
      const h = grid[i];
      if (h > maxHeight) maxHeight = h;
      positions[i * 3] = x;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = z;
      // Normal from central differences on the grid.
      const gx = (at(ix + 1, iz) - at(ix - 1, iz)) / (2 * cell);
      const gz = (at(ix, iz + 1) - at(ix, iz - 1)) / (2 * cell);
      const l = Math.hypot(gx, 1, gz);
      const up = 1 / l;
      normals[i * 3] = -gx / l;
      normals[i * 3 + 1] = up;
      normals[i * 3 + 2] = -gz / l;
      // Albedo from slope and height (grass on the floor, conifers to ~700 m, rock on steep
      // faces, snow above the snow line on slopes gentle enough to hold it).
      const jitter = noise.fbm(x / 180, z / 180, 3); // breaks up hard bands
      const mix = (out: number[], a: number[], t: number) => {
        out[0] += (a[0] - out[0]) * t;
        out[1] += (a[1] - out[1]) * t;
        out[2] += (a[2] - out[2]) * t;
      };
      const c = [GRASS[0], GRASS[1], GRASS[2]];
      mix(c, DRY, smooth(0.0, 0.35, jitter + h / 2400));
      const trees = smooth(30, 120, h + jitter * 200) * smooth(760, 600, h + jitter * 220) *
        smooth(0.72, 0.8, up) * smooth(-0.05, 0.12, noise.fbm(x / 700, z / 700, 3));
      mix(c, FOREST, trees);
      mix(c, ROCK, smooth(0.84, 0.7, up + jitter * 0.08));
      mix(c, SNOW, smooth(snowLine - 100, snowLine + 200, h + jitter * 300) * smooth(0.66, 0.82, up));
      colors[i * 3] = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
    }
  }
  // Two triangles per cell, wound to face +y.
  const index = new Uint32Array(segments * segments * 6);
  let k = 0;
  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iz * n + ix;
      const b = (iz + 1) * n + ix;
      const c = (iz + 1) * n + ix + 1;
      const d = iz * n + ix + 1;
      index[k++] = a; index[k++] = b; index[k++] = d;
      index[k++] = b; index[k++] = c; index[k++] = d;
    }
  }
  return { size, segments, grid, positions, normals, colors, index, maxHeight };
}
