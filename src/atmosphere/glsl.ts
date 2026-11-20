/**
 * GLSL for Hillaire 2020. All lengths are in km, with the planet centre at the origin
 * and y up. Scene positions (metres) map to atmosphere space as
 *   P_atm = P_scene / 1000 + (0, bottomRadius, 0).
 *
 * Passes (each a full-screen draw into a small half-float texture):
 *   transmittance   256x64   T(r, mu): fraction of light surviving to the top of the atmosphere
 *   multiScattering 32x32    Psi_ms(r, sunCos): all scattering orders beyond the 2nd (paper §5.5)
 *   skyView         192x108  sky luminance around the camera, non-linear near the horizon (§5.3)
 */
import { TRANSMITTANCE_STEPS } from './reference';

export const LUT_SIZES = {
  transmittance: [256, 64],
  multiScattering: [32, 32],
  skyView: [192, 108],
} as const;

export const COMMON = /* glsl */ `
#define PI 3.14159265358979
uniform float uBottomRadius;
uniform float uTopRadius;
uniform vec3 uRayleighScattering;
uniform float uRayleighScaleHeight;
uniform float uMieScattering;
uniform float uMieExtinction;
uniform float uMieScaleHeight;
uniform float uMieG;
uniform vec3 uOzoneAbsorption;
uniform float uOzoneCenter;
uniform float uOzoneHalfWidth;
uniform vec3 uGroundAlbedo;

struct Medium { vec3 scatRay; vec3 scatMie; vec3 ext; };

Medium sampleMedium(float r) {
  float h = max(r - uBottomRadius, 0.0);
  float dR = exp(-h / uRayleighScaleHeight);
  float dM = exp(-h / uMieScaleHeight);
  float dO = max(0.0, 1.0 - abs(h - uOzoneCenter) / uOzoneHalfWidth);
  Medium m;
  m.scatRay = uRayleighScattering * dR;
  m.scatMie = vec3(uMieScattering * dM);
  m.ext = m.scatRay + vec3(uMieExtinction * dM) + uOzoneAbsorption * dO;
  return m;
}

// Nearest non-negative hit of ro + t rd with a sphere of radius R at the origin, or -1.
float raySphere(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  d = sqrt(d);
  float t0 = -b - d;
  float t1 = -b + d;
  if (t0 >= 0.0) return t0;
  if (t1 >= 0.0) return t1;
  return -1.0;
}

float rayleighPhase(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
// Cornette-Shanks, as in Hillaire's reference code.
float miePhase(float g, float c) {
  float k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + c * c) / pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5);
}

vec2 transmittanceUv(float r, float mu) {
  float H = sqrt(uTopRadius * uTopRadius - uBottomRadius * uBottomRadius);
  float rho = sqrt(max(r * r - uBottomRadius * uBottomRadius, 0.0));
  float disc = r * r * (mu * mu - 1.0) + uTopRadius * uTopRadius;
  float d = max(-r * mu + sqrt(max(disc, 0.0)), 0.0);
  float dMin = uTopRadius - r;
  float dMax = rho + H;
  return vec2((d - dMin) / (dMax - dMin), rho / H);
}
`;

