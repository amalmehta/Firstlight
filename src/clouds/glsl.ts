/**
 * GLSL for volumetric clouds. Lengths in the march are km in atmosphere space (planet centre
 * at the origin, y up), like the atmosphere code; the shadow map works in scene metres.
 *
 * Textures (generated once on the GPU, all tileable):
 *   shape   128³ R8  Perlin-Worley base shape (Schneider 2015; single channel as in Frostbite 2016 §5.4)
 *   detail   32³ R8  Worley fbm that erodes the edges into billows
 *   weather 512² RG8 where clouds may form (r) and how tall they grow (g), repeating every 64 km
 */
import { Atmosphere } from '../atmosphere/Atmosphere';

export const SHAPE_SIZE = 128;
export const DETAIL_SIZE = 32;
export const WEATHER_SIZE = 512;
/** Repeat lengths of the three textures, km. */
export const SHAPE_KM = 9;
export const DETAIL_KM = 1.4;
export const WEATHER_KM = 64;

/** Hash and tileable noise. Integer hash: pcg3d (Jarzynski & Olano 2020, JCGT 9(3)). */
const NOISE = /* glsl */ `
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
uniform float uSeed;
// Always 1. Loop bounds are multiplied by it so the GPU compiler cannot unroll them: unrolled,
// these shaders took 0.25-1.4 s each to compile (measured), freezing the page.
uniform int uOne;
vec3 hash33(ivec3 c) {
  return vec3(pcg3d(uvec3(c) + uvec3(uint(uSeed)) * uvec3(1u, 7919u, 104729u))) * (1.0 / 4294967295.0);
}
ivec3 wrap(ivec3 c, int P) { return ((c % P) + P) % P; }

// Gradient noise with period P (in lattice cells), roughly in [-1, 1].
float gradNoise(vec3 x, int P) {
  vec3 i = floor(x);
  vec3 f = x - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec3 b = ivec3(i);
  float n[8];
  for (int k = 0; k < 8 * uOne; k++) {
    ivec3 o = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    vec3 g = normalize(hash33(wrap(b + o, P)) * 2.0 - 1.0 + 1e-4);
    n[k] = dot(g, f - vec3(o));
  }
  return mix(mix(mix(n[0], n[1], u.x), mix(n[2], n[3], u.x), u.y),
             mix(mix(n[4], n[5], u.x), mix(n[6], n[7], u.x), u.y), u.z) * 1.15;
}

// 1 - (distance to the nearest feature point), one point per cell, period P: billowy cells.
float worley(vec3 x, int P) {
  vec3 i = floor(x);
  vec3 f = x - i;
  ivec3 b = ivec3(i);
  float d = 1e9;
  for (int z = -uOne; z <= uOne; z++)
  for (int y = -uOne; y <= uOne; y++)
  for (int xx = -uOne; xx <= uOne; xx++) {
    ivec3 o = ivec3(xx, y, z);
    vec3 fp = vec3(o) + hash33(wrap(b + o, P));
    vec3 dv = fp - f;
    d = min(d, dot(dv, dv));
  }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
`;

/** One z-slice of the 128³ shape texture. */
export const SHAPE_FRAG = /* glsl */ `
${NOISE}
uniform float uSlice;
varying vec2 vUv;
void main() {
  vec3 p = vec3(vUv, (uSlice + 0.5) / ${SHAPE_SIZE}.0);
  float pf = 0.0, amp = 1.0, tot = 0.0;
  for (int i = 0; i < 4 * uOne; i++) {
    int P = 4 << i;
    pf += amp * gradNoise(p * float(P), P);
    tot += amp;
    amp *= 0.5;
  }
  pf = clamp(pf / tot * 0.7 + 0.5, 0.0, 1.0);
  float w4 = worley(p * 4.0, 4), w8 = worley(p * 8.0, 8), w16 = worley(p * 16.0, 16), w32 = worley(p * 32.0, 32);
  float wA = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;
  float wB = w8 * 0.625 + w16 * 0.25 + w32 * 0.125;
  float perlinWorley = remap(pf, 0.0, 1.0, wA, 1.0);
  float shape = remap(perlinWorley, wB - 1.0, 1.0, 0.0, 1.0);
  // Stretch to 0..1: measured 1st-99th percentiles of the raw value were 0.71-0.92.
  shape = clamp((shape - 0.70) / 0.23, 0.0, 1.0);
  gl_FragColor = vec4(shape, 0.0, 0.0, 1.0);
}
`;

