/**
 * CPU reference for the cloud model. The GLSL in glsl.ts mirrors these functions; the tests
 * check the maths here (normalisation, energy, the integration step), and the self-check page
 * compares the GPU against them.
 *
 * Sources
 * - Phase function: Jendersie & d'Eon, "An Approximate Mie Scattering Function for Fog and
 *   Cloud Rendering", SIGGRAPH 2023 Talks, Eqs. 3-7 (a Henyey-Greenstein forward lobe blended
 *   with Draine's phase function, parameters fitted to water-droplet diameter d, 5-50 µm).
 * - Draine's phase function: Draine 2003, ApJ 598, 1017.
 * - Integration step: Hillaire, "Physically Based Sky, Atmosphere and Cloud Rendering in
 *   Frostbite", SIGGRAPH 2016 course notes, §5.6 (energy-conserving analytic integral over
 *   a step of constant extinction).
 * - Multiple scattering: Wrenninge, Kulla & Lundqvist 2013 ("Oz"), as used in the Frostbite
 *   notes Eq. 19-20: N octaves with σs·aⁱ, σe·bⁱ and a flattened phase; energy is conserved
 *   only when a ≤ b.
 */

const FOUR_PI = 4 * Math.PI;

export interface MiePhaseParams {
  gHG: number;
  gD: number;
  alpha: number;
  wD: number;
}

/** Jendersie & d'Eon 2023, Eqs. 4-7. d: droplet diameter in µm, valid for 5 < d < 50. */
export function miePhaseParams(d: number): MiePhaseParams {
  return {
    gHG: Math.exp(-0.0990567 / (d - 1.67154)),
    gD: Math.exp(-2.20679 / (d + 3.91029) - 0.428934),
    alpha: Math.exp(3.62489 - 8.29288 / (d + 5.52825)),
    wD: Math.exp(-0.599085 / (d - 0.641583) - 0.665888),
  };
}

/** Henyey-Greenstein, per steradian. c = cos(angle between light travel and view). */
export function hgPhase(g: number, c: number): number {
  return (1 - g * g) / (FOUR_PI * Math.pow(1 + g * g - 2 * g * c, 1.5));
}

/** Draine 2003, per steradian. alpha = 0 gives Henyey-Greenstein; alpha = 1, g = 0 gives Rayleigh-like. */
export function drainePhase(g: number, alpha: number, c: number): number {
  return (
    ((1 - g * g) / Math.pow(1 + g * g - 2 * g * c, 1.5)) *
    ((1 + alpha * c * c) / (1 + (alpha * (1 + 2 * g * g)) / 3)) /
    FOUR_PI
  );
}

/** The blended cloud phase function (Eq. 3). */
export function cloudPhase(p: MiePhaseParams, c: number): number {
  return (1 - p.wD) * hgPhase(p.gHG, c) + p.wD * drainePhase(p.gD, p.alpha, c);
}

/** Default droplet diameter: 20 µm, a typical fair-weather cumulus value (estimate). */
export const DROPLET_DIAMETER_UM = 20;

/**
 * Multiple-scattering octaves (Wrenninge 2013). Octave i scatters σs·aⁱ, is shadowed by
 * optical depth τ·bⁱ, and uses a phase flattened towards isotropic by cⁱ (a mix towards
 * 1/4π, our stand-in for the paper's p(θ·cⁱ), which is not a normalised function).
 *
 * Values fitted here, not taken from a paper: against a Monte Carlo path trace of a thick
 * slab (pathTrace.ts; τ = 50, sun 10-60°, view cosines 0.3-0.9) the commonly quoted
 * a = b = c = ½ (4-8 octaves) is 2.5-6× too dark. The best fit on a grid with a ≤ b
 * (Frostbite's energy condition) is N = 8, a = 0.8, b = 0.9, c = 0.25: RMS error in log
 * radiance 0.30 (about 35%), worst case a factor of 1.7. See VIZ-LOG.md.
 */
export const OCTAVES = { count: 8, a: 0.8, b: 0.9, c: 0.25 } as const;

/** Sum over octaves of (scatter weight) × (sun transmittance through optical depth tau) × phase. */
export function octaveScatter(tau: number, phase: number, o: { count: number; a: number; b: number; c: number } = OCTAVES): number {
  let s = 0;
  for (let i = 0; i < o.count; i++) {
    const ph = 1 / FOUR_PI + (phase - 1 / FOUR_PI) * Math.pow(o.c, i);
    s += Math.pow(o.a, i) * Math.exp(-tau * Math.pow(o.b, i)) * ph;
  }
  return s;
}

/**
 * One energy-conserving integration step (Frostbite 2016, Eq. 23): light S scattered towards
 * the eye per unit length, constant over a step of length dt with extinction sigmaT.
 * Returns the step's contribution (before the transmittance in front of it).
 */
export function integrateStep(S: number, sigmaT: number, dt: number): number {
  if (sigmaT < 1e-9) return S * dt;
  return (S - S * Math.exp(-sigmaT * dt)) / sigmaT;
}

/**
 * March a ray through a medium sampled by sigmaT(t) with in-scattered light S(t), from 0 to
 * length, in `steps` equal steps (midpoints). Returns radiance and transmittance.
 */
export function march(
  length: number,
  steps: number,
  sigmaT: (t: number) => number,
  S: (t: number) => number,
): { L: number; T: number } {
  const dt = length / steps;
  let L = 0;
  let T = 1;
  for (let k = 0; k < steps; k++) {
    const t = (k + 0.5) * dt;
    const st = sigmaT(t);
    L += T * integrateStep(S(t), st, dt);
    T *= Math.exp(-st * dt);
  }
  return { L, T };
}

/**
 * Vertical density profile of a cumulus layer. h: 0 at the base, 1 at the top. `type` 0..1
 * sets how tall this cloud grows (0: flat fair-weather cumulus, 1: towering to the layer top).
 * A shape estimate after Schneider 2015 (Nubis) height gradients, not a measurement.
 */
export function heightProfile(h: number, type: number): number {
  if (h <= 0 || h >= 1) return 0;
  const top = 0.45 + 0.55 * type;
  const sstep = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  return sstep(0, 0.08, h) * sstep(top, top * 0.55, h);
}