/** Shared lookups, for any shader that has the three LUTs bound. */
export const LOOKUPS = /* glsl */ `
uniform sampler2D uTransmittanceLut;
uniform sampler2D uMultiScatLut;
uniform sampler2D uSkyViewLut;
uniform vec3 uSunDir;          // unit, atmosphere space (y up)
uniform vec3 uSunIlluminance;  // relative units, RGB

vec3 getTransmittance(float r, float mu) {
  return texture(uTransmittanceLut, transmittanceUv(r, mu)).rgb;
}
vec3 getMultiScat(float r, float sunCos) {
  vec2 uv = vec2(sunCos * 0.5 + 0.5, (r - uBottomRadius) / (uTopRadius - uBottomRadius));
  uv = clamp(uv, vec2(0.5 / 32.0), vec2(1.0 - 0.5 / 32.0));
  return texture(uMultiScatLut, uv).rgb;
}

// Sky-view LUT mapping (Hillaire's SkyViewLutParamsToUv): sqrt spacing either side of the
// horizon so the horizon band, where colour changes fastest, gets most texels.
vec2 skyViewUv(float r, float viewZenithCos, float lightViewCos, bool hitGround) {
  float vHorizon = sqrt(max(r * r - uBottomRadius * uBottomRadius, 0.0));
  float beta = acos(clamp(vHorizon / r, -1.0, 1.0));
  float zenithHorizonAngle = PI - beta;
  float y;
  if (!hitGround) {
    float c = acos(clamp(viewZenithCos, -1.0, 1.0)) / zenithHorizonAngle;
    y = (1.0 - sqrt(max(1.0 - c, 0.0))) * 0.5;
  } else {
    float c = (acos(clamp(viewZenithCos, -1.0, 1.0)) - zenithHorizonAngle) / beta;
    y = sqrt(max(c, 0.0)) * 0.5 + 0.5;
  }
  float x = sqrt(clamp(-lightViewCos * 0.5 + 0.5, 0.0, 1.0));
  vec2 res = vec2(192.0, 108.0);
  return (vec2(x, y) * (res - 1.0) + 0.5) / res;
}

// Sky luminance seen from atmosphere-space position p along unit direction dir.
vec3 skyLuminance(vec3 p, vec3 dir) {
  float r = length(p);
  vec3 up = p / r;
  float viewZenithCos = dot(dir, up);
  vec3 dirH = dir - up * viewZenithCos;
  vec3 sunH = uSunDir - up * dot(uSunDir, up);
  float lh = length(dirH) * length(sunH);
  float lightViewCos = lh > 1e-6 ? dot(dirH, sunH) / lh : 1.0;
  bool hitGround = raySphere(p, dir, uBottomRadius) >= 0.0;
  return texture(uSkyViewLut, skyViewUv(r, viewZenithCos, lightViewCos, hitGround)).rgb;
}

// Optional terrain shadowing of single scattering ("shadowed in-scattering"). Defined when
// a heightfield is attached (Stage does this for a Terrain): air in a ridge's shadow then
// stops scattering direct sunlight, which removes false haze in shaded valleys and gives
// shafts of light through gaps. Multiple scattering is left as is (an approximation: it is
// sky-like light that also reaches shaded air, though less of it).
#ifdef TERRAIN_SHADOW
uniform sampler2D uHeightTex;
uniform float uTerrainSize;
uniform float uTerrainSegments;
uniform float uTerrainMaxH;
float hfHeight(vec2 xz) {
  vec2 uv = ((xz / uTerrainSize + 0.5) * uTerrainSegments + 0.5) / (uTerrainSegments + 1.0);
  return texture(uHeightTex, uv).r;
}
// Sun visibility of an atmosphere-space point (km), from a march over the heightfield (metres).
float terrainSunVisibility(vec3 pAtm, vec3 sunDir) {
  vec3 p = vec3(pAtm.x, pAtm.y - uBottomRadius, pAtm.z) * 1000.0;
  float hs = 0.5 * uTerrainSize;
  if (p.y > uTerrainMaxH || abs(p.x) > hs || abs(p.z) > hs) return 1.0;
  float cell = uTerrainSize / uTerrainSegments;
  float vis = 1.0;
  float t = cell * 0.5;
  for (int i = 0; i < 28; i++) {
    vec3 q = p + sunDir * t;
    if (q.y > uTerrainMaxH || abs(q.x) > hs || abs(q.z) > hs) break;
    float dh = q.y - hfHeight(q.xz);
    vis = min(vis, clamp(10.0 * dh / t, 0.0, 1.0));
    if (vis <= 0.0) break;
    t += max(cell, t * 0.18);
  }
  return vis;
}
#endif

// Single scattering plus the multiple-scattering term along a ray, up to tLimit km.
// sunDir is passed in (not uSunDir) so the sky-view pass can use its local frame.
// Returns in-scattered luminance; writes the ray's transmittance to tOut.
vec3 integrateScattering(vec3 ro, vec3 rd, vec3 sunDir, float tLimit, int steps, out vec3 tOut) {
  float tBottom = raySphere(ro, rd, uBottomRadius);
  float tTop = raySphere(ro, rd, uTopRadius);
  float tMax = tBottom >= 0.0 ? tBottom : tTop;
  tMax = min(max(tMax, 0.0), tLimit);
  float cosTheta = dot(rd, sunDir);
  float phR = rayleighPhase(cosTheta);
  float phM = miePhase(uMieG, cosTheta);
  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  float fs = float(steps);
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    // Quadratic spacing: dense near the camera, where haze is thickest.
    float a = float(i) / fs, b = float(i + 1) / fs;
    float t0 = tMax * a * a, t1 = tMax * b * b;
    float dt = t1 - t0;
    vec3 P = ro + rd * (0.5 * (t0 + t1));
    float pr = length(P);
    vec3 up = P / pr;
    float sunCos = dot(up, sunDir);
    Medium m = sampleMedium(pr);
    vec3 sampleT = exp(-m.ext * dt);
    float shadow = raySphere(P, sunDir, uBottomRadius) >= 0.0 ? 0.0 : 1.0;
#ifdef TERRAIN_SHADOW
    shadow *= terrainSunVisibility(P, sunDir);
#endif
    vec3 Tsun = getTransmittance(pr, sunCos);
    vec3 phaseScat = m.scatRay * phR + m.scatMie * phM;
    vec3 ms = getMultiScat(pr, sunCos);
    vec3 S = uSunIlluminance * (shadow * Tsun * phaseScat + ms * (m.scatRay + m.scatMie));
    // Analytic integral of S over the step, assuming constant medium (Hillaire §5.1, Eq. 6
    // energy-conserving form from Hillaire 2015).
    vec3 Sint = (S - S * sampleT) / max(m.ext, vec3(1e-7));
    L += T * Sint;
    T *= sampleT;
  }
  tOut = T;
  return L;
}
`;

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const TRANSMITTANCE_FRAG = /* glsl */ `
varying vec2 vUv;
void main() {
  // Invert transmittanceUv (Bruneton 2017).
  float H = sqrt(uTopRadius * uTopRadius - uBottomRadius * uBottomRadius);
  float rho = H * vUv.y;
  float r = sqrt(rho * rho + uBottomRadius * uBottomRadius);
  float dMin = uTopRadius - r;
  float dMax = rho + H;
  float d = dMin + vUv.x * (dMax - dMin);
  float mu = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = vec3(sqrt(1.0 - mu * mu), mu, 0.0);
  float tMax = raySphere(ro, rd, uTopRadius);
  const int STEPS = ${TRANSMITTANCE_STEPS};
  float dt = max(tMax, 0.0) / float(STEPS);
  vec3 tau = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 P = ro + rd * ((float(i) + 0.5) * dt);
    tau += sampleMedium(length(P)).ext * dt;
  }
  gl_FragColor = vec4(exp(-tau), 1.0);
}
`;

