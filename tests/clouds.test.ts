import { describe, expect, it } from 'vitest';
import {
  DROPLET_DIAMETER_UM,
  OCTAVES,
  cloudPhase,
  drainePhase,
  heightProfile,
  hgPhase,
  integrateStep,
  march,
  miePhaseParams,
  octaveScatter,
} from '../src/clouds/reference';
import { modelSlabRadianceAvg, traceSlab } from '../src/clouds/pathTrace';

/** ∫ p(cosθ) dω over the sphere = 2π ∫_0^π p(cos θ) sin θ dθ (Simpson in θ, which resolves
 * the narrow forward peak; a uniform grid in cos θ does not). */
function sphereIntegral(p: (c: number) => number, n = 200000): number {
  const h = Math.PI / n;
  const f = (th: number) => p(Math.cos(th)) * Math.sin(th);
  let s = f(0) + f(Math.PI);
  for (let i = 1; i < n; i++) s += f(i * h) * (i % 2 ? 4 : 2);
  return ((2 * Math.PI * h) / 3) * s;
}

/** Mean cosine ∫ p c dω. */
const meanCos = (p: (c: number) => number) => sphereIntegral((c) => p(c) * c);

describe('cloud phase function (Jendersie & d\'Eon 2023)', () => {
  it('HG and Draine each integrate to 1', () => {
    expect(sphereIntegral((c) => hgPhase(0.8, c))).toBeCloseTo(1, 4);
    expect(sphereIntegral((c) => drainePhase(0.5, 2, c))).toBeCloseTo(1, 4);
  });

  it('the blend integrates to 1 across the fitted droplet range', () => {
    for (const d of [5.5, 10, 20, 35, 49]) {
      const p = miePhaseParams(d);
      expect(sphereIntegral((c) => cloudPhase(p, c))).toBeCloseTo(1, 3);
    }
  });

  it('is strongly forward scattering with a mean cosine near water clouds (~0.85)', () => {
    // Water-droplet clouds have an asymmetry parameter of about 0.85 in the visible
    // (e.g. Hansen & Travis 1974); the fitted model should land close to it.
    const p = miePhaseParams(DROPLET_DIAMETER_UM);
    const g = meanCos((c) => cloudPhase(p, c));
    expect(g).toBeGreaterThan(0.8);
    expect(g).toBeLessThan(0.92);
  });

  it('has more back-scatter than a single HG of the same mean cosine (the fog-bow side)', () => {
    const p = miePhaseParams(DROPLET_DIAMETER_UM);
    const g = meanCos((c) => cloudPhase(p, c));
    expect(cloudPhase(p, -1)).toBeGreaterThan(hgPhase(g, -1));
  });
});

describe('scattering integration (Frostbite 2016)', () => {
  it('matches the analytic slab: L = S(1 - e^{-σd})/σ, T = e^{-σd}, for any step count', () => {
    const S = 3;
    const sigma = 40; // per km, a thin cloud
    const d = 0.2;
    for (const steps of [1, 4, 64]) {
      const r = march(d, steps, () => sigma, () => S);
      expect(r.L).toBeCloseTo((S * (1 - Math.exp(-sigma * d))) / sigma, 10);
      expect(r.T).toBeCloseTo(Math.exp(-sigma * d), 10);
    }
  });

  it('never returns more than S/σ (the naive S·dt step does, badly, in dense cloud)', () => {
    const S = 1;
    const sigma = 60;
    expect(integrateStep(S, sigma, 0.5)).toBeLessThanOrEqual(S / sigma);
    expect(S * 0.5).toBeGreaterThan(10 * (S / sigma)); // the naive version overshoots 30x
  });

  it('a non-absorbing medium never returns more light than it received', () => {
    // Isotropic single scattering of a unit beam along the view ray: S = σ/4π per sr;
    // the integral over all view directions of the scattered light is bounded by 1 - T.
    const sigma = 50;
    const d = 0.3;
    const r = march(d, 32, () => sigma, () => sigma);
    expect(r.L).toBeLessThanOrEqual(1 - r.T + 1e-12);
  });
});

