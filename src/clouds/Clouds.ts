import {
  DataUtils,
  HalfFloatType,
  LinearFilter,
  Material,
  RedFormat,
  RepeatWrapping,
  RGFormat,
  ShaderChunk,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGL3DRenderTarget,
  WebGLRenderTarget,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { FULLSCREEN_VERT, CLOUD_SHADOW_LOOKUP } from '../atmosphere/glsl';
import { gpuIdle } from '../stage/yieldTask';
import {
  DETAIL_FRAG,
  DETAIL_SIZE,
  MARCH_FRAG,
  SHADOW_FRAG,
  SHAPE_FRAG,
  SHAPE_SIZE,
  WEATHER_FRAG,
  WEATHER_SIZE,
} from './glsl';
import { DROPLET_DIAMETER_UM, OCTAVES, miePhaseParams } from './reference';

export interface CloudOptions {
  /** Fraction of the sky with cloud, 0 (clear) to 1 (overcast). Default 0.35. */
  coverage?: number;
  /** Base and top of the cloud layer, metres above sea level (y = 0). Default [2600, 4600]. */
  altitude?: [number, number];
  /** Extinction at full density, per metre. Default 0.05 (cumulus: about 0.02-0.15; estimate). */
  extinction?: number;
  /** Mean droplet diameter, µm (5-50); sets the phase function. Default 20. */
  dropletDiameter?: number;
  /** Most march steps per ray (empty air is skipped in larger steps). Default 128. */
  steps?: number;
  /**
   * Clouds render at 1/scale resolution per axis. Default 'auto': the smallest whole scale
   * (at least 2) that keeps the cloud buffer under about 0.2 megapixels, so the cost stays
   * near 3 ms whatever the canvas size (measured, see VIZ-LOG.md).
   */
  scale?: number | 'auto';
  /** Shadow the ground, objects and haze with the clouds. Default true. */
  shadows?: boolean;
  /**
   * Shift the cloud field, metres [x, z]. Moves clouds (and their shadows) without changing
   * them; animate it for wind. Default [3000, 0]: with the default seed this leaves the scene
   * origin in sunlight at an afternoon sun (probed), so a first scene isn't in a cloud's shadow.
   */
  offset?: [number, number];
  seed?: number;
}

const SHADOW_SIZE = 512;
/** Cloud-buffer pixel budget for scale 'auto'. */
const CLOUD_PIXEL_BUDGET = 200_000;
/** The cloud shadow map covers this square (metres) around the camera target. */
const SHADOW_EXTENT = 48000;

type Uniforms = Record<string, { value: unknown }>;

/**
 * Volumetric clouds: a cumulus layer marched per pixel at reduced resolution, lit by the sun
 * through the atmosphere (transmittance table) and by the sky (sky-view table), with
 * multiple-scattering octaves, aerial perspective, and a shadow map for the ground and haze.
 * The Stage owns one; use stage.setClouds() to change it.
 */
export class Clouds {
  /** Uniforms shared with lit materials and the haze pass (the shadow lookup). */
  readonly shadowUniforms: Uniforms;
  readonly marchMat: ShaderMaterial;
  private shadowMat: ShaderMaterial;
  private genMats: ShaderMaterial[];
  private shape = new WebGL3DRenderTarget(SHAPE_SIZE, SHAPE_SIZE, SHAPE_SIZE, { format: RedFormat, type: UnsignedByteType, depthBuffer: false });
  private detail = new WebGL3DRenderTarget(DETAIL_SIZE, DETAIL_SIZE, DETAIL_SIZE, { format: RedFormat, type: UnsignedByteType, depthBuffer: false });
  private weather = new WebGLRenderTarget(WEATHER_SIZE, WEATHER_SIZE, { format: RGFormat, type: UnsignedByteType, depthBuffer: false });
  // RGBA (not R) so a texel can be read back portably for the exposure meter.
  private shadowRT = new WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, { type: HalfFloatType, depthBuffer: false });
  private probeBuf = new Uint16Array(4);
  /** Increments each time the shadow map is redrawn. */
  shadowVersion = 0;
  readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  private quad = new FullScreenQuad();
  private shadowKey = '';
  private generated = false;
  private opts: Required<Omit<CloudOptions, 'altitude'>> & { altitude: [number, number] };
  private effScale = 2;

  constructor(atmosphereUniforms: Uniforms, viewUniforms: Uniforms, opts: CloudOptions = {}) {
    this.opts = {
      coverage: opts.coverage ?? 0.35,
      altitude: opts.altitude ?? [2600, 4600],
      extinction: opts.extinction ?? 0.05,
      dropletDiameter: opts.dropletDiameter ?? DROPLET_DIAMETER_UM,
      steps: opts.steps ?? 128,
      scale: opts.scale ?? 'auto',
      shadows: opts.shadows ?? true,
      seed: opts.seed ?? 3,
      offset: opts.offset ?? [3000, 0],
    };
    for (const rt of [this.shape, this.detail]) {
      Object.assign(rt.texture, { wrapS: RepeatWrapping, wrapT: RepeatWrapping, wrapR: RepeatWrapping, minFilter: LinearFilter, magFilter: LinearFilter });
    }
    Object.assign(this.weather.texture, { wrapS: RepeatWrapping, wrapT: RepeatWrapping, minFilter: LinearFilter, magFilter: LinearFilter });
    this.shadowRT.texture.minFilter = LinearFilter;
    this.shadowRT.texture.magFilter = LinearFilter;
    this.target.texture.minFilter = LinearFilter;
    this.target.texture.magFilter = LinearFilter;

    const ph = miePhaseParams(this.opts.dropletDiameter);
    const density: Uniforms = {
      uShapeTex: { value: this.shape.texture },
      uDetailTex: { value: this.detail.texture },
      uWeatherTex: { value: this.weather.texture },
      uCloudBottom: { value: 0 },
      uCloudTop: { value: 0 },
      uCoverage: { value: 0 },
      uExtinction: { value: 0 },
      uCloudOffset: { value: new Vector3() },
      uLoopOne: { value: 1 },
    };
    this.shadowUniforms = {
      uCloudShadowTex: { value: this.shadowRT.texture },
      uCloudShadowCenter: { value: new Vector2() },
      uCloudShadowExtent: { value: SHADOW_EXTENT },
      uCloudSunDir: atmosphereUniforms.uSunDir,
      uCloudShadowOn: { value: 0 },
      uCloudTopM: { value: 0 },
    };
    this.marchMat = new ShaderMaterial({
      uniforms: {
        ...atmosphereUniforms,
        ...viewUniforms,
        ...density,
        uPhase: { value: new Vector4(ph.gHG, ph.gD, ph.alpha, ph.wD) },
        uOctaves: { value: new Vector4(OCTAVES.count, OCTAVES.a, OCTAVES.b, OCTAVES.c) },
        tDepth: { value: null },
        tAerial: { value: null },
        uFullSize: { value: new Vector2(1, 1) },
        uScale: { value: 2 },
        uSteps: { value: this.opts.steps },
        uAerialSlices: { value: 32 },
        uAerialKmPerSlice: { value: 2 },
        uFrame: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: MARCH_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.shadowMat = new ShaderMaterial({
      uniforms: { ...atmosphereUniforms, ...density, uCenter: this.shadowUniforms.uCloudShadowCenter, uExtent: { value: SHADOW_EXTENT } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SHADOW_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const gen = (frag: string) =>
      new ShaderMaterial({
        uniforms: { uSlice: { value: 0 }, uSeed: { value: this.opts.seed }, uOne: { value: 1 } },
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: frag,
        depthTest: false,
        depthWrite: false,
      });
    this.genMats = [gen(SHAPE_FRAG), gen(DETAIL_FRAG), gen(WEATHER_FRAG)];
    this.apply();
  }

  /** Every pass material, for compiling ahead of the first frame. */
  get materials(): Material[] {
    return [this.marchMat, this.shadowMat, ...this.genMats];
  }

  /** Full-resolution pixels per cloud texel, per axis. */
  get scale(): number {
    return this.effScale;
  }

  get coverage(): number {
    return this.opts.coverage;
  }

  /** True when there is anything to draw. */
  get visible(): boolean {
    return this.generated && this.opts.coverage > 0;
  }

  /** Change options at run time (coverage, altitude, extinction, shadows, steps). */
  set(opts: CloudOptions): void {
    Object.assign(this.opts, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)));
    if (opts.dropletDiameter !== undefined) {
      const ph = miePhaseParams(opts.dropletDiameter);
      (this.marchMat.uniforms.uPhase.value as Vector4).set(ph.gHG, ph.gD, ph.alpha, ph.wD);
    }
    if (opts.scale !== undefined) {
      const full = this.marchMat.uniforms.uFullSize.value as Vector2;
      this.setSize(full.x, full.y);
    }
    this.apply();
  }

  private apply(): void {
    const u = this.marchMat.uniforms;
    u.uCloudBottom.value = this.opts.altitude[0] / 1000;
    u.uCloudTop.value = this.opts.altitude[1] / 1000;
    u.uCoverage.value = Math.min(1, Math.max(0, this.opts.coverage));
    u.uExtinction.value = this.opts.extinction * 1000; // per km
    u.uSteps.value = this.opts.steps;
    (u.uCloudOffset.value as Vector3).set(-this.opts.offset[0] / 1000, 0, -this.opts.offset[1] / 1000);
    this.shadowUniforms.uCloudTopM.value = this.opts.altitude[1];
    this.shadowUniforms.uCloudShadowOn.value = this.opts.shadows && this.visible ? 1 : 0;
    this.shadowKey = '';
  }

  /**
   * Generate the noise textures on the GPU (once). Yields between batches of slices so the
   * page stays responsive (each 3D slice is a full-screen draw of a fairly heavy shader).
   */
  async generate(renderer: WebGLRenderer): Promise<void> {
    if (this.generated) return;
    const prev = renderer.getRenderTarget();
    const slices = async (mat: ShaderMaterial, rt: WebGL3DRenderTarget, n: number, batch: number) => {
      this.quad.material = mat;
      for (let z = 0; z < n; z++) {
        mat.uniforms.uSlice.value = z;
        renderer.setRenderTarget(rt, z);
        this.quad.render(renderer);
        if ((z + 1) % batch === 0) await gpuIdle(renderer.getContext() as WebGL2RenderingContext);
      }
    };
    // Batches of ~10 ms of GPU work each (measured: 2-3 ms per shape slice), each waited for.
    await slices(this.genMats[0], this.shape, SHAPE_SIZE, 4);
    await slices(this.genMats[1], this.detail, DETAIL_SIZE, 32);
    this.quad.material = this.genMats[2];
    renderer.setRenderTarget(this.weather);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
    await gpuIdle(renderer.getContext() as WebGL2RenderingContext);
    this.generated = true;
    this.apply();
  }

  setSize(width: number, height: number): void {
    const s = this.opts.scale === 'auto' ? Math.max(2, Math.ceil(Math.sqrt((width * height) / CLOUD_PIXEL_BUDGET))) : Math.max(1, Math.round(this.opts.scale));
    this.effScale = s;
    this.marchMat.uniforms.uScale.value = s;
    this.target.setSize(Math.max(1, Math.ceil(width / s)), Math.max(1, Math.ceil(height / s)));
    (this.marchMat.uniforms.uFullSize.value as Vector2).set(width, height);
  }

  /** Re-bake the shadow map when the sun, the clouds or the area of interest changed. */
  updateShadow(renderer: WebGLRenderer, center: Vector3, sunDir: Vector3): void {
    if (!this.visible || !this.opts.shadows) return;
    // Snap the centre to whole texels so the shadow doesn't swim as the target moves.
    const texel = SHADOW_EXTENT / SHADOW_SIZE;
    const cx = Math.round(center.x / (texel * 32)) * texel * 32;
    const cz = Math.round(center.z / (texel * 32)) * texel * 32;
    const u = this.marchMat.uniforms;
    const off = u.uCloudOffset.value as Vector3;
    const key = `${sunDir.x},${sunDir.y},${sunDir.z},${cx},${cz},${u.uCoverage.value},${u.uCloudBottom.value},${u.uCloudTop.value},${u.uExtinction.value},${off.x},${off.z}`;
    if (key === this.shadowKey) return;
    this.shadowKey = key;
    (this.shadowUniforms.uCloudShadowCenter.value as Vector2).set(cx, cz);
    const prev = renderer.getRenderTarget();
    this.quad.material = this.shadowMat;
    renderer.setRenderTarget(this.shadowRT);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
    this.shadowVersion++;
  }

  /**
   * Fraction of direct sunlight that gets through the clouds at scene point p (metres), read
   * back from the shadow map without stalling (one texel, asynchronously). 1 when clear.
   */
  async sunTransmittanceAt(renderer: WebGLRenderer, p: Vector3, sunDir: Vector3): Promise<number> {
    if (!this.visible || !this.opts.shadows || sunDir.y < 0.02 || p.y > this.opts.altitude[1]) return 1;
    const c = this.shadowUniforms.uCloudShadowCenter.value as Vector2;
    const y = Math.max(p.y, 0);
    const u = (p.x - (sunDir.x / sunDir.y) * y - c.x) / SHADOW_EXTENT + 0.5;
    const v = (p.z - (sunDir.z / sunDir.y) * y - c.y) / SHADOW_EXTENT + 0.5;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return 1;
    await renderer.readRenderTargetPixelsAsync(this.shadowRT, Math.floor(u * SHADOW_SIZE), Math.floor(v * SHADOW_SIZE), 1, 1, this.probeBuf);
    return Math.min(1, Math.max(0, DataUtils.fromHalfFloat(this.probeBuf[0])));
  }

  /** March the clouds into `target`. depth and aerial are the stage's resolved depth and haze volume. */
  render(renderer: WebGLRenderer, depth: unknown, aerial: unknown): void {
    const u = this.marchMat.uniforms;
    u.tDepth.value = depth;
    u.tAerial.value = aerial;
    const prev = renderer.getRenderTarget();
    this.quad.material = this.marchMat;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  /**
   * Make a lit material's sunlight pass through the clouds (cloud shadows on objects and
   * terrain). Chains any existing onBeforeCompile; safe to call more than once.
   */
  shade(material: Material): void {
    const tagged = material as Material & { userData: { firstlightClouds?: boolean } };
    if (tagged.userData.firstlightClouds) return;
    tagged.userData.firstlightClouds = true;
    const prev = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
      prev.call(material, shader, renderer);
      this.inject(shader);
    };
    material.customProgramCacheKey = () => prevKey.call(material) + '|firstlight-clouds';
    material.needsUpdate = true;
  }

  private inject(shader: WebGLProgramParametersWithUniforms): void {
    const fs = shader.fragmentShader;
    const lit = fs.includes('#include <lights_fragment_begin>') || fs.includes('getDirectionalLightInfo( directionalLight, directLight );');
    if (!lit) return;
    Object.assign(shader.uniforms, this.shadowUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlCloudPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvFlCloudPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    // Expand the lights chunk if an earlier hook has not, then dim the sun (directional light 0).
    let f = fs.replace('#include <lights_fragment_begin>', ShaderChunk.lights_fragment_begin);
    f = f
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlCloudPos;\n' + CLOUD_SHADOW_LOOKUP)
      .replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tif ( UNROLLED_LOOP_INDEX == 0 ) directLight.color *= cloudSunTransmittance( vFlCloudPos );',
      );
    shader.fragmentShader = f;
  }

  dispose(): void {
    for (const rt of [this.shape, this.detail, this.weather, this.shadowRT, this.target]) rt.dispose();
    for (const m of this.materials) m.dispose();
    this.quad.dispose();
  }
}