/** Paper §5.5: 64 directions; for each, 2nd-order luminance L and f_ms (light transfer as if
 * every scattering event re-emitted 1). Psi_ms = L_2nd / (1 - f_ms), Eq. 9-10. */
export const MULTISCAT_FRAG = /* glsl */ `
uniform sampler2D uTransmittanceLut;
varying vec2 vUv;
vec3 getT(float r, float mu) { return texture(uTransmittanceLut, transmittanceUv(r, mu)).rgb; }
void main() {
  float sunCos = vUv.x * 2.0 - 1.0;
  float r = uBottomRadius + clamp(vUv.y, 0.0, 1.0) * (uTopRadius - uBottomRadius);
  r = clamp(r, uBottomRadius + 0.01, uTopRadius - 0.01);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 sunDir = normalize(vec3(sqrt(max(1.0 - sunCos * sunCos, 0.0)), sunCos, 0.0));
  const int SQRT_N = 8;
  const int STEPS = 20;
  const float isoPhase = 1.0 / (4.0 * PI);
  vec3 Lsum = vec3(0.0);
  vec3 fmsSum = vec3(0.0);
  for (int i = 0; i < SQRT_N; i++) {
    for (int j = 0; j < SQRT_N; j++) {
      float a = (float(i) + 0.5) / float(SQRT_N);
      float b = (float(j) + 0.5) / float(SQRT_N);
      float theta = 2.0 * PI * a;
      float phi = acos(1.0 - 2.0 * b);
      vec3 rd = vec3(cos(theta) * sin(phi), cos(phi), sin(theta) * sin(phi));
      float tBottom = raySphere(ro, rd, uBottomRadius);
      float tTop = raySphere(ro, rd, uTopRadius);
      float tMax = tBottom >= 0.0 ? tBottom : tTop;
      float dt = tMax / float(STEPS);
      vec3 L = vec3(0.0), fms = vec3(0.0), T = vec3(1.0);
      for (int s = 0; s < STEPS; s++) {
        vec3 P = ro + rd * ((float(s) + 0.5) * dt);
        float pr = length(P);
        vec3 up = P / pr;
        Medium m = sampleMedium(pr);
        vec3 sampleT = exp(-m.ext * dt);
        vec3 scat = m.scatRay + m.scatMie;
        float shadow = raySphere(P, sunDir, uBottomRadius) >= 0.0 ? 0.0 : 1.0;
        vec3 S = shadow * getT(pr, dot(up, sunDir)) * scat * isoPhase;
        vec3 ext = max(m.ext, vec3(1e-7));
        L += T * (S - S * sampleT) / ext;
        fms += T * (scat - scat * sampleT) / ext;
        T *= sampleT;
      }
      if (tBottom >= 0.0) {
        vec3 P = ro + rd * tBottom;
        vec3 up = normalize(P);
        float ndl = max(dot(up, sunDir), 0.0);
        L += T * getT(uBottomRadius, dot(up, sunDir)) * ndl * uGroundAlbedo / PI;
      }
      Lsum += L;
      fmsSum += fms;
    }
  }
  float w = 4.0 * PI / float(SQRT_N * SQRT_N) * isoPhase;
  vec3 L2 = Lsum * w;
  vec3 f = fmsSum * w;
  gl_FragColor = vec4(L2 / (1.0 - f), 1.0);
}
`;