/** One z-slice of the 32³ detail texture. */
export const DETAIL_FRAG = /* glsl */ `
${NOISE}
uniform float uSlice;
varying vec2 vUv;
void main() {
  vec3 p = vec3(vUv, (uSlice + 0.5) / ${DETAIL_SIZE}.0);
  float d = worley(p * 2.0, 2) * 0.625 + worley(p * 4.0, 4) * 0.25 + worley(p * 8.0, 8) * 0.125;
  d = clamp((d - 0.27) / 0.42, 0.0, 1.0); // measured 1st-99th percentiles: 0.27-0.69
  gl_FragColor = vec4(d, 0.0, 0.0, 1.0);
}
`;

/** Weather map: r = where clouds may form (thresholded by coverage at run time), g = height type. */
export const WEATHER_FRAG = /* glsl */ `
${NOISE}
varying vec2 vUv;
void main() {
  vec3 p = vec3(vUv, 0.37);
  float f = 0.0, amp = 1.0, tot = 0.0;
  for (int i = 0; i < 5 * uOne; i++) {
    int P = 8 << i;
    f += amp * gradNoise(p * float(P), P);
    tot += amp;
    amp *= 0.55;
  }
  f = f / tot * 0.8 + 0.5;
  // Clumps: cumulus fields gather in cells (convective cells, a few km across).
  float cells = worley(p * 24.0, 24);
  // Stretched to spread roughly evenly over 0..1 (measured: the raw mix spans ~0.15-0.7), so
  // the coverage threshold maps to about the same fraction of sky.
  float presence = clamp((0.55 * f + 0.6 * cells - 0.12 - 0.15) / 0.55, 0.0, 1.0);
  float type = clamp(gradNoise(p * 4.0 + 7.3, 4) * 0.9 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(presence, type, 0.0, 1.0);
}
`;

