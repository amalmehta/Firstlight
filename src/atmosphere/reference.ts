/**
 * CPU reference for the atmosphere: the same maths as the GPU transmittance pass,
 * written plainly. It does two jobs:
 *  1. The sun light colour each frame (transmittance from the sun to the camera).
 *  2. The test oracle the GPU LUT is checked against (examples/selfcheck.html).
 *
 * Transmittance T = exp(-tau), where tau (optical depth) is the integral of the
 * extinction coefficient along the ray. Think of it as "how much fog the ray passes
 * through": each kilometre removes a fraction of the light, so the losses multiply,
 * which is why the total is an exponential of a sum.
 */
import type { AtmosphereParams } from './params';

export type RGB = [number, number, number];

/** Extinction (1/km, RGB) at height h km above the ground. */
export function extinctionAt(p: AtmosphereParams, h: number): RGB {
  const hh = Math.max(h, 0);
  const dR = Math.exp(-hh / p.rayleighScaleHeight);
  const dM = Math.exp(-hh / p.mieScaleHeight);
  const dO = Math.max(0, 1 - Math.abs(hh - p.ozoneCenter) / p.ozoneHalfWidth);
  return [0, 1, 2].map(
    (i) => p.rayleighScattering[i] * dR + p.mieExtinction * dM + p.ozoneAbsorption[i] * dO,
  ) as RGB;
}

/** Distance from a point at radius r with view cosine mu to the sphere of radius R, or -1. */
export function distanceToSphere(r: number, mu: number, R: number): number {
  const disc = r * r * (mu * mu - 1) + R * R;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -r * mu - s;
  const t1 = -r * mu + s;
  if (t0 >= 0) return t0;
  if (t1 >= 0) return t1;
  return -1;
}

/** True when a ray from radius r with view cosine mu hits the ground. */
export function hitsGround(p: AtmosphereParams, r: number, mu: number): boolean {
  return mu < 0 && r * r * (mu * mu - 1) + p.bottomRadius * p.bottomRadius >= 0;
}

/**
 * Optical depth from radius r (km from planet centre) along view cosine mu to the
 * top of the atmosphere. Midpoint rule with `steps` samples, matching the GPU pass.
 * Returns Infinity if the ray hits the ground.
 */
export const TRANSMITTANCE_STEPS = 128;

/**
 * Note: the paper uses 40 steps. With a 1.2 km Mie scale height and 2.5 km steps that
 * misestimates zenith optical depth by about 1.7% (see tests), so we use 128: the LUT
 * is computed once, so the extra cost is a one-off fraction of a millisecond.
 */
export function opticalDepth(
  p: AtmosphereParams,
  r: number,
  mu: number,
  steps = TRANSMITTANCE_STEPS,
): RGB {
  if (hitsGround(p, r, mu)) return [Infinity, Infinity, Infinity];
  const tMax = distanceToSphere(r, mu, p.topRadius);
  if (tMax <= 0) return [0, 0, 0];
  const dt = tMax / steps;
  const tau: RGB = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    // Radius at distance t along the ray (law of cosines).
    const ri = Math.sqrt(r * r + t * t + 2 * r * mu * t);
    const e = extinctionAt(p, ri - p.bottomRadius);
    tau[0] += e[0] * dt;
    tau[1] += e[1] * dt;
    tau[2] += e[2] * dt;
  }
  return tau;
}

export function transmittance(
  p: AtmosphereParams,
  r: number,
  mu: number,
  steps = TRANSMITTANCE_STEPS,
): RGB {
  return opticalDepth(p, r, mu, steps).map((t) => Math.exp(-t)) as RGB;
}

/** Closed-form vertical Rayleigh optical depth from sea level, RGB. */
export function verticalRayleighDepth(p: AtmosphereParams): RGB {
  const H = p.rayleighScaleHeight;
  const top = p.topRadius - p.bottomRadius;
  return p.rayleighScattering.map((b) => b * H * (1 - Math.exp(-top / H))) as RGB;
}

/**
 * Unit sun direction, y up. Elevation in degrees above the horizon; azimuth in degrees
 * clockwise from north, where north is -z and east is +x (the three.js default view
 * looks down -z, so azimuth 0 puts the sun straight ahead).
 */
export function sunDirection(elevationDeg: number, azimuthDeg: number): RGB {
  const el = (elevationDeg * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/**
 * Fraction of sunlight (RGB) that reaches an observer at altitude `altitudeKm`, for a
 * sun at `elevationDeg`. Multiply by the solar illuminance to get the light colour.
 * Below the geometric horizon this is 0 (the planet blocks the sun).
 */
export function sunTransmittance(
  p: AtmosphereParams,
  elevationDeg: number,
  altitudeKm = 0,
  steps = 200,
): RGB {
  const r = p.bottomRadius + Math.max(altitudeKm, 0.001);
  const mu = Math.sin((elevationDeg * Math.PI) / 180);
  return transmittance(p, r, mu, steps);
}

/* ---- Transmittance LUT parametrisation (Bruneton 2017, used by Hillaire 2020) ----
 * The LUT stores T for every (r, mu) whose ray does not hit the ground. u and v are
 * chosen so texels are dense near the horizon, where T changes fastest.
 */
export function transmittanceUvToRMu(p: AtmosphereParams, u: number, v: number): [number, number] {
  const H = Math.sqrt(p.topRadius ** 2 - p.bottomRadius ** 2);
  const rho = H * v;
  const r = Math.sqrt(rho * rho + p.bottomRadius ** 2);
  const dMin = p.topRadius - r;
  const dMax = rho + H;
  const d = dMin + u * (dMax - dMin);
  let mu = d === 0 ? 1 : (H * H - rho * rho - d * d) / (2 * r * d);
  mu = Math.min(1, Math.max(-1, mu));
  return [r, mu];
}
