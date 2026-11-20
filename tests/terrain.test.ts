import { describe, expect, it } from 'vitest';
import { Noise2D } from '../src/terrain/noise';
import { Terrain } from '../src/terrain/Terrain';

describe('Noise2D', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = new Noise2D(3), b = new Noise2D(3), c = new Noise2D(4);
    expect(a.fbm(12.3, -4.5)).toBe(b.fbm(12.3, -4.5));
    expect(a.fbm(12.3, -4.5)).not.toBe(c.fbm(12.3, -4.5));
  });
  it('ridged noise stays within [0, 1]', () => {
    const n = new Noise2D(9);
    for (let i = 0; i < 2000; i++) {
      const v = n.ridged(i * 0.137, i * -0.291);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('Terrain', () => {
  const t = new Terrain({ seed: 7, segments: 64 });
  it('has a low valley floor and high rim', () => {
    expect(Math.abs(t.heightAt(0, 0))).toBeLessThan(80);
    const rim = Math.max(t.heightAt(9000, 0), t.heightAt(-9000, 0), t.heightAt(0, 9500), t.heightAt(0, -9500));
    expect(rim).toBeGreaterThan(600);
  });
  it('mesh vertices match heightAt (to 1 cm; positions are 32-bit floats)', () => {
    const pos = t.geometry.attributes.position;
    for (const i of [0, 100, 2000, pos.count - 1]) {
      expect(pos.getY(i)).toBeCloseTo(t.heightAt(pos.getX(i), pos.getZ(i)), 2);
    }
  });
  it('heights are finite everywhere', () => {
    const pos = t.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) expect(Number.isFinite(pos.getY(i))).toBe(true);
  });
});
