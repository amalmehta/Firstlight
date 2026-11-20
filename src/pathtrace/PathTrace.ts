import {
  BufferAttribute,
  type BufferGeometry,
  type Vector3,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { CLOUD_SHADOW_LOOKUP } from '../atmosphere/glsl';
import { TERRAIN_DETAIL_GLSL } from '../terrain/Terrain';
import { yieldTask } from '../stage/yieldTask';

/**
 * Progressive path tracing while the camera is still ("settle"), on three-gpu-pathtracer's
 * WebGL path tracer (Johnson, three-gpu-pathtracer 0.0.28, MIT). It replaces only the light
 * leaving surfaces: the stage's composite still adds the sky, aerial perspective, clouds,
 * exposure and tone mapping on top, using the raster depth. So the settled frame differs from
 * the raster one only where the raster approximations (shadow map, GTAO, sky-view factor,
 * prefiltered environment) differ from traced light.
 *
 * The library is loaded on first use (dynamic import), so pages that never settle never
 * download it.
 */
export interface PathTraceOptions {
  /** Samples per pixel to stop at (then the GPU idles). Default 64. */
  samples?: number;
  /** Milliseconds the view must be still before tracing starts. Default 400. */
  delayMs?: number;
  /** Fade from raster to traced over this many milliseconds, once `minSamples` are in. Default 700. */
  fadeMs?: number;
  /** Samples before the fade starts (fewer look noisy). Default 4. */
  minSamples?: number;
  /** Diffuse/specular bounces. Default 4. */
  bounces?: number;
  /**
   * Widen glossy lobes after rough bounces (three-gpu-pathtracer's filterGlossyFactor, 0..1):
   * trades exact caustics (ground → mirror → bright sky near the sun) for no fireflies. Default 0.5.
   */
  filterGlossy?: number;
  /**
   * Split each sample into tiles×tiles draws, so no frame carries a whole sample and moving the
   * camera never waits behind one. 'auto' (default): about 12k pixels per tile. Frames then draw
   * as many tiles as fit a ~30 ms budget, measured as they go.
   */
  tiles?: number | 'auto';
}

const DEFAULTS: Required<PathTraceOptions> = { samples: 64, delayMs: 400, fadeMs: 700, minSamples: 4, bounces: 4, filterGlossy: 0.5, tiles: 'auto' };

/** Frame time the tiles-per-frame control aims for, ms. */
export const FRAME_TARGET_MS = 30;

/**
 * Tiles per axis for a w×h buffer: about 12k pixels per tile. Small, because tile cost is very
 * uneven: measured here (1536×960, hidden browser pane), 6×6 tiles had a median of 26 ms but the
 * tiles where rays graze the distant terrain took 240–480 ms. Smaller tiles bound that worst
 * frame (what a drag can get stuck behind); drawing several per frame keeps throughput.
 */
export function initialTiles(w: number, h: number): number {
  return Math.min(16, Math.max(1, Math.ceil(Math.sqrt((w * h) / 12000))));
}

/**
 * Tiles to draw next frame from the last frame's time: one more while under 70% of the target,
 * cut by 40% when over 140% (so one heavy frame backs off at once), else unchanged.
 */
export function nextTilesPerFrame(k: number, frameMs: number, target = FRAME_TARGET_MS): number {
  if (frameMs > target * 1.4) return Math.max(1, Math.floor(k * 0.6));
  if (frameMs < target * 0.7) return Math.min(32, k + 1);
  return k;
}

type Uniforms = Record<string, { value: unknown }>;

/** Structural view of the parts of WebGLPathTracer used here (the package ships no types for them we rely on). */
interface Tracer {
  bounces: number;
  tiles: { set(x: number, y: number): void };
  samples: number;
  renderDelay: number;
  minSamples: number;
  fadeDuration: number;
  renderToCanvas: boolean;
  rasterizeScene: boolean;
  dynamicLowRes: boolean;
  multipleImportanceSampling: boolean;
  filterGlossyFactor: number;
  isCompiling: boolean;
  target: { texture: Texture };
  setBVHWorker(w: unknown): void;
  setSceneAsync(scene: Scene, camera: PerspectiveCamera): Promise<unknown>;
  updateCamera(): void;
  updateMaterials(): void;
  updateLights(): void;
  updateEnvironment(): void;
  renderSample(): void;
  reset(): void;
  dispose(): void;
  _pathTracer: { material: { fragmentShader: string; uniforms: Uniforms; needsUpdate: boolean; backgroundMap: Texture | null } };
}

/** Where a primary ray that misses everything adds the background (0.0.28). */
const MISS_LINE = 'gl_FragColor.rgb += sampleBackground( ray.direction, rand2( 2 ) ) * state.throughputColor;';

/** The line in the tracer's direct-light function that adds a light sample (0.0.28). */
const DIRECT_LINE = 'result = attenuatedColor * lightRec.emission * state.throughputColor * sampleColor * misWeight / lightPdf;';

/**
 * Make primary misses add nothing, so the traced colour is premultiplied by coverage (alpha)
 * and the composite can lay it over the raster sky. Done in the shader rather than with a black
 * background texture because the tracer already uses all 16 texture units of a typical GPU
 * once the cloud shadow map is added.
 */
export function patchPremultipliedMiss(fragmentShader: string): string | null {
  if (!fragmentShader.includes(MISS_LINE)) return null;
  return fragmentShader.replace(MISS_LINE, MISS_LINE.replace(';', ' * ( state.firstRay ? backgroundAlpha : 1.0 );'));
}

/**
 * Patch the tracer's shader so the sun (its only directional light) is dimmed by the stage's
 * cloud shadow map, as the raster materials are. Returns false if the shader text changed
 * upstream and the patch no longer applies (then clouds cast no shadow in the traced frame).
 */
export function patchCloudShadow(fragmentShader: string): string | null {
  const at = fragmentShader.indexOf('vec3 directLightContribution(');
  if (at < 0 || !fragmentShader.includes(DIRECT_LINE)) return null;
  const head = fragmentShader.slice(0, at);
  const tail = fragmentShader
    .slice(at)
    .replace(DIRECT_LINE, DIRECT_LINE.replace(' / lightPdf;', ' / lightPdf * (lightRec.type == DIR_LIGHT_TYPE ? cloudSunTransmittance(rayOrigin) : 1.0);'));
  return `${head}${CLOUD_SHADOW_LOOKUP}\n${tail}`;
}

/**
 * three-gpu-pathtracer 0.0.28 merges an RGB (itemSize 3) vertex colour into its RGBA buffer
 * with source and target swapped (mergeGeometries.js), so RGB colours arrive as zero. While the
 * tracer gathers geometry, swap in an RGBA copy (cached per attribute version), then put the
 * original back. Returns the undo function.
 */
export const TERRAIN_MARK = 0.125;
const rgbaCache = new WeakMap<BufferAttribute, { version: number; rgba: BufferAttribute }>();
export function withRgbaColors(root: Object3D): () => void {
  const undo: (() => void)[] = [];
  root.traverse((o) => {
    const geo = (o as Mesh).geometry as BufferGeometry | undefined;
    const c = geo?.getAttribute?.('color') as BufferAttribute | undefined;
    if (!geo || !c || c.itemSize !== 3 || !(c instanceof BufferAttribute)) return;
    let hit = rgbaCache.get(c);
    if (!hit || hit.version !== c.version) {
      const n = c.count;
      const out = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        out[i * 4] = c.getX(i);
        out[i * 4 + 1] = c.getY(i);
        out[i * 4 + 2] = c.getZ(i);
        out[i * 4 + 3] = 1;
      }
      hit = { version: c.version, rgba: new BufferAttribute(out, 4) };
      rgbaCache.set(c, hit);
    }
    // Terrain vertices carry a marker in alpha (the tracer ignores vertex alpha on opaque
    // materials), so the traced shader knows where to add the terrain's procedural detail.
    const want = 'terrainUniforms' in o ? TERRAIN_MARK : 1;
    if (hit.rgba.getW(0) !== want) {
      for (let i = 0; i < hit.rgba.count; i++) hit.rgba.setW(i, want);
    }
    geo.setAttribute('color', hit.rgba);
    undo.push(() => geo.setAttribute('color', c));
  });
  return () => undo.forEach((f) => f());
}