/** Density of the cloud layer at an atmosphere-space point (km). Returns extinction, 1/km. */
export const CLOUD_DENSITY = /* glsl */ `
precision highp sampler3D;
uniform sampler3D uShapeTex;
uniform sampler3D uDetailTex;
uniform sampler2D uWeatherTex;
uniform float uCloudBottom;  // km above sea level
uniform float uCloudTop;
uniform float uCoverage;     // 0..1
uniform float uExtinction;   // 1/km at full density
uniform vec3 uCloudOffset;   // km (wind)
uniform int uLoopOne;        // always 1: keeps loops from being unrolled (compile time)

float remapc(float v, float a, float b, float c, float d) {
  return clamp(c + (v - a) / (b - a) * (d - c), min(c, d), max(c, d));
}
// Vertical profile, mirrors heightProfile() in reference.ts.
float heightProfile(float h, float type) {
  float top = 0.45 + 0.55 * type;
  return smoothstep(0.0, 0.08, h) * smoothstep(top, top * 0.55, h);
}
// h: height fraction in the layer, written for the caller.
float cloudDensity(vec3 p, bool detail, out float h) {
  float r = length(p);
  float alt = r - uBottomRadius;
  h = (alt - uCloudBottom) / (uCloudTop - uCloudBottom);
  if (h <= 0.0 || h >= 1.0) return 0.0;
  vec3 q = vec3(p.x, alt, p.z) + uCloudOffset;
  vec2 w = texture(uWeatherTex, q.xz / ${WEATHER_KM}.0).rg;
  // Local coverage: the fraction of the map above the threshold grows with uCoverage.
  float lc = remapc(w.r, 1.0 - uCoverage, 1.0 - uCoverage + 0.15, 0.0, 1.0);
  if (lc <= 0.0) return 0.0;
  // Thinner coverage near a cell's edge also means a lower top: domes, not cut columns.
  float prof = heightProfile(h / mix(0.35, 1.0, lc), w.g);
  if (prof <= 0.0) return 0.0;
  float s = texture(uShapeTex, q / ${SHAPE_KM}.0).r;
  // Coverage lowers the noise threshold, but never to zero, so even the densest cells keep
  // the noise's cauliflower outline instead of filling the cell (Schneider 2015 remap).
  float base = remapc(s * prof, 1.0 - 0.6 * lc, 1.0, 0.0, 1.0);
  if (base <= 0.0) return 0.0;
  if (detail) {
    float d = texture(uDetailTex, q / ${DETAIL_KM}).r;
    // Billows on top, wisps underneath (Schneider 2015).
    float dm = mix(1.0 - d, d, clamp(h * 4.0, 0.0, 1.0));
    base = remapc(base, dm * 0.5, 1.0, 0.0, 1.0);
  }
  return base * uExtinction;
}

// Entry and exit distances of the ray through the cloud shell, or (-1, -1).
vec2 sphereHits(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float d = b * b - c;
  if (d < 0.0) return vec2(-1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
vec2 cloudSegment(vec3 ro, vec3 rd) {
  float rb = uBottomRadius + uCloudBottom;
  float rt = uBottomRadius + uCloudTop;
  float r = length(ro);
  vec2 top = sphereHits(ro, rd, rt);
  vec2 bot = sphereHits(ro, rd, rb);
  if (r < rb) {
    if (raySphere(ro, rd, uBottomRadius) >= 0.0) return vec2(-1.0); // looking at the ground
    return vec2(bot.y, top.y);
  }
  if (r < rt) return vec2(0.0, bot.x > 0.0 ? bot.x : top.y);
  if (top.x < 0.0) return vec2(-1.0);
  return vec2(top.x, bot.x > 0.0 ? bot.x : top.y);
}
`;

/** The cloud phase function (Jendersie & d'Eon 2023); mirrors cloudPhase() in reference.ts. */
const PHASE = /* glsl */ `
uniform vec4 uPhase; // gHG, gD, alpha, wD
float hgPhase(float g, float c) {
  return (1.0 - g * g) / (4.0 * PI * pow(max(1.0 + g * g - 2.0 * g * c, 1e-6), 1.5));
}
float drainePhase(float g, float a, float c) {
  return (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * c, 1e-6), 1.5) *
    (1.0 + a * c * c) / (1.0 + a * (1.0 + 2.0 * g * g) / 3.0) / (4.0 * PI);
}
float cloudPhase(float c) {
  return (1.0 - uPhase.w) * hgPhase(uPhase.x, c) + uPhase.w * drainePhase(uPhase.y, uPhase.z, c);
}
`;

const VIEW_RAY = /* glsl */ `
uniform mat4 uInvViewProj;
uniform vec3 uCamPosM;
uniform vec3 uCamAtm;
`;

/**
 * The cloud march, at reduced resolution. Each texel follows the view ray of the full-resolution
 * pixel at twice its coordinate (so the composite can compare depths exactly), stops at the
 * scene depth, and writes (in-scattered light with aerial perspective, transmittance).
 */