export const SKYVIEW_FRAG = /* glsl */ `
uniform float uViewRadius; // camera distance from planet centre, km
varying vec2 vUv;
void main() {
  // Invert skyViewUv (Hillaire's UvToSkyViewLutParams), undoing the half-texel inset.
  vec2 res = vec2(192.0, 108.0);
  vec2 uv = clamp((vUv * res - 0.5) / (res - 1.0), 0.0, 1.0);
  float r = uViewRadius;
  float vHorizon = sqrt(max(r * r - uBottomRadius * uBottomRadius, 0.0));
  float beta = acos(clamp(vHorizon / r, -1.0, 1.0));
  float zenithHorizonAngle = PI - beta;
  float viewZenithCos;
  if (uv.y < 0.5) {
    float c = 1.0 - 2.0 * uv.y;
    c = 1.0 - c * c;
    viewZenithCos = cos(zenithHorizonAngle * c);
  } else {
    float c = uv.y * 2.0 - 1.0;
    viewZenithCos = cos(zenithHorizonAngle + beta * c * c);
  }
  float lightViewCos = -(uv.x * uv.x * 2.0 - 1.0);
  // Local frame: up = +y, sun in the xy plane.
  vec3 ro = vec3(0.0, r, 0.0);
  float sunCos = uSunDir.y;
  vec3 sunLocal = normalize(vec3(sqrt(max(1.0 - sunCos * sunCos, 0.0)), sunCos, 0.0));
  float s = sqrt(max(1.0 - viewZenithCos * viewZenithCos, 0.0));
  vec3 rd = vec3(s * lightViewCos, viewZenithCos, s * sqrt(max(1.0 - lightViewCos * lightViewCos, 0.0)));
  vec3 T;
  vec3 L = integrateScattering(ro, rd, sunLocal, 1e9, 32, T);
  gl_FragColor = vec4(L, 1.0);
}
`;

/**
 * Sky irradiance on a horizontal surface at the camera (what a flat light meter pointed up
 * reads, minus the direct sun): E = integral of L cos(theta) over the upper hemisphere.
 * Cosine-weighted directions make that pi times the mean radiance. 16 x 8 = 128 samples of
 * the sky-view LUT; the LUT is smooth, so this is plenty.
 */
export const SKY_IRRADIANCE_FRAG = /* glsl */ `
uniform float uViewRadius;
void main() {
  vec3 p = vec3(0.0, uViewRadius, 0.0);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    for (int j = 0; j < 8; j++) {
      float u1 = (float(j) + 0.5) / 8.0;
      float phi = 2.0 * PI * (float(i) + 0.5) / 16.0;
      float sinT = sqrt(u1);
      vec3 dir = vec3(sinT * cos(phi), sqrt(1.0 - u1), sinT * sin(phi));
      sum += skyLuminance(p, dir);
    }
  }
  gl_FragColor = vec4(PI * sum / 128.0, 1.0);
}
`;
