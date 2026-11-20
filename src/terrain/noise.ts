/**
 * Seeded 2D gradient noise (Perlin 2002 "improved noise" fade curve) and fractal sums.
 * Deterministic: the same seed gives the same world on every machine.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Noise2D {
  private perm = new Uint8Array(512);
  private gx = new Float32Array(256);
  private gy = new Float32Array(256);

  constructor(seed = 1) {
    const rand = mulberry32(seed);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) {
      const a = rand() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  /** Gradient noise in roughly [-0.7, 0.7]. */
  noise(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    const u = fade(xf);
    const v = fade(yf);
    const g = (ix: number, iy: number, dx: number, dy: number) => {
      const h = this.perm[ix + this.perm[iy]];
      return this.gx[h] * dx + this.gy[h] * dy;
    };
    const n00 = g(X, Y, xf, yf);
    const n10 = g(X + 1, Y, xf - 1, yf);
    const n01 = g(X, Y + 1, xf, yf - 1);
    const n11 = g(X + 1, Y + 1, xf - 1, yf - 1);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return a + v * (b - a);
  }

  /** Fractal Brownian motion: octaves of noise, each twice the frequency and half the amplitude. */
  fbm(x: number, y: number, octaves = 5): number {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(x * f, y * f);
      f *= 2.03;
      amp *= 0.5;
    }
    return sum;
  }

  /**
   * Ridged multifractal (Musgrave, "Texturing & Modeling", ch. 16): 1 - |noise| makes sharp
   * crests; weighting each octave by the previous one keeps valleys smooth and peaks rough.
   * Returns roughly [0, 1].
   */
  ridged(x: number, y: number, octaves = 7): number {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    let weight = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      let n = 1 - Math.abs(this.noise(x * f, y * f) * 1.4);
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 1.8));
      sum += n * amp;
      norm += amp;
      f *= 2.01;
      amp *= 0.5;
    }
    return sum / norm;
  }
}
