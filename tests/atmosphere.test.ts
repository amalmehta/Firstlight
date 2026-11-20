import { describe, expect, it } from 'vitest';
import { EARTH } from '../src/atmosphere/params';
import {
  opticalDepth,
  sunDirection,
  sunTransmittance,
  transmittance,
  transmittanceUvToRMu,
  verticalRayleighDepth,
} from '../src/atmosphere/reference';

// Bucholtz 1995, Applied Optics 34(15), Table 4: sea-level Rayleigh optical depth,
// 1962 US Standard Atmosphere, at 680 / 550 / 440 nm.
const BUCHOLTZ = [0.04102, 0.09721, 0.2429];

describe('Rayleigh optical depth vs Bucholtz 1995', () => {
  const ours = verticalRayleighDepth(EARTH);
  it.each([0, 1, 2])('channel %i is within 15%%', (i) => {
    const rel = Math.abs(ours[i] - BUCHOLTZ[i]) / BUCHOLTZ[i];
    expect(rel).toBeLessThan(0.15);
  });
  it('runs high, as documented (the standard coefficients use H = 8 km and lambda^-4)', () => {
    for (let i = 0; i < 3; i++) expect(ours[i]).toBeGreaterThan(BUCHOLTZ[i]);
  });
});

describe('sun transmittance at the ground', () => {
  it('reddens near sunset: red/blue > 2 at 2 degrees', () => {
    const t = sunTransmittance(EARTH, 2);
    expect(t[0] / t[2]).toBeGreaterThan(2);
  });
  it('is bright and near-white at 60 degrees: every channel > 0.7', () => {
    const t = sunTransmittance(EARTH, 60);
    for (const c of t) expect(c).toBeGreaterThan(0.7);
  });
  it('decreases as the sun sinks', () => {
    let prev = sunTransmittance(EARTH, 90);
    for (const el of [60, 30, 10, 5, 2, 0.5]) {
      const t = sunTransmittance(EARTH, el);
      for (let i = 0; i < 3; i++) expect(t[i]).toBeLessThan(prev[i]);
      prev = t;
    }
  });
  it('is zero below the horizon', () => {
    expect(sunTransmittance(EARTH, -3)).toEqual([0, 0, 0]);
  });
  it('is higher on a mountain than at sea level', () => {
    const sea = sunTransmittance(EARTH, 10, 0);
    const peak = sunTransmittance(EARTH, 10, 3);
    for (let i = 0; i < 3; i++) expect(peak[i]).toBeGreaterThan(sea[i]);
  });
});

describe('integration', () => {
  const r = EARTH.bottomRadius + 0.001;
  const exact = opticalDepth(EARTH, r, 1, 4000);
  const err = (steps: number) =>
    Math.max(...[0, 1, 2].map((i) => Math.abs(opticalDepth(EARTH, r, 1, steps)[i] - exact[i]) / exact[i]));
  it('the paper\'s 40 steps miss zenith depth by more than 1% (recorded negative result)', () => {
    expect(err(40)).toBeGreaterThan(0.01);
  });
  it('our 128 steps match a 4000-step integral within 0.25%', () => {
    expect(err(128)).toBeLessThan(0.0025);
  });
  it('a ray from the top of the atmosphere looking up has T = 1', () => {
    expect(transmittance(EARTH, EARTH.topRadius, 0.5)).toEqual([1, 1, 1]);
  });
});

describe('LUT parametrisation', () => {
  it('v = 0 is the ground, v = 1 the top', () => {
    expect(transmittanceUvToRMu(EARTH, 0.5, 0)[0]).toBeCloseTo(EARTH.bottomRadius, 6);
    expect(transmittanceUvToRMu(EARTH, 0.5, 1)[0]).toBeCloseTo(EARTH.topRadius, 6);
  });
  it('u = 0 looks straight up, u = 1 grazes the horizon', () => {
    expect(transmittanceUvToRMu(EARTH, 0, 0.5)[1]).toBeCloseTo(1, 6);
    const [r, mu] = transmittanceUvToRMu(EARTH, 1, 0.5);
    const horizonMu = -Math.sqrt(1 - (EARTH.bottomRadius / r) ** 2);
    expect(mu).toBeCloseTo(horizonMu, 6);
  });
});

describe('sunDirection', () => {
  it('is a unit vector', () => {
    const d = sunDirection(23, 140);
    expect(Math.hypot(...d)).toBeCloseTo(1, 12);
  });
  it('points up at 90 degrees, north (-z) at azimuth 0, east (+x) at 90', () => {
    expect(sunDirection(90, 0)[1]).toBeCloseTo(1, 12);
    expect(sunDirection(0, 0)[2]).toBeCloseTo(-1, 12);
    expect(sunDirection(0, 90)[0]).toBeCloseTo(1, 12);
  });
});
