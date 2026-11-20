import {
  BufferAttribute,
  Color,
  DataTexture,
  FloatType,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RedFormat,
  HalfFloatType,
  ShaderMaterial,
  WebGLRenderTarget,
  type WebGLRenderer,
  type Material,
  type WebGLProgramParametersWithUniforms,
  ShaderChunk,
  Vector3,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { Noise2D } from './noise';

export interface TerrainOptions {
  /** Side length, metres. Default 20 000 (a 20 km valley). */
  size?: number;
  /** Grid resolution per side. Default 512 (39 m spacing at 20 km). */
  segments?: number;
  /** Peak relief above the valley floor, metres. Default 1900. */
  height?: number;
  /** Altitude of the snow line, metres above the valley floor. Default 1300. */
  snowLine?: number;
  seed?: number;
}

// Linear albedos (estimates within published ranges, e.g. the ASTER/ECOSTRESS spectral
// library: meadow grass ~0.1-0.2, conifer canopy ~0.03-0.08, granite/gneiss ~0.1-0.3,
// old snow ~0.6-0.9). Labelled estimates, not measured values.
const GRASS = new Color(0.075, 0.115, 0.035);
const DRY = new Color(0.16, 0.15, 0.085);
const FOREST = new Color(0.022, 0.038, 0.018);
const ROCK = new Color(0.13, 0.122, 0.112);
const SNOW = new Color(0.78, 0.8, 0.84);

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Per-pixel detail. Vertex colours give the 50 m pattern; this adds what is smaller than
 * a grid cell: albedo variation at 2-60 m and a bump normal from the same noise. Both fade
 * with distance, before the noise would alias (shimmer) at a few pixels per period.
 */
const DETAIL_GLSL = /* glsl */ `
float tHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float tNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1, 0)), u.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), u.x), u.y);
}
float tDetail(vec2 p) {
  return 0.5 * tNoise(p / 60.0) + 0.3 * tNoise(p / 13.0) + 0.2 * tNoise(p / 2.7);
}
`;
const DETAIL_ALBEDO = /* glsl */ `
float tDist = length(vTerrainPos - cameraPosition);
float tFade = 1.0 - smoothstep(150.0, 1200.0, tDist);
float tD = tDetail(vTerrainPos.xz);
diffuseColor.rgb *= mix(1.0, 0.8 + 0.4 * tD, tFade);
`;
const DETAIL_NORMAL = /* glsl */ `
{
  float tNear = 1.0 - smoothstep(40.0, 600.0, tDist);
  float hgt = (0.6 * tNoise(vTerrainPos.xz / 2.7) + 0.4 * tNoise(vTerrainPos.xz / 0.9)) * 0.35 * tNear;
  vec2 dH = vec2(dFdx(hgt), dFdy(hgt));
  vec3 sp = -vViewPosition;
  vec3 sx = dFdx(sp), sy = dFdy(sp);
  vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
  float det = dot(sx, r1) * faceDirection;
  vec3 grad = sign(det) * (dH.x * r1 + dH.y * r2);
  normal = normalize(abs(det) * normal - grad);
}
`;

/**
 * Terrain self-shadowing. When the sun moves, one pass marches the heightfield from every
 * grid vertex towards the sun (soft shadows after Quilez: penumbra = k * clearance / distance)
 * and stores the result in a visibility texture at grid resolution. Materials then do one
 * texture lookup per pixel. This replaces the shadow map for terrain-scale shadows: a shadow
 * map only covers a box around the camera target and leaves a hard edge on the valley floor at
 * low sun. Objects still cast their own small shadows through the shadow map.
 */
const GRID_UV = /* glsl */ `
uniform float uTerrainSize;
uniform float uTerrainSegments;
vec2 gridUv(vec2 xz) {
  return ((xz / uTerrainSize + 0.5) * uTerrainSegments + 0.5) / (uTerrainSegments + 1.0);
}
`;
const SUN_VIS_PASS = /* glsl */ `
uniform sampler2D uHeightTex;
uniform vec3 uSunDirWorld;
uniform float uTerrainMaxH;
${GRID_UV}
varying vec2 vUv;
void main() {
  float n = uTerrainSegments + 1.0;
  vec2 cellIdx = floor(vUv * n);
  vec2 xz = (cellIdx / uTerrainSegments - 0.5) * uTerrainSize;
  vec3 p = vec3(xz.x, texture(uHeightTex, gridUv(xz)).r + 1.5, xz.y);
  float vis = uSunDirWorld.y < -0.02 ? 0.0 : 1.0;
  float cell = uTerrainSize / uTerrainSegments;
  float t = cell * 0.75;
  for (int i = 0; i < 64; i++) {
    if (vis <= 0.0) break;
    vec3 q = p + uSunDirWorld * t;
    if (q.y > uTerrainMaxH || abs(q.x) > 0.5 * uTerrainSize || abs(q.z) > 0.5 * uTerrainSize) break;
    float dh = q.y - texture(uHeightTex, gridUv(q.xz)).r;
    vis = min(vis, clamp(14.0 * dh / t, 0.0, 1.0));
    t += max(cell * 0.5, t * 0.1);
  }
  gl_FragColor = vec4(vis, 0.0, 0.0, 1.0);
}
`;
/**
 * Sky occlusion bake (see skyView.ts for the maths and its tests). For every grid vertex:
 * find the terrain horizon in 16 azimuths by marching the heightfield (out to 8 km), then
 * integrate cosine-weighted sky over elevation (12 steps) above that horizon, divided by the
 * same integral with the horizon at 0°. Open slopes get 1; floors of gullies and valleys
 * walled by ridges get less. Independent of the sun, so it is baked once.
 */
const SKY_OCC_PASS = /* glsl */ `
uniform sampler2D uHeightTex;
uniform float uTerrainMaxH;
${GRID_UV}
varying vec2 vUv;
float H(vec2 xz) { return texture(uHeightTex, gridUv(xz)).r; }
float skyIntegral(float h, vec3 n, vec2 d) {
  float nh = dot(n.xz, d);
  float dT = (0.5 * PI - h) / 12.0;
  float sum = 0.0;
  for (int j = 0; j < 12; j++) {
    float t = h + (float(j) + 0.5) * dT;
    float ndw = cos(t) * nh + sin(t) * n.y;
    sum += max(ndw, 0.0) * cos(t) * dT;
  }
  return sum;
}
void main() {
  float nn = uTerrainSegments + 1.0;
  vec2 xz = (floor(vUv * nn) / uTerrainSegments - 0.5) * uTerrainSize;
  float cell = uTerrainSize / uTerrainSegments;
  float hs = 0.5 * uTerrainSize;
  float h0 = H(xz);
  vec3 n = normalize(vec3(-(H(xz + vec2(cell, 0.0)) - H(xz - vec2(cell, 0.0))) / (2.0 * cell), 1.0,
                          -(H(xz + vec2(0.0, cell)) - H(xz - vec2(0.0, cell))) / (2.0 * cell)));
  vec3 p = vec3(xz.x, h0 + 1.5, xz.y);
  float actual = 0.0, open = 0.0;
  for (int i = 0; i < 16; i++) {
    float phi = (float(i) + 0.5) * (2.0 * PI / 16.0);
    vec2 d = vec2(cos(phi), sin(phi));
    float tanH = 0.0; // horizons below 0° are clamped to 0° (the env map holds the ground)
    float t = cell;
    for (int k = 0; k < 40; k++) {
      vec2 q = p.xz + d * t;
      if (abs(q.x) > hs || abs(q.y) > hs || t > 8000.0) break;
      tanH = max(tanH, (H(q) - p.y) / t);
      t += max(cell, t * 0.15);
    }
    actual += skyIntegral(atan(tanH), n, d);
    open += skyIntegral(0.0, n, d);
  }
  gl_FragColor = vec4(open > 1e-6 ? min(actual / open, 1.0) : 1.0, 0.0, 0.0, 1.0);
}
`;

/**
 * Blocked sky is not black: the terrain that blocks it reflects light too. Without a full
 * bounce solve we put back a fixed share of the blocked skylight. 0.35 is an estimate (terrain
 * albedo ~0.1-0.3 times its irradiance relative to the sky's, which ranges from well under 1 in
 * shade to above 1 on sunlit slopes), not a measured value.
 */
const TERRAIN_BOUNCE = 0.35;

const SKY_OCC_APPLY = /* glsl */ `
{
  float so = texture(uSkyOccTex, gridUv(vTerrainPos.xz)).r;
  so = mix(1.0, so + (1.0 - so) * ${TERRAIN_BOUNCE.toFixed(2)}, uSkyOccOn);
  reflectedLight.indirectDiffuse *= so;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float soNV = saturate(dot(geometryNormal, geometryViewDir));
    reflectedLight.indirectSpecular *= computeSpecularOcclusion(soNV, so, material.roughness);
  #endif
}
`;

const SUN_VIS_LOOKUP = /* glsl */ `
uniform sampler2D uSkyOccTex;
uniform float uSkyOccOn;
uniform sampler2D uSunVisTex;
${GRID_UV}
float sunVisibility(vec3 p) { return texture(uSunVisTex, gridUv(p.xz)).r; }
`;

/**
 * A procedural alpine valley: a gentle floor along the z axis, ridged mountains rising
 * towards the edges so the tile's border is hidden behind peaks. Colours are chosen per
 * vertex from slope and height (grass on the floor, rock on steep faces, snow above the
 * snow line on slopes gentle enough to hold it). Albedos are within measured ranges:
 * grass ~0.1-0.25, granite ~0.2-0.3, old snow ~0.8 (labelled estimates, not measured here).
 */
export class Terrain extends Mesh<PlaneGeometry, MeshStandardMaterial> {
  readonly size: number;
  /** Uniforms for the terrain shader; the stage keeps uSunDirWorld in step with the sun. */
  readonly terrainUniforms: Record<string, { value: unknown }>;
  private noise: Noise2D;
  private sunVisTarget: WebGLRenderTarget;
  private sunVisQuad: FullScreenQuad;
  private sunVisDirty = true;
  private skyOccTarget: WebGLRenderTarget;
  private skyOccQuad: FullScreenQuad;
  private skyOccBaked = false;
  private relief: number;

  constructor(opts: TerrainOptions = {}) {
    const size = opts.size ?? 20000;
    const segments = opts.segments ?? 512;
    const geo = new PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    super(geo, new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }));
    this.name = 'Terrain';
    this.size = size;
    this.relief = opts.height ?? 1900;
    this.noise = new Noise2D(opts.seed ?? 7);

    const pos = geo.attributes.position as BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.heightAt(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();
    const normals = geo.attributes.normal as BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const snowLine = opts.snowLine ?? 1300;
    const c = new Color();
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getY(i);
      const up = normals.getY(i);
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const jitter = this.noise.fbm(x / 180, z / 180, 3); // breaks up hard bands
      c.copy(GRASS).lerp(DRY, smooth(0.0, 0.35, jitter + h / 2400));
      // Conifer belt: from the valley floor to the tree line (~700 m up), on slopes up to ~40°.
      const trees = smooth(30, 120, h + jitter * 200) * smooth(760, 600, h + jitter * 220) *
        smooth(0.72, 0.8, up) * smooth(-0.05, 0.12, this.noise.fbm(x / 700, z / 700, 3));
      c.lerp(FOREST, trees);
      c.lerp(ROCK, smooth(0.84, 0.7, up + jitter * 0.08));
      const snow = smooth(snowLine - 100, snowLine + 200, h + jitter * 300) * smooth(0.66, 0.82, up);
      c.lerp(SNOW, snow);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new BufferAttribute(colors, 3));
    // Height grid as a texture for the sun-visibility march.
    const n = segments + 1;
    const heights = new Float32Array(n * n);
    let maxH = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const ix = Math.round((pos.getX(i) / size + 0.5) * segments);
      const iz = Math.round((pos.getZ(i) / size + 0.5) * segments);
      const y = pos.getY(i);
      heights[iz * n + ix] = y;
      if (y > maxH) maxH = y;
    }
    const heightTex = new DataTexture(heights, n, n, RedFormat, FloatType);
    heightTex.minFilter = heightTex.magFilter = LinearFilter; // needs OES_texture_float_linear
    heightTex.needsUpdate = true;
    this.sunVisTarget = new WebGLRenderTarget(n, n, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });
    this.terrainUniforms = {
      uHeightTex: { value: heightTex },
      uSunVisTex: { value: this.sunVisTarget.texture },
      uSkyOccTex: { value: null as unknown },
      uSkyOccOn: { value: 1 },
      uSunDirWorld: { value: new Vector3(0, 1, 0) },
      uTerrainSize: { value: size },
      uTerrainSegments: { value: segments },
      uTerrainMaxH: { value: maxH + 1 },
    };
    // A separate target, not sunVisTarget.clone(): clones share the texture's source, and the two
    // bakes then overwrite each other's GL texture.
    this.skyOccTarget = new WebGLRenderTarget(n, n, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });
    this.terrainUniforms.uSkyOccTex.value = this.skyOccTarget.texture;
    this.skyOccQuad = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: this.terrainUniforms,
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: '#define PI 3.14159265358979\n' + SKY_OCC_PASS,
      }),
    );
    this.sunVisQuad = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: this.terrainUniforms,
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: SUN_VIS_PASS,
      }),
    );

    // The terrain shadows itself (sunVisibility); it only receives object shadows from the map.
    this.castShadow = false;
    this.receiveShadow = true;
    this.material.onBeforeCompile = (shader) => {
      this.injectSunVisibility(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + DETAIL_GLSL)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + DETAIL_ALBEDO)
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + DETAIL_NORMAL);
    };
    this.material.customProgramCacheKey = () => 'firstlight-terrain-detail';
  }

  /**
   * Make a lit three.js material (Standard, Physical, Lambert, Phong) respect the terrain's
   * shadow: the sun's direct light is scaled by the same heightfield visibility the terrain
   * uses, so an object in a mountain's shadow is in shadow too. The stage calls this for
   * every material you add. Existing onBeforeCompile hooks are kept.
   */
  shadeWithSun(material: Material): void {
    const tagged = material as Material & { userData: { firstlightSun?: boolean } };
    if (tagged.userData.firstlightSun || material === this.material) return;
    tagged.userData.firstlightSun = true;
    const prev = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
      prev.call(material, shader, renderer);
      this.injectSunVisibility(shader);
    };
    material.customProgramCacheKey = () => prevKey.call(material) + '|firstlight-sun';
    material.needsUpdate = true;
  }

  private injectSunVisibility(shader: WebGLProgramParametersWithUniforms): void {
    if (!shader.fragmentShader.includes('#include <lights_fragment_begin>')) return; // unlit
    Object.assign(shader.uniforms, this.terrainUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainPos;\n' + SUN_VIS_LOOKUP)
      .replace(
        '#include <lights_fragment_begin>',
        'float tSunVis = sunVisibility(vTerrainPos + vec3(0.0, 1.5, 0.0));\n' +
          ShaderChunk.lights_fragment_begin.replace(
            'getDirectionalLightInfo( directionalLight, directLight );',
            'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= tSunVis;',
          ),
      );
    if (shader.fragmentShader.includes('#include <aomap_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        '#include <aomap_fragment>\n' + SKY_OCC_APPLY,
      );
    }
  }

  /** Turn terrain sky occlusion on or off (on by default). */
  setSkyOcclusion(on: boolean): void {
    this.terrainUniforms.uSkyOccOn.value = on ? 1 : 0;
  }

  /** Called by the stage before each frame; recomputes visibility only when the sun moved. */
  setSunDirection(d: Vector3, renderer?: WebGLRenderer): void {
    if (renderer && !this.skyOccBaked) {
      // Sky occlusion doesn't depend on the sun: bake once, on the first frame.
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(this.skyOccTarget);
      this.skyOccQuad.render(renderer);
      renderer.setRenderTarget(prev);
      this.skyOccBaked = true;
    }
    const sd = this.terrainUniforms.uSunDirWorld.value as Vector3;
    if (sd.equals(d) && !this.sunVisDirty) return;
    sd.copy(d);
    if (!renderer) { this.sunVisDirty = true; return; }
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.sunVisTarget);
    this.sunVisQuad.render(renderer);
    renderer.setRenderTarget(prev);
    this.sunVisDirty = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.sunVisTarget.dispose();
    (this.terrainUniforms.uHeightTex.value as DataTexture).dispose();
    this.sunVisQuad.dispose();
    this.skyOccTarget.dispose();
    this.skyOccQuad.dispose();
  }

  /** Ground height (metres) at scene position x, z. Use it to place objects on the ground. */
  heightAt(x: number, z: number): number {
    const half = this.size / 2;
    const n = this.noise;
    // Domain warp: bend the coordinates by a low-frequency noise so ridges meander.
    const wx = x + 900 * n.fbm(x / 5000 + 11, z / 5000, 3);
    const wz = z + 900 * n.fbm(x / 5000, z / 5000 + 23, 3);
    const ridges = n.ridged(wx / 3400, wz / 3400, 8);
    const d = Math.hypot(x / half, (z / half) * 0.62);
    const mask = smooth(0.07, 0.62, d + 0.12 * n.fbm(x / 2500, z / 2500, 2));
    const floor = 35 * n.fbm(x / 900, z / 900, 4);
    return floor + this.relief * mask * (0.25 + 0.75 * ridges) * (0.75 + 0.5 * mask);
  }
}