/** Where the main loop has a surface record and is about to sample the BSDF (0.0.28). */
const SURFACE_LINE = 'scatterRec = bsdfSample( - ray.direction, surf );';

/**
 * Add the terrain's per-pixel detail (Terrain.ts) to traced terrain hits: the same albedo noise,
 * and the same bump height with its gradient taken by finite differences in world space (the
 * raster version uses screen-space derivatives, which a ray hit does not have).
 */
export function patchTerrainDetail(fragmentShader: string): string | null {
  const at = fragmentShader.indexOf('vec3 directLightContribution(');
  if (at < 0 || !fragmentShader.includes(SURFACE_LINE)) return null;
  const fn = /* glsl */ `
uniform vec3 uFlCameraPos;
${TERRAIN_DETAIL_GLSL}
float flBumpH(vec2 p, float near) { return (0.6 * tNoise(p / 2.7) + 0.4 * tNoise(p / 0.9)) * 0.35 * near; }
void flTerrainDetail(vec3 hp, SurfaceHit hit, Material material, inout SurfaceRecord surf) {
  if (!material.vertexColors) return;
  float mark = textureSampleBarycoord(attributesArray, ATTR_COLOR, hit.barycoord, hit.faceIndices.xyz).a;
  if (abs(mark - ${TERRAIN_MARK.toFixed(3)}) > 0.01) return;
  float tDist = length(hp - uFlCameraPos);
  float tFade = 1.0 - smoothstep(150.0, 1200.0, tDist);
  surf.color *= mix(1.0, 0.8 + 0.4 * tDetail(hp.xz), tFade);
  float tNear = 1.0 - smoothstep(40.0, 600.0, tDist);
  if (tNear <= 0.0) return;
  const float e = 0.05;
  vec3 g = vec3(flBumpH(hp.xz + vec2(e, 0.0), tNear) - flBumpH(hp.xz - vec2(e, 0.0), tNear), 0.0,
                flBumpH(hp.xz + vec2(0.0, e), tNear) - flBumpH(hp.xz - vec2(0.0, e), tNear)) / (2.0 * e);
  vec3 n = surf.normal;
  surf.normal = normalize(n - (g - dot(g, n) * n));
}
`;
  return (
    fragmentShader.slice(0, at) +
    fn +
    fragmentShader.slice(at).replace(SURFACE_LINE, `flTerrainDetail(ray.origin + ray.direction * surfaceHit.dist, surfaceHit, material, surf);\n${SURFACE_LINE}`)
  );
}

