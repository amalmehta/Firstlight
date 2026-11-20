/**
 * Erosion filter: carve branching gullies into a heightfield without simulating water.
 *
 * Idea (independent implementation of the approach described by Rune Skovbo Johansen,
 * "Fast and Gorgeous Erosion Filter", blog.runevision.com, March 2026, which builds on
 * Clay John's eroded-terrain noise; no code was copied):
 *
 * 1. Water runs downhill, so gullies run along the slope. Model a gully pattern as waves
 *    that vary *across* the slope and stay constant *along* it: cos(2π · d · across).
 * 2. One direction per point isn't enough to make a pattern, so scatter cells on a grid,
 *    each with a jittered pivot, run the waves around each pivot, and blend neighbours with a
 *    Gaussian weight. Blending (cos, sin) pairs of misaligned waves shrinks the pair's length;
 *    rescaling it (length × 2, capped at 1) keeps contrast without the spikes full
 *    normalisation causes.
 * 3. Octaves: each finer octave follows the slope left by the coarser ones, so small gullies
 *    feed into big ones (the branching look). For the direction we use the sign of the slope
 *    change, not its value, which keeps gullies straight.
 * 4. Flat ground has no downhill direction. There the stripes fade to a target that is -1 in
 *    valleys and +1 on peaks (from altitude), with an ease-out on slope, 1 - (1 - t)², so
 *    valley floors stay smooth and ridges stay sharp.
 * 5. A mask, multiplied down the octaves, damps fine gullies on the crests and creases of
 *    coarser ones, so small gullies don't run across big ridges.
 *
 * It's an aesthetic filter, not hydrology: drainage lines can stop part-way down a slope
 * (the author notes the same limit).
 */
export interface ErosionOptions {
  /** Gully spacing of the coarsest octave, metres. Default 900 (chosen by side-by-side comparison with 700). */
  spacing?: number;
  /** Gully depth of the coarsest octave, metres. Default 40 (30 looked soft, 55 lumpy). */
  depth?: number;
  /** Octaves (each half the spacing and depth). Default 3. */
  octaves?: number;
  /** Slope (rise/run) at which gullies reach full strength. Default 0.6. */
  fullSlope?: number;
  /** Slope below which ground is left untouched (valley floors). Default 0.12. */
  minSlope?: number;
  seed?: number;
}

const TAU = Math.PI * 2;

/** Hash of an integer cell to two numbers in [0, 1), written to HASH (no allocation). */
const HASH = new Float64Array(2);
function hash2(ix: number, iz: number, seed: number): void {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  HASH[0] = (h >>> 0) / 4294967296;
  HASH[1] = (Math.imul(h, 0x9e3779b1) >>> 0) / 4294967296;
}

/** Output of stripes(): [cos, sin] of the blended gully wave (no allocation). */
export const STRIPE = new Float64Array(2);

/**
 * Blended gully waves at (px, pz) in cell units, varying along unit vector (ax, az); result in
 * STRIPE. 3×3 cells, compact smooth weight (1 - d²/r²)², r = 1.5 cells (close to the Gaussian
 * exp(-2d²) in shape, without the exp).
 */
export function stripes(px: number, pz: number, ax: number, az: number, seed: number): void {
  const ix = Math.floor(px);
  const iz = Math.floor(pz);
  let c = 0;
  let s = 0;
  let w = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      hash2(ix + i, iz + j, seed);
      const dx = px - (ix + i + HASH[0]);
      const dz = pz - (iz + j + HASH[1]);
      const q = 1 - (dx * dx + dz * dz) / 2.25;
      if (q <= 0) continue;
      const wt = q * q;
      const phase = TAU * (dx * ax + dz * az);
      c += wt * Math.cos(phase);
      s += wt * Math.sin(phase);
      w += wt;
    }
  }
  STRIPE[0] = 0;
  STRIPE[1] = 0;
  if (w <= 1e-12) return;
  c /= w;
  s /= w;
  const len = Math.hypot(c, s);
  if (len < 1e-9) return;
  const k = Math.min(len * 2, 1) / len;
  STRIPE[0] = c * k;
  STRIPE[1] = s * k;
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

/**
 * Erode a square height grid in place. heights: (n × n) row-major, z rows, x columns;
 * the grid spans [-size/2, size/2] on both axes. Returns the eroded copy.
 */
export function erodeGrid(heights: Float32Array, n: number, size: number, opts: ErosionOptions = {}): Float32Array {
  const spacing = opts.spacing ?? 900;
  const depth = opts.depth ?? 40;
  const octaves = opts.octaves ?? 3;
  const fullSlope = opts.fullSlope ?? 0.6;
  const minSlope = opts.minSlope ?? 0.12;
  const seed = opts.seed ?? 1;
  const cell = size / (n - 1);
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of heights) { if (h < lo) lo = h; if (h > hi) hi = h; }
  const out = new Float32Array(heights.length);
  const at = (ix: number, iz: number) =>
    heights[Math.min(n - 1, Math.max(0, iz)) * n + Math.min(n - 1, Math.max(0, ix))];

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = (ix / (n - 1) - 0.5) * size;
      const z = (iz / (n - 1) - 0.5) * size;
      const b = heights[iz * n + ix];
      // Slope from the grid (central differences): uphill direction and steepness.
      let gx = (at(ix + 1, iz) - at(ix - 1, iz)) / (2 * cell);
      let gz = (at(ix, iz + 1) - at(ix, iz - 1)) / (2 * cell);
      let target = (2 * (b - lo)) / Math.max(hi - lo, 1e-6) - 1; // -1 valleys … +1 peaks
      let mask = 1;
      let carve = 0;
      for (let o = 0; o < octaves; o++) {
        const freq = Math.pow(2, o) / spacing;
        const amp = depth / Math.pow(2, o);
        const slope = Math.hypot(gx, gz);
        const ux = slope > 1e-9 ? gx / slope : 1;
        const uz = slope > 1e-9 ? gz / slope : 0;
        // Waves vary across the slope: along the perpendicular of the downhill direction.
        const ax = -uz;
        const az = ux;
        stripes(x * freq, z * freq, ax, az, seed + o * 101);
        const cw = STRIPE[0];
        const sw = STRIPE[1];
        const f = easeOut(Math.min(Math.max((slope - minSlope) / (fullSlope - minSlope), 0), 1));
        const v = target + (cw - target) * f;
        carve += v * amp * mask;
        // Slope change from this octave, sign-faked to keep the next octave's gullies straight.
        const k = Math.sign(sw) * amp * mask * f * TAU * freq * 0.5;
        gx -= k * ax;
        gz -= k * az;
        mask *= 1 - 0.5 * v * v;
        target = v;
      }
      out[iz * n + ix] = b + carve;
    }
  }
  return out;
}