export const MARCH_FRAG = /* glsl */ `
precision highp sampler3D;
${Atmosphere.glsl}
${VIEW_RAY}
${CLOUD_DENSITY}
${PHASE}
uniform sampler2D tDepth;
uniform sampler3D tAerial;
uniform vec2 uFullSize;
uniform float uScale;      // full-res pixels per cloud texel
uniform float uSteps;
uniform float uAerialSlices;
uniform float uAerialKmPerSlice;
uniform vec4 uOctaves;     // count, a, b, c
uniform float uFrame;

// Interleaved gradient noise (Jimenez 2014): a cheap, well-spread per-pixel jitter.
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  ivec2 full = ivec2(floor(gl_FragCoord.xy)) * int(uScale);
  full = min(full, ivec2(uFullSize) - 1);
  vec2 uv = (vec2(full) + 0.5) / uFullSize;
  vec4 f = uInvViewProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(f.xyz / f.w - uCamPosM);
  vec3 ro = uCamAtm;

  vec2 seg = cloudSegment(ro, rd);
  float depth = texelFetch(tDepth, full, 0).x;
  float sceneKm = 1e9;
  if (depth < 1.0) {
    vec4 wp = uInvViewProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    sceneKm = length(wp.xyz / wp.w - uCamPosM) / 1000.0;
  }
  seg.y = min(seg.y, sceneKm);
  seg.y = min(seg.y, seg.x + 40.0);  // at most 40 km of cloud layer per ray
  if (seg.x < 0.0 || seg.y <= seg.x || seg.x > 160.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float mu = dot(rd, uSunDir);
  float phase = cloudPhase(mu);
  // Ambient (sky) light: mean radiance of the upper sky, from the sky-view table, and
  // light bounced off sunlit ground below. Treated as isotropic. An estimate, see docs.
  vec3 skyUp = skyLuminance(ro, vec3(0.0, 1.0, 0.0));
  for (int k = 0; k < 4; k++) {
    float a = float(k) * 1.5707963;
    skyUp += skyLuminance(ro, vec3(cos(a) * 0.82, 0.57, sin(a) * 0.82));
  }
  skyUp /= 5.0;
  float sunUp = uSunDir.y;
  vec3 groundL = uGroundAlbedo / PI *
    (uSunIlluminance * getTransmittance(uBottomRadius, sunUp) * max(sunUp, 0.0) + skyUp * PI);

  // Steps grow with distance (50 m near, up to 250 m far: a far cloud covers few pixels),
  // and triple in empty air; on finding cloud, step back and resume at the fine size.
  float t = seg.x;
  float jitter = ign(gl_FragCoord.xy + uFrame * 5.588238);
  vec3 L = vec3(0.0);
  float T = 1.0;
  float tSum = 0.0, wSum = 0.0;
  int fine = 0; // fine steps left after touching cloud
  t += jitter * clamp(t * 0.004, 0.05, 0.25);
  int maxSteps = int(uSteps) * uLoopOne;
  for (int i = 0; i < maxSteps; i++) {
    if (t > seg.y) break;
    // Each step's length varies ±25% (golden-ratio sequence from the pixel's jitter), which
    // turns banding on sharp cloud tops into fine noise that the upsampling smooths.
    float dt = clamp(t * 0.004, 0.05, 0.25) * (0.75 + 0.5 * fract(jitter + float(i) * 0.618034));
    vec3 p = ro + rd * t;
    float h;
    float sig = cloudDensity(p, true, h);
    if (sig <= 1e-3) {
      t += fine > 0 ? dt : dt * 3.0;
      fine = max(fine - 1, 0);
      continue;
    }
    if (fine == 0) {
      // Touched cloud after coarse steps: back up over the stretch we may have skipped,
      // then walk it at the fine step.
      fine = 4;
      t = max(seg.x, t - dt * 2.0);
      continue;
    }
    fine = 4;
    {
      // Optical depth towards the sun: 5 steps of doubling length (60 m … 1.9 km), shape only.
      float tau = 0.0;
      float ls = 0.06;
      float lt = 0.0;
      for (int j = 0; j < 5 * uLoopOne; j++) {
        float hh;
        tau += cloudDensity(p + uSunDir * (lt + 0.5 * ls), false, hh) * ls;
        lt += ls;
        ls *= 2.0;
      }
      float pr = length(p);
      vec3 sunAtP = uSunIlluminance * getTransmittance(pr, dot(p / pr, uSunDir));
      if (raySphere(p, uSunDir, uBottomRadius) >= 0.0) sunAtP = vec3(0.0);
      float oct = 0.0;
      float sa = 1.0, sb = 1.0, sc = 1.0;
      int nOct = int(uOctaves.x) * uLoopOne;
      for (int k = 0; k < nOct; k++) {
        float ph = 1.0 / (4.0 * PI) + (phase - 1.0 / (4.0 * PI)) * sc;
        oct += sa * exp(-tau * sb) * ph;
        sa *= uOctaves.y; sb *= uOctaves.z; sc *= uOctaves.w;
      }
      vec3 amb = skyUp * (0.35 + 0.65 * h) + groundL * 0.5 * (1.0 - h);
      // Single-scattering albedo of cloud droplets in the visible is ~1 (σs = σt).
      vec3 S = sig * (sunAtP * oct + amb);
      float stepT = exp(-sig * dt);
      L += T * (S - S * stepT) / sig;
      float nT = T * stepT;
      tSum += t * (T - nT);
      wSum += T - nT;
      T = nT;
      if (T < 0.01) break;
    }
    t += dt;
  }
  if (wSum <= 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Aerial perspective at the cloud's opacity-weighted distance. Within the haze volume
  // (64 km) use it; beyond, transmittance from the table and in-scatter approximated as
  // sky × (1 - T) (an approximation: it assumes the haze in front looks like the sky behind).
  float km = tSum / wSum;
  vec3 apL;
  vec3 apT;
  float volKm = uAerialSlices * uAerialKmPerSlice;
  vec3 pc = ro + rd * km;
  float rc = length(pc);
  float rr = length(ro);
  vec3 tFar = clamp(getTransmittance(rr, dot(rd, ro / rr)) /
    max(getTransmittance(rc, dot(rd, pc / rc)), vec3(1e-6)), 0.0, 1.0);
  vec3 lFar = skyLuminance(ro, rd) * (1.0 - tFar);
  if (km < volKm) {
    float slice = km / uAerialKmPerSlice;
    vec4 ap = texture(tAerial, vec3(uv, sqrt(max(slice, 0.5) / uAerialSlices)));
    float wgt = clamp(slice * 2.0, 0.0, 1.0);
    vec3 nearL = ap.rgb * wgt;
    vec3 nearT = vec3(mix(1.0, ap.a, wgt));
    float b = smoothstep(volKm * 0.75, volKm, km);
    apL = mix(nearL, lFar, b);
    apT = mix(nearT, tFar, b);
  } else {
    apL = lFar;
    apT = tFar;
  }
  vec3 col = apT * L + apL * (1.0 - T);
  gl_FragColor = vec4(min(col, vec3(6.0e4)), T);
}
`;