export class PathTrace {
  readonly opts: Required<PathTraceOptions>;
  private tracer: Tracer | null = null;
  private loading: Promise<void> | null = null;
  private failed = false;
  /** Bumped by markSceneDirty; a build is current when it started at the latest version. */
  private sceneVersion = 0;
  private builtVersion = -1;
  private worker: { dispose(): void } | null = null;

  private get sceneBuilt(): boolean {
    return this.builtVersion === this.sceneVersion;
  }
  private envMap: Texture | null = null;
  private verified = false;
  private tileCount = 0; // 0: not chosen yet (auto picks from the buffer size on first use)
  private perFrame = 1;
  /** True when the cloud-shadow patch applied to this version of the tracer's shader. */
  cloudShadowPatched = false;

  /** True when the terrain-detail patch applied. */
  terrainDetailPatched = false;

  constructor(
    opts: PathTraceOptions = {},
    private cloudUniforms: Uniforms | null,
    private cameraPosition: Vector3,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  get ready(): boolean {
    return !!this.tracer && this.sceneBuilt && !this.tracer.isCompiling;
  }

  get samples(): number {
    return this.tracer?.samples ?? 0;
  }

  get texture(): Texture | null {
    return this.tracer?.target.texture ?? null;
  }

  get unavailable(): boolean {
    return this.failed;
  }

  set(opts: PathTraceOptions): void {
    Object.assign(this.opts, opts);
    if (typeof this.opts.tiles === 'number') this.tileCount = this.opts.tiles;
    if (this.tracer) {
      this.tracer.bounces = this.opts.bounces;
      this.tracer.filterGlossyFactor = this.opts.filterGlossy;
      this.tracer.reset();
      this.tracer.tiles.set(this.tileCount, this.tileCount);
    }
  }

  /** Tiles per axis in use. */
  get tiles(): number {
    return this.tileCount;
  }

  /** Tiles drawn per frame at the moment. */
  get tilesPerFrame(): number {
    return this.perFrame;
  }

  /** Feed the time of the last frame (ms), to size the next one. */
  adaptFrame(frameMs: number): void {
    this.perFrame = nextTilesPerFrame(this.perFrame, frameMs);
  }

  /** Load the library and create the tracer (once). */
  private async load(renderer: WebGLRenderer): Promise<void> {
    const [{ WebGLPathTracer }, { GenerateMeshBVHWorker }] = await Promise.all([
      import('three-gpu-pathtracer'),
      import('three-mesh-bvh/worker'),
    ]);
    // 0.0.28's constructor logs deprecation notices that are not ours to act on: for the WebGL
    // class itself (the package now leads with WebGPU; the WebGL path still ships and is what
    // this stage renders with), for THREE.Clock, and for the BVH option it passes while building
    // its initial empty scene (later builds use the option's new name, below).
    const warn = console.warn;
    const quiet = [
      'WebGLPathTracer: This class has been deprecated',
      'THREE.Clock: This module has been deprecated',
      'MeshBVH: "maxLeafTris" option has been deprecated',
    ];
    console.warn = (...a: unknown[]) => {
      if (typeof a[0] === 'string' && quiet.some((q) => (a[0] as string).startsWith(q))) return;
      warn(...a);
    };
    let t: Tracer;
    try {
      t = new WebGLPathTracer(renderer) as unknown as Tracer;
    } finally {
      console.warn = warn;
    }
    // The parallel worker needs SharedArrayBuffer (cross-origin isolation), which a library
    // can't assume; it would fall back to this single-threaded one with a warning anyway.
    const worker = new GenerateMeshBVHWorker();
    this.worker = worker;
    t.setBVHWorker(worker);
    // The tracer passes the deprecated maxLeafTris: 1; the same leaf size under its new name.
    (t as unknown as { _generator: { bvhOptions: Record<string, unknown> } })._generator.bvhOptions = { maxLeafTris: 0, targetLeafSize: 1 };
    t.renderToCanvas = false;
    t.rasterizeScene = false;
    t.dynamicLowRes = false;
    t.renderDelay = 0;
    t.minSamples = 0;
    t.fadeDuration = 0;
    t.multipleImportanceSampling = true;
    t.bounces = this.opts.bounces;
    t.filterGlossyFactor = this.opts.filterGlossy;
    if (typeof this.opts.tiles === 'number') this.tileCount = this.opts.tiles;
    else if (!this.tileCount) {
      const gl = renderer.getContext();
      this.tileCount = initialTiles(gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
    t.tiles.set(this.tileCount, this.tileCount);
    const mat = t._pathTracer.material;
    const premult = patchPremultipliedMiss(mat.fragmentShader);
    if (!premult) throw new Error('three-gpu-pathtracer shader changed: background patch does not apply');
    mat.fragmentShader = premult;
    mat.needsUpdate = true;
    const detail = patchTerrainDetail(mat.fragmentShader);
    if (detail) {
      mat.fragmentShader = detail;
      mat.uniforms.uFlCameraPos = { value: this.cameraPosition };
      this.terrainDetailPatched = true;
    }
    if (this.cloudUniforms) {
      const patched = patchCloudShadow(mat.fragmentShader);
      if (patched) {
        mat.fragmentShader = patched;
        Object.assign(mat.uniforms, this.cloudUniforms);
        mat.needsUpdate = true;
        this.cloudShadowPatched = true;
      }
    }
    this.tracer = t;
    // The constructor is one long task (~0.36 s here: it builds its helper shaders); let the
    // page breathe before the next one.
    await yieldTask();
  }

  /**
   * Get the tracer ready for this scene: load the library, build the BVH (in workers) and
   * upload materials. `hide` objects are left out (the stage's sky triangle); `env` renders
   * the current sky as an equirect map at the current exposure.
   */
  prepare(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, hide: Object3D[], env: () => Texture): Promise<void> {
    if (this.failed) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      if (!this.tracer) await this.load(renderer);
      const t = this.tracer!;
      if (this.sceneBuilt) return;
      const version = this.sceneVersion;
      // Gathering and merging the geometry is the other long task (~0.6 s for the 524k-triangle
      // valley here); only the BVH build itself runs in a worker.
      await yieldTask();
      // The geometry, materials and lights are gathered synchronously when the build starts
      // (only the BVH is built in workers), so hiding the sky just around that call is enough.
      // The environment is set separately (restart): the stage's own scene.environment is a
      // prefiltered PMREM cube, and the tracer's cube→equirect converter needs a shader chunk
      // that three 0.187 removed, so the stage hands it an equirect sky instead.
      const realEnv = t.updateEnvironment;
      t.updateEnvironment = () => {};
      let build: Promise<unknown>;
      const vis = hide.map((o) => o.visible);
      hide.forEach((o) => (o.visible = false));
      const restoreColors = withRgbaColors(scene);
      try {
        build = t.setSceneAsync(scene, camera);
      } finally {
        restoreColors();
        hide.forEach((o, i) => (o.visible = vis[i]));
      }
      try {
        await build;
      } finally {
        t.updateEnvironment = realEnv;
      }
      // If the scene changed while the BVH was building, stay unbuilt: the next frame rebuilds.
      this.builtVersion = version;
      if (!this.sceneBuilt) return;
      this.restart(scene, env);
    })()
      .catch((e) => {
        this.failed = true;
        console.error('Firstlight: path tracing unavailable;', e);
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** The scene's objects changed: rebuild the BVH next time. */
  markSceneDirty(): void {
    this.sceneVersion++;
  }

  /**
   * Start a new accumulation: pick up the camera, lights, materials, and a fresh sky map
   * (rendered at the current sun and exposure, so its intensity is 1) with its sampling tables.
   */
  restart(scene: Scene, env: () => Texture): void {
    const t = this.tracer;
    if (!t || !this.sceneBuilt) return;
    t.updateCamera();
    t.updateLights();
    t.updateMaterials();
    const prevEnv = this.envMap;
    this.envMap = env();
    const keep = { env: scene.environment, bg: scene.background, k: scene.environmentIntensity };
    scene.environment = this.envMap;
    scene.background = null;
    scene.environmentIntensity = 1;
    try {
      t.updateEnvironment();
    } finally {
      scene.environment = keep.env;
      scene.background = keep.bg;
      scene.environmentIntensity = keep.k;
    }
    prevEnv?.dispose();
    t.reset();
  }

  /** Add this frame's tiles (tilesPerFrame of them, stopping at `samples`). */
  step(renderer: WebGLRenderer): void {
    const t = this.tracer;
    if (!t || this.failed) return;
    for (let i = 0; i < this.perFrame && t.samples < this.opts.samples; i++) t.renderSample();
    if (!this.verified && t.samples > 0) {
      // A program that fails to link draws nothing and three only logs it; check once.
      this.verified = true;
      const gl = renderer.getContext();
      const prog = (renderer.properties.get(t._pathTracer.material) as { currentProgram?: { program: WebGLProgram } }).currentProgram;
      if (prog && !gl.getProgramParameter(prog.program, gl.LINK_STATUS)) {
        this.failed = true;
        t.reset();
        console.error('Firstlight: path tracing unavailable; shader did not link:', gl.getProgramInfoLog(prog.program));
      }
    }
  }

  reset(): void {
    this.tracer?.reset();
  }

  dispose(): void {
    this.tracer?.dispose();
    this.worker?.dispose();
    this.envMap?.dispose();
  }
}
