import { Atmosphere } from '../atmosphere/Atmosphere';

/** Unit direction for each pixel, from the inverse view-projection matrix. */
const VIEW_RAY = /* glsl */ `
uniform mat4 uInvViewProj;
uniform vec3 uCamPosM;  // camera position, scene metres
uniform vec3 uCamAtm;   // camera position, atmosphere km
vec3 viewDir(vec2 uv) {
  vec4 f = uInvViewProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(f.xyz / f.w - uCamPosM);
}
`;

/**
 * Sky background, drawn first inside the HDR pass so MSAA blends mountain silhouettes
 * against the real sky colour (drawing it later, in the composite, leaves dark fringes).
 */
export const SKY_VERT = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

export const SKY_FRAG = /* glsl */ `
${Atmosphere.glsl}
${VIEW_RAY}
uniform float uSunCosRadius;   // cos of the sun's angular radius
uniform float uSunSolidAngle;  // sr
varying vec2 vNdc;
void main() {
  vec3 dir = viewDir(vNdc * 0.5 + 0.5);
  vec3 col = skyLuminance(uCamAtm, dir);
  float c = dot(dir, uSunDir);
  if (c > uSunCosRadius - 1e-5 && raySphere(uCamAtm, dir, uBottomRadius) < 0.0) {
    // Radiance of the disk is illuminance / solid angle; limb darkening (Neckel & Labs 1994,
    // simplified to a single linear term) and a one-texel soft edge.
    float rr = clamp(acos(min(c, 1.0)) / acos(uSunCosRadius), 0.0, 1.0);
    float limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - rr * rr, 0.0)));
    float edge = smoothstep(1.0, 0.92, rr);
    vec3 T = getTransmittance(length(uCamAtm), dot(dir, normalize(uCamAtm)));
    col += uSunIlluminance * T * limb * edge / uSunSolidAngle;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Sky for the environment cube: no sun disk (the DirectionalLight carries the sun), plus a
 * Lambertian ground term for directions below the horizon so objects get bounce from below. */
export const ENV_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const ENV_FRAG = /* glsl */ `
${Atmosphere.glsl}
uniform vec3 uCamAtm;
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  vec3 col = skyLuminance(uCamAtm, dir);
  if (raySphere(uCamAtm, dir, uBottomRadius) >= 0.0) {
    float r = uBottomRadius;
    float sunCos = uSunDir.y;
    vec3 Tsun = getTransmittance(r, sunCos);
    vec3 skyDown = skyLuminance(vec3(0.0, r + 0.002, 0.0), vec3(0.0, 1.0, 0.0));
    // Sunlight plus a crude sky term (zenith radiance times pi) on flat ground of albedo a.
    col += uGroundAlbedo / PI * (uSunIlluminance * Tsun * max(sunCos, 0.0) + skyDown * PI);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Aerial-perspective volume (Hillaire 2020 §5.4): a 32x32x32 grid over the camera frustum.
 * Each texel holds the light scattered into the view ray between the camera and that slice's
 * distance (rgb) and the ray's mean transmittance (a). Slices are spaced on a square-root
 * curve, so the first kilometres, where detail matters, get most of them.
 */
export const AERIAL_SLICES = 32;
export const AERIAL_KM_PER_SLICE = 2; // covers 64 km
export const AERIAL_FRAG = /* glsl */ `
${Atmosphere.glsl}
${VIEW_RAY}
uniform float uSlice;
varying vec2 vUv;
void main() {
  float s = (uSlice + 0.5) / ${AERIAL_SLICES}.0;
  float km = s * s * ${AERIAL_SLICES}.0 * ${AERIAL_KM_PER_SLICE}.0;
  vec3 dir = viewDir(vUv);
  vec3 T;
  int steps = int(clamp(4.0 + uSlice * 0.6, 4.0, 24.0));
  vec3 L = integrateScattering(uCamAtm, dir, uSunDir, km, steps, T);
  gl_FragColor = vec4(L, dot(T, vec3(1.0 / 3.0)));
}
`;

/** Aerial perspective from the volume, then exposure, tone mapping and sRGB (three's chunks). */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp sampler3D;
${VIEW_RAY}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler3D tAerial;
uniform float uAerialOn;
varying vec2 vUv;
void main() {
  vec3 col = texture(tColor, vUv).rgb;
  float depth = texture(tDepth, vUv).x;
  if (depth < 1.0 && uAerialOn > 0.5) {
    vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    wp /= wp.w;
    float km = length(wp.xyz - uCamPosM) / 1000.0;
    // Inverse of the slice curve. Before the middle of the first slice, fade in linearly
    // (the volume has no slice at distance 0).
    float slice = km / ${AERIAL_KM_PER_SLICE}.0;
    float weight = clamp(slice * 2.0, 0.0, 1.0);
    float w = sqrt(max(slice, 0.5) / ${AERIAL_SLICES}.0);
    vec4 ap = texture(tAerial, vec3(vUv, min(w, 1.0)));
    col = col * mix(1.0, ap.a, weight) + ap.rgb * weight;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