/**
 * Cloud shadow map: for each texel of a square on the plane y = 0 (scene metres), the
 * transmittance of sunlight through the cloud layer along the sun direction.
 */
export const SHADOW_FRAG = /* glsl */ `
precision highp sampler3D;
${Atmosphere.glsl}
${CLOUD_DENSITY}
uniform vec2 uCenter;
uniform float uExtent;
varying vec2 vUv;
void main() {
  vec2 xz = uCenter + (vUv - 0.5) * uExtent;
  vec3 ro = vec3(xz.x / 1000.0, uBottomRadius + 0.001, xz.y / 1000.0);
  vec3 rd = uSunDir;
  if (rd.y < 0.02) { gl_FragColor = vec4(1.0); return; }
  vec2 b = sphereHits(ro, rd, uBottomRadius + uCloudBottom);
  vec2 t = sphereHits(ro, rd, uBottomRadius + uCloudTop);
  float t0 = b.y, t1 = t.y;
  // About 120 m per step however long the slant path is (16-200 steps): at a low sun the
  // lookup magnifies this map along slopes, so coarse steps showed up as stripes.
  int n = int(clamp(ceil((t1 - t0) / 0.12), 16.0, 200.0)) * uLoopOne;
  float dt = (t1 - t0) / float(n);
  float tau = 0.0;
  for (int i = 0; i < n; i++) {
    float h;
    tau += cloudDensity(ro + rd * (t0 + (float(i) + 0.5) * dt), false, h) * dt;
  }
  // The direct beam only (Beer-Lambert). Light scattered forward through the cloud onto the
  // ground is not added, so shadows under thin cloud are somewhat too dark.
  float T = exp(-tau);
  gl_FragColor = vec4(vec3(min(T, 1.0)), 1.0);
}
`;
