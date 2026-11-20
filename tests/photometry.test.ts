import { describe, expect, it } from 'vitest';
import {
  describeEv,
  ev100FromCamera,
  ev100FromIlluminance,
  exposureScale,
  saturationLuminance,
} from '../src/camera/photometry';

describe('EV100', () => {
  it('Sunny 16 (f/16, 1/125 s, ISO 100) is about EV 15', () => {
    expect(ev100FromCamera({ aperture: 16, shutter: 1 / 125, iso: 100 })).toBeCloseTo(14.97, 2);
  });
  it('doubling ISO lowers EV100 by one stop', () => {
    const a = ev100FromCamera({ aperture: 8, shutter: 1 / 60, iso: 100 });
    const b = ev100FromCamera({ aperture: 8, shutter: 1 / 60, iso: 200 });
    expect(a - b).toBeCloseTo(1, 10);
  });
  it('an incident meter in 100 klx sunlight reads about EV 15.3 (agrees with Sunny 16 within half a stop)', () => {
    const ev = ev100FromIlluminance(100_000);
    expect(ev).toBeCloseTo(15.29, 2);
    expect(Math.abs(ev - 14.97)).toBeLessThan(0.5);
  });
});

describe('exposure', () => {
  it('saturation luminance at EV 0 is 1.2 cd/m²', () => {
    expect(saturationLuminance(0)).toBeCloseTo(1.2, 2);
  });
  it('a metered 18% grey card lands at about 12% of saturation, the standard headroom', () => {
    for (const lux of [10, 1_000, 100_000]) {
      const greyLuminance = (0.18 * lux) / Math.PI; // Lambertian: L = rho E / pi
      const v = greyLuminance * exposureScale(ev100FromIlluminance(lux));
      expect(v).toBeGreaterThan(0.1);
      expect(v).toBeLessThan(0.14);
    }
  });
});

describe('describeEv', () => {
  it('describes EV 15 near Sunny 16 territory', () => {
    expect(describeEv(14.97)).toMatch(/^f\/\d+(\.\d)? · 1\/\d+ s · ISO 100$/);
  });
  it('uses long shutter times at night', () => {
    expect(describeEv(2)).toMatch(/ s · ISO 100$/);
  });
});