describe('multiple-scattering octaves (Wrenninge 2013)', () => {
  it('reduce to single scattering when a = 0', () => {
    const one = octaveScatter(3, 0.2, { count: 4, a: 0, b: 0.5, c: 0.5 });
    expect(one).toBeCloseTo(Math.exp(-3) * 0.2, 12);
  });

  it('let light through optically thick cloud (τ = 10) that single scattering cannot', () => {
    const single = octaveScatter(10, 1 / (4 * Math.PI), { count: 1, a: 0.5, b: 0.5, c: 0.5 });
    const multi = octaveScatter(10, 1 / (4 * Math.PI));
    expect(multi / single).toBeGreaterThan(50);
  });

  it('use a ≤ b, the energy-conservation condition from the Frostbite notes', () => {
    expect(OCTAVES.a).toBeLessThanOrEqual(OCTAVES.b);
    // With τ = 0 the octave weights sum to (1 - aᴺ)/(1 - a) < 1/(1 - a).
    expect(octaveScatter(0, 1 / (4 * Math.PI)) * 4 * Math.PI).toBeLessThan(1 / (1 - OCTAVES.a));
  });
});

describe('cumulus height profile', () => {
  it('is zero outside the layer and peaks inside it', () => {
    expect(heightProfile(0, 0.5)).toBe(0);
    expect(heightProfile(1, 0.5)).toBe(0);
    expect(heightProfile(0.2, 0.5)).toBeGreaterThan(0.9);
  });
  it('tall types reach higher than flat ones', () => {
    expect(heightProfile(0.7, 1)).toBeGreaterThan(heightProfile(0.7, 0));
    expect(heightProfile(0.5, 0)).toBe(0);
  });
});

describe('calibration against a path-traced cloud slab', () => {
  // Monte Carlo ground truth (pathTrace.ts): a slab of optical thickness 50 (1 km of cumulus
  // at 50/km), conservative scattering, the same phase function. 20k paths per sun height.
  const p = miePhaseParams(DROPLET_DIAMETER_UM);
  const sun = [22, 60].map((el) => Math.sin((el * Math.PI) / 180));
  const mc = sun.map((mu, i) => traceSlab(p, 50, mu, 20000, 5, 11 + i));
  const mus = [0.3, 0.5, 0.7, 0.9]; // view cosines = centres of bins 1-4

  const logErr = (o: { count: number; a: number; b: number; c: number }) => {
    let e = 0;
    let worst = 0;
    sun.forEach((ms, i) =>
      mus.forEach((mu, j) => {
        const r = Math.log(modelSlabRadianceAvg(p, 50, ms, mu, o) / mc[i].radiance[j + 1]);
        e += r * r;
        worst = Math.max(worst, Math.abs(r));
      }),
    );
    return { rms: Math.sqrt(e / (sun.length * mus.length)), worst };
  };

  it('the path tracer conserves energy: reflected + transmitted = 1, and a thick cloud is bright', () => {
    for (const r of mc) {
      expect(r.reflectance + r.transmittance).toBeCloseTo(1, 10);
      expect(r.reflectance).toBeGreaterThan(0.75);
    }
  });

  it('the fitted octaves land within ~35% RMS (worst 1.8x) of the path tracer', () => {
    const fit = logErr(OCTAVES);
    expect(fit.rms).toBeLessThan(0.35);
    expect(fit.worst).toBeLessThan(Math.log(1.8));
  });

  it('the commonly quoted a = b = c = 1/2 is far darker than the path tracer (a negative result kept on record)', () => {
    const half = logErr({ count: 8, a: 0.5, b: 0.5, c: 0.5 });
    expect(half.rms).toBeGreaterThan(1.0); // e^1 ≈ 2.7x off on average
  });
});
