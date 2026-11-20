/**
 * Monte Carlo reference for a plane-parallel cloud slab: the ground truth that the real-time
 * model (single march + multiple-scattering octaves, reference.ts / glsl.ts) is calibrated
 * against. Conservative scattering (albedo 1) with the Jendersie & d'Eon phase function,
 * sampled from a tabulated inverse CDF. Pure sunlight, no ground, no atmosphere.
 *
 * Units: optical depth. The slab spans z = 0 (top) to z = tau0, with z increasing downward.
 */
import { cloudPhase, octaveScatter, type MiePhaseParams } from './reference';

/** Deterministic PRNG (mulberry32), so tests are repeatable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inverse-CDF table for cos θ of the phase function, dense near the forward peak. */
export function phaseSampler(p: MiePhaseParams, n = 40000): (u: number) => number {
  const th = new Float64Array(n);
  const cdf = new Float64Array(n);
  for (let i = 0; i < n; i++) th[i] = Math.PI * Math.pow(i / (n - 1), 3);
  for (let i = 1; i < n; i++) {
    const f0 = cloudPhase(p, Math.cos(th[i - 1])) * Math.sin(th[i - 1]);
    const f1 = cloudPhase(p, Math.cos(th[i])) * Math.sin(th[i]);
    cdf[i] = cdf[i - 1] + 0.5 * (f0 + f1) * (th[i] - th[i - 1]) * 2 * Math.PI;
  }
  const total = cdf[n - 1];
  for (let i = 0; i < n; i++) cdf[i] /= total;
  return (u: number) => {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid;
      else hi = mid;
    }
    const f = (u - cdf[lo]) / Math.max(cdf[hi] - cdf[lo], 1e-300);
    return Math.cos(th[lo] + f * (th[hi] - th[lo]));
  };
}

export interface SlabResult {
  /** Fraction of incident power leaving the top. */
  reflectance: number;
  /** Fraction leaving the bottom. */
  transmittance: number;
  /**
   * Reflected radiance, azimuth-averaged, in bins of view cosine μ (0..1, `bins` equal bins),
   * normalised by the perpendicular sun irradiance E (so the value is L / E, per sr).
   */
  radiance: number[];
}

/** Path-trace `photons` sunlight paths into a slab of optical thickness tau0. muSun: sine of sun elevation. */
export function traceSlab(p: MiePhaseParams, tau0: number, muSun: number, photons: number, bins = 5, seed = 1): SlabResult {
  const rand = rng(seed);
  const sample = phaseSampler(p);
  let up = 0;
  let down = 0;
  const hist = new Array(bins).fill(0);
  for (let k = 0; k < photons; k++) {
    // Direction (x, y, z) with z pointing down into the slab.
    let dx = Math.sqrt(1 - muSun * muSun);
    let dy = 0;
    let dz = muSun;
    let z = 0;
    for (let guard = 0; guard < 100000; guard++) {
      z += dz * -Math.log(1 - rand());
      if (z < 0) {
        up++;
        const mu = -dz;
        hist[Math.min(bins - 1, Math.floor(mu * bins))]++;
        break;
      }
      if (z > tau0) {
        down++;
        break;
      }
      // Scatter: new direction at angle θ from the old one, uniform azimuth.
      const c = sample(rand());
      const s = Math.sqrt(Math.max(0, 1 - c * c));
      const phi = 2 * Math.PI * rand();
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      if (Math.abs(dz) > 0.99999) {
        dx = s * cp;
        dy = s * sp;
        dz = c * Math.sign(dz);
      } else {
        const q = Math.sqrt(1 - dz * dz);
        const nx = s * (dx * dz * cp - dy * sp) / q + dx * c;
        const ny = s * (dy * dz * cp + dx * sp) / q + dy * c;
        const nz = -s * cp * q + dz * c;
        dx = nx;
        dy = ny;
        dz = nz;
      }
    }
  }
  // Power in bin / (incident power) = ∫ L μ dω / (E μs); with azimuth averaging,
  // ∫ over the bin of μ dω = 2π ∫ μ dμ = π (μ1² - μ0²).
  const radiance = hist.map((h, i) => {
    const m0 = i / bins;
    const m1 = (i + 1) / bins;
    return ((h / photons) * muSun) / (Math.PI * (m1 * m1 - m0 * m0));
  });
  return { reflectance: up / photons, transmittance: down / photons, radiance };
}

/**
 * The real-time model on the same slab: march a view ray (view cosine muView, azimuth phiView
 * relative to the sun) with the octave approximation and the exact optical depth to the sun.
 * Returns L / E.
 */
export function modelSlabRadiance(
  p: MiePhaseParams,
  tau0: number,
  muSun: number,
  muView: number,
  phiView: number,
  octaves: { count: number; a: number; b: number; c: number },
  steps = 1000,
): number {
  // Light travel direction (into the slab) and the direction towards the eye (out of it).
  const sinS = Math.sqrt(1 - muSun * muSun);
  const sinV = Math.sqrt(1 - muView * muView);
  // cos of the angle between the light's travel direction and the direction to the eye.
  const cosScatter = sinS * sinV * Math.cos(phiView) - muSun * muView;
  const ph = cloudPhase(p, cosScatter);
  const sMax = Math.min(tau0 / muView, 60);
  const ds = sMax / steps;
  let L = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * ds;
    const z = s * muView;
    const tauSun = z / muSun;
    L += octaveScatter(tauSun, ph, octaves) * Math.exp(-s) * ds;
  }
  return L;
}

/** Azimuth-average of the model radiance at view cosine mu. */
export function modelSlabRadianceAvg(
  p: MiePhaseParams,
  tau0: number,
  muSun: number,
  mu: number,
  octaves: { count: number; a: number; b: number; c: number },
  n = 32,
): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += modelSlabRadiance(p, tau0, muSun, mu, ((i + 0.5) / n) * 2 * Math.PI, octaves);
  return s / n;
}
