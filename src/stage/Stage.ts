import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CubeCamera,
  DepthTexture,
  DirectionalLight,
  FloatType,
  HalfFloatType,
  Matrix4,
  Mesh,
  PCFShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGL3DRenderTarget,
  WebGLCubeRenderTarget,
  LinearFilter,
  WebGLRenderTarget,
  WebGLRenderer,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { Atmosphere } from '../atmosphere/Atmosphere';
import type { AtmosphereParams } from '../atmosphere/params';
import { sunDirection, sunTransmittance } from '../atmosphere/reference';
import { FULLSCREEN_VERT } from '../atmosphere/glsl';
import {
  SOLAR_ILLUMINANCE_LUX,
  describeEv,
  ev100FromCamera,
  ev100FromIlluminance,
  exposureScale,
  type CameraSettings,
} from '../camera/photometry';
import { AERIAL_FRAG, AERIAL_SLICES, COMPOSITE_FRAG, ENV_FRAG, ENV_VERT, SKY_FRAG, SKY_VERT } from './shaders';

type Vec3 = [number, number, number];

export interface StageOptions {
  /** Sun position: degrees above the horizon, and degrees clockwise from north (-z). */
  sun?: { elevation?: number; azimuth?: number };
  /**
   * How the camera is exposed. 'auto' (default) meters like an incident light meter at the
   * camera: direct sun plus sky light on a flat, upward-facing sensor. A number is a fixed
   * EV100; camera settings ({ aperture, shutter, iso }) are converted to EV100.
   */
  exposure?: Exposure;
  /** Stops brighter (+) or darker (-) than the exposure gives. Default 0. */
  exposureCompensation?: number;
  /** Sun illuminance above the atmosphere, lux. Default 133 800 (Earth, yearly mean). */
  sunIlluminance?: number;
  camera?: { position?: Vec3; target?: Vec3; fov?: number };
  /** Cap on devicePixelRatio, to keep the frame budget on Retina screens. Default 1.5. */
  maxPixelRatio?: number;
  /** Half-size (metres) of the square the sun's shadow map covers around the camera target. */
  shadowExtent?: number;
  /** Override Earth's atmosphere (e.g. { mieScattering: 0.02 } for a hazy day). */
  atmosphere?: Partial<AtmosphereParams>;
  /**
   * Shadow the haze with the terrain (default true): air in a ridge's shadow stops scattering
   * sunlight. Costs a heightfield march per aerial-volume sample; turn off to compare.
   */
  shadowedHaze?: boolean;
  /** Text summary for screen readers: what the scene shows. */
  label?: string;
  /** Tone mapping operator. Default 'agx'. */
  toneMapping?: 'agx' | 'aces';
}

export class FirstlightUnsupportedError extends Error {}

export type Exposure = 'auto' | number | CameraSettings;

/** What the camera is doing right now, for display. */
export interface ExposureState {
  mode: 'auto' | 'manual';
  /** EV100 actually used (after compensation). */
  ev100: number;
  /** Horizontal illuminance at the camera (sun + sky), lux. */
  illuminanceLux: number;
  /** Of which, from the sky, lux. */
  skyLux: number;
  /** Equivalent camera settings, e.g. "f/8 · 1/500 s · ISO 100". */
  settings: string;
}

/**
 * The tone curve (AgX) is designed for mid-grey at 0.18; a metered 18% card lands at
 * about 0.12 of sensor saturation (photometry.ts tests). This display gain lines the two
 * up (0.18 / 0.119 ≈ 1.5). It is a display calibration, not a physical quantity.
 */
const DISPLAY_GAIN = 1.5;

const SUN_ANGULAR_RADIUS = (0.2667 * Math.PI) / 180; // mean, radians
const ENV_THROTTLE_MS = 120;
const KM = 1 / 1000;

/** Show a plain message instead of a blank canvas, then throw. */
function unsupported(container: HTMLElement, why: string): never {
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText =
    'display:grid;place-items:center;height:100%;min-height:240px;padding:24px;' +
    'font:16px/1.5 system-ui,sans-serif;color:#2a2622;background:#f4efe6;text-align:center';
  box.textContent = `This 3D scene needs ${why}, which this browser or device doesn't provide. Try a recent Chrome, Safari or Firefox on a computer.`;
  container.replaceChildren(box);
  throw new FirstlightUnsupportedError(why);
}

/**
 * A stage: renderer, camera, controls, sky and sun, ready to add meshes to.
 * It renders on demand (only after something changes), so an idle scene costs nothing.
 */
export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly atmosphere: Atmosphere;
  readonly sun: DirectionalLight;
  readonly canvas: HTMLCanvasElement;
  /** CPU time of the last render() call, ms. */
  lastRenderMs = 0;

  private container: HTMLElement;
  private hdr: WebGLRenderTarget;
  private composite: FullScreenQuad;
  private compositeMat: ShaderMaterial;
  private aerialMat: ShaderMaterial;
  private aerialQuad: FullScreenQuad;
  private aerial = new WebGL3DRenderTarget(32, 32, AERIAL_SLICES, { type: HalfFloatType, depthBuffer: false });
  private skyMat: ShaderMaterial;
  private envScene = new Scene();
  private envMat: ShaderMaterial;
  private cubeRT = new WebGLCubeRenderTarget(64, { type: HalfFloatType });
  private cubeCam = new CubeCamera(0.1, 10, this.cubeRT);
  private pmrem: PMREMGenerator;
  private envRT: WebGLRenderTarget | null = null;
  private envDirty = true;
  private envLast = 0;
  private envTimer = 0;
  private frameRequested = false;
  private loopFn: ((dt: number, t: number) => void) | null = null;
  private lastTime = 0;
  private home: { position: Vector3; target: Vector3 };
  private ground: ((x: number, z: number) => number) | null = null;
  private resizeObs: ResizeObserver;
  private reduceMotion: MediaQueryList;
  private sunAngles = { elevation: 25, azimuth: 200 };
  private sunLux: number;
  private exposureMode: Exposure;
  private compensation: number;
  private exposureState: ExposureState = { mode: 'auto', ev100: 0, illuminanceLux: 0, skyLux: 0, settings: '' };
  private meterKey = '';
  private preExposure = 1;
  private envPreExposure = 1;
  private renderListeners: (() => void)[] = [];
  private shadowedHaze: boolean;
  /** Sky irradiance per unit sun illuminance, from the last meter reading. */
  private skyTransfer = -1;
  private skyMeterBusy = false;
  private skyMeterKey = '';
  private meterPending: Promise<void> | null = null;
  private invViewProj = new Matrix4();
  private camAtm = new Vector3();
  private disposed = false;
  private shadowKey = '';
  private sunShaders: ((m: Material) => void)[] = [];
  private sunAware: { setSunDirection: (d: Vector3, r: WebGLRenderer) => void }[] = [];
  private shadowsDirty = true;

  constructor(container: HTMLElement, opts: StageOptions = {}) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', opts.label ?? 'A 3D scene lit by a simulated sky and sun.');
    this.canvas.tabIndex = 0;

    const gl = this.canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
    if (!gl) unsupported(container, 'WebGL 2');
    if (!gl.getExtension('EXT_color_buffer_float')) unsupported(container, 'floating-point render targets');
    container.appendChild(this.canvas);

    this.renderer = new WebGLRenderer({ canvas: this.canvas, context: gl, antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.maxPixelRatio ?? 1.5));
    this.renderer.toneMapping = opts.toneMapping === 'aces' ? ACESFilmicToneMapping : AgXToneMapping;
    this.renderer.toneMappingExposure = DISPLAY_GAIN;
    this.exposureMode = opts.exposure ?? 'auto';
    this.compensation = opts.exposureCompensation ?? 0;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.pmrem = new PMREMGenerator(this.renderer);

    const w = Math.max(container.clientWidth, 1);
    const h = Math.max(container.clientHeight, 1);
    this.camera = new PerspectiveCamera(opts.camera?.fov ?? 40, w / h, 0.5, 60000);
    this.camera.position.set(...(opts.camera?.position ?? [0, 30, 120]));
    this.atmosphere = new Atmosphere(opts.atmosphere);
    this.sunLux = opts.sunIlluminance ?? SOLAR_ILLUMINANCE_LUX;
    this.shadowedHaze = opts.shadowedHaze ?? true;

    // HDR target: half-float colour, 4x MSAA, float depth (read back for aerial perspective).
    this.hdr = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.hdr.depthTexture = new DepthTexture(1, 1, FloatType);

    const shared = this.atmosphere.uniforms;
    const viewUniforms = {
      uInvViewProj: { value: this.invViewProj },
      uCamPosM: { value: this.camera.position },
      uCamAtm: { value: this.camAtm },
    };
    this.skyMat = new ShaderMaterial({
      uniforms: {
        ...shared,
        ...viewUniforms,
        uSunCosRadius: { value: Math.cos(SUN_ANGULAR_RADIUS) },
        uSunSolidAngle: { value: 2 * Math.PI * (1 - Math.cos(SUN_ANGULAR_RADIUS)) },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const tri = new BufferGeometry();
    tri.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const sky = new Mesh(tri, this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    sky.name = 'Sky';
    this.scene.add(sky);

    this.envMat = new ShaderMaterial({
      uniforms: { ...shared, uCamAtm: { value: this.camAtm } },
      vertexShader: ENV_VERT,
      fragmentShader: ENV_FRAG,
      side: BackSide,
      depthWrite: false,
    });
    this.envScene.add(new Mesh(new SphereGeometry(5, 32, 16), this.envMat));

    this.aerial.texture.minFilter = LinearFilter;
    this.aerial.texture.magFilter = LinearFilter;
    this.aerialMat = new ShaderMaterial({
      uniforms: { ...shared, ...viewUniforms, uSlice: { value: 0 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: AERIAL_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.aerialQuad = new FullScreenQuad(this.aerialMat);
    this.compositeMat = new ShaderMaterial({
      uniforms: {
        ...viewUniforms,
        tColor: { value: this.hdr.texture },
        tDepth: { value: this.hdr.depthTexture },
        tAerial: { value: this.aerial.texture },
        uAerialOn: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.composite = new FullScreenQuad(this.compositeMat);

    this.sun = new DirectionalLight(0xffffff, 1);
    this.sun.name = 'Sun';
    this.sun.castShadow = true;
    const ext = opts.shadowExtent ?? 400;
    Object.assign(this.sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 8000 });
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.15;
    this.scene.add(this.sun, this.sun.target);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(...(opts.camera?.target ?? [0, 10, 0]));
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 9000;
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const applyMotion = () => {
      this.controls.enableDamping = !this.reduceMotion.matches;
      this.controls.dampingFactor = 0.12;
    };
    applyMotion();
    this.reduceMotion.addEventListener('change', applyMotion);
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.update();
    this.home = { position: this.camera.position.clone(), target: this.controls.target.clone() };

    this.canvas.addEventListener('dblclick', () => this.resetCamera());
    this.canvas.addEventListener('keydown', (e) => {
      if (e.key === 'r' || e.key === 'R') this.resetCamera();
    });

    this.setSun(opts.sun ?? {});
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
  }

  get reducedMotion(): boolean {
    return this.reduceMotion.matches;
  }

  /** Add objects to the scene. A Terrain (anything with heightAt) also keeps the camera above
   * ground and shadows every lit material in the scene, including ones added later. */
  add(...objects: Object3D[]): this {
    for (const o of objects) {
      this.scene.add(o);
      const shader = o as unknown as { shadeWithSun?: (m: Material) => void };
      if (typeof shader.shadeWithSun === 'function') this.sunShaders.push(shader.shadeWithSun.bind(o));
      // A heightfield also shadows the haze: air in a ridge's shadow stops scattering sunlight.
      const hf = o as unknown as { terrainUniforms?: Record<string, { value: unknown }> };
      if (hf.terrainUniforms && this.shadowedHaze) {
        const tu = hf.terrainUniforms;
        Object.assign(this.aerialMat.uniforms, {
          uHeightTex: tu.uHeightTex,
          uTerrainSize: tu.uTerrainSize,
          uTerrainSegments: tu.uTerrainSegments,
          uTerrainMaxH: tu.uTerrainMaxH,
        });
        this.aerialMat.defines.TERRAIN_SHADOW = '';
        this.aerialMat.needsUpdate = true;
      }
      const h = (o as unknown as { heightAt?: (x: number, z: number) => number }).heightAt;
      if (typeof h === 'function') this.ground = h.bind(o);
      const sunAware = o as unknown as { setSunDirection?: (d: Vector3, r: WebGLRenderer) => void };
      if (typeof sunAware.setSunDirection === 'function') this.sunAware.push(sunAware as { setSunDirection: (d: Vector3, r: WebGLRenderer) => void });
    }
    // Terrain shadows apply to every lit material, whichever was added first.
    this.scene.traverse((node) => {
      const mat = (node as Mesh).material;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) for (const f of this.sunShaders) f(m);
    });
    this.shadowsDirty = true;
    this.invalidate();
    return this;
  }

  /** Move the sun. Recomputes the sky, the sun colour and (throttled) the environment light. */
  setSun({ elevation, azimuth }: { elevation?: number; azimuth?: number }): this {
    if (elevation !== undefined) this.sunAngles.elevation = Math.max(-10, Math.min(90, elevation));
    if (azimuth !== undefined) this.sunAngles.azimuth = ((azimuth % 360) + 360) % 360;
    const d = sunDirection(this.sunAngles.elevation, this.sunAngles.azimuth);
    this.atmosphere.uniforms.uSunDir.value.set(...d);
    this.envDirty = true;
    this.invalidate();
    return this;
  }

  getSun(): { elevation: number; azimuth: number } {
    return { ...this.sunAngles };
  }

  /** 'auto' (incident meter), a fixed EV100, or { aperture, shutter, iso }. */
  setExposure(exposure: Exposure): this {
    this.exposureMode = exposure;
    this.meterKey = '';
    this.invalidate();
    return this;
  }

  /** Stops brighter (+) or darker (-) than the exposure mode gives. */
  setExposureCompensation(stops: number): this {
    this.compensation = stops;
    this.meterKey = '';
    this.invalidate();
    return this;
  }

  /** Run fn after every drawn frame (e.g. to update a readout). Returns an unsubscribe function. */
  onRender(fn: () => void): () => void {
    this.renderListeners.push(fn);
    return () => { this.renderListeners = this.renderListeners.filter((f) => f !== fn); };
  }

  /**
   * Render until the exposure meter has caught up (its sky reading is asynchronous), then
   * resolve. Use before reading getExposure() right after moving the sun.
   */
  async settle(): Promise<void> {
    this.render();
    for (let i = 0; i < 4 && this.meterPending; i++) {
      const p = this.meterPending;
      await p;
      if (this.meterPending === p) this.meterPending = null;
      this.render();
    }
  }

  /** The exposure used for the last frame: EV100, metered lux, and camera settings. */
  getExposure(): ExposureState {
    return { ...this.exposureState };
  }

  /** Cap the device pixel ratio (1 = fast, 2 = full Retina). */
  setMaxPixelRatio(max: number): this {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, max));
    this.resize();
    return this;
  }

  setToneMapping(kind: 'agx' | 'aces'): this {
    this.renderer.toneMapping = kind === 'aces' ? ACESFilmicToneMapping : AgXToneMapping;
    this.compositeMat.needsUpdate = true;
    this.invalidate();
    return this;
  }

  /** Sun illuminance above the atmosphere, lux (Earth: 133 800). */
  setSunIlluminance(lux: number): this {
    this.sunLux = lux;
    this.meterKey = '';
    this.envDirty = true;
    this.invalidate();
    return this;
  }

  /** Ask for a frame. Cheap to call often: several calls in one frame draw once.
   * Pass { shadows: true } after moving objects outside loop(), so shadows follow. */
  invalidate(opts?: { shadows?: boolean }): void {
    if (opts?.shadows) this.shadowsDirty = true;
    if (this.frameRequested || this.disposed) return;
    this.frameRequested = true;
    requestAnimationFrame((t) => this.tick(t));
  }

  /** Opt into continuous animation; fn(dt seconds, t seconds) runs before each frame. Pass null to stop. */
  loop(fn: ((dt: number, t: number) => void) | null): this {
    this.loopFn = fn;
    this.lastTime = performance.now();
    this.invalidate();
    return this;
  }

  /** Fly back to the starting view (instant with Reduce Motion). Also: double-click or R. */
  resetCamera(): void {
    const from = { p: this.camera.position.clone(), t: this.controls.target.clone() };
    const dur = this.reducedMotion ? 0 : 450;
    const start = performance.now();
    const step = () => {
      const k = dur === 0 ? 1 : Math.min(1, (performance.now() - start) / dur);
      const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
      this.camera.position.lerpVectors(from.p, this.home.position, e);
      this.controls.target.lerpVectors(from.t, this.home.target, e);
      this.controls.update();
      this.invalidate();
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  /** Render now and return the frame as a PNG. */
  snapshot(): Promise<Blob | null> {
    this.render();
    return new Promise((res) => this.canvas.toBlob(res, 'image/png'));
  }

  /**
   * Orbit the camera for `seconds` and report frame intervals (ms). Restores the view after.
   * Intervals are capped by the display's refresh rate (16.7 ms at 60 Hz).
   */
  async benchmark(seconds = 3): Promise<{ medianMs: number; p95Ms: number; frames: number }> {
    const saved = { p: this.camera.position.clone(), t: this.controls.target.clone() };
    const offset = saved.p.clone().sub(saved.t);
    const deltas: number[] = [];
    await new Promise<void>((done) => {
      const t0 = performance.now();
      let prev = t0;
      const frame = (now: number) => {
        deltas.push(now - prev);
        prev = now;
        const a = ((now - t0) / 1000) * 0.6;
        this.camera.position.copy(saved.t).add(offset.clone().applyAxisAngle(new Vector3(0, 1, 0), a));
        this.camera.lookAt(saved.t);
        this.render();
        if (now - t0 < seconds * 1000) requestAnimationFrame(frame);
        else done();
      };
      requestAnimationFrame(frame);
    });
    this.camera.position.copy(saved.p);
    this.controls.target.copy(saved.t);
    this.controls.update();
    this.invalidate();
    const s = deltas.slice(1).sort((a, b) => a - b);
    return {
      medianMs: s[Math.floor(s.length / 2)] ?? 0,
      p95Ms: s[Math.floor(s.length * 0.95)] ?? 0,
      frames: s.length,
    };
  }

  private tick(now: number): void {
    this.frameRequested = false;
    if (this.disposed) return;
    let again = false;
    if (this.loopFn) {
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      this.loopFn(dt, now / 1000);
      again = true;
    }
    if (this.controls.enableDamping && this.controls.update()) again = true;
    this.render();
    if (again) this.invalidate();
  }

  private resize(): void {
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.hdr.setSize(Math.round(w * pr), Math.round(h * pr));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private updateEnvironment(now: number): void {
    if (!this.envDirty) return;
    if (now - this.envLast < ENV_THROTTLE_MS) {
      // Too soon: try again when the window ends, so the final sun position always lands.
      if (!this.envTimer) {
        this.envTimer = window.setTimeout(() => {
          this.envTimer = 0;
          this.invalidate();
        }, ENV_THROTTLE_MS);
      }
      return;
    }
    this.envDirty = false;
    this.envLast = now;
    this.cubeCam.update(this.renderer, this.envScene);
    const next = this.pmrem.fromCubemap(this.cubeRT.texture);
    this.envRT?.dispose();
    this.envRT = next;
    this.scene.environment = next.texture as Texture;
    this.envPreExposure = this.preExposure;
  }

  /**
   * Work out this frame's exposure. All light values are multiplied by it before they reach
   * the half-float buffers ("pre-exposure"): raw daylight in cd/m² ranges up to ~10⁹ for the
   * sun disk, far past half-float's 65504. Returns true when the exposure changed.
   */
  private updateExposure(T: [number, number, number], R: number): boolean {
    const el = this.sunAngles.elevation;
    const altKm = this.camAtm.y - R;
    const mode = this.exposureMode;
    const key = `${el},${this.sunAngles.azimuth},${altKm.toFixed(2)},${this.sunLux},${this.compensation},${JSON.stringify(mode)}`;
    if (key === this.meterKey) return false;
    this.meterKey = key;
    // Incident meter: direct sun on a horizontal sensor + sky irradiance (GPU, per unit sun).
    const yT = 0.2126 * T[0] + 0.7152 * T[1] + 0.0722 * T[2];
    const directLux = this.sunLux * yT * Math.max(Math.sin((el * Math.PI) / 180), 0);
    // Sky light: the first reading waits for the GPU; later ones are asynchronous so dragging
    // the sun never stalls a frame (the meter then trails by a frame or two).
    const skyKey = `${el},${this.sunAngles.azimuth},${altKm.toFixed(2)}`;
    if (this.skyTransfer < 0) {
      this.skyTransfer = this.atmosphere.measureSkyIrradiance(this.renderer);
      this.skyMeterKey = skyKey;
    } else if (skyKey !== this.skyMeterKey && !this.skyMeterBusy) {
      this.skyMeterBusy = true;
      this.skyMeterKey = skyKey;
      this.meterPending = this.atmosphere.measureSkyIrradianceAsync(this.renderer).then((v) => {
        this.skyMeterBusy = false;
        if (Math.abs(v - this.skyTransfer) > 1e-4 * Math.max(v, 1e-6)) {
          this.skyTransfer = v;
          this.meterKey = '';
        }
        // Re-check: the sun may have moved again while this reading was in flight.
        this.meterKey = '';
        this.invalidate();
      });
    }
    const skyLux = this.sunLux * this.skyTransfer;
    const lux = directLux + skyLux;
    let ev: number;
    if (mode === 'auto') ev = ev100FromIlluminance(lux);
    else if (typeof mode === 'number') ev = mode;
    else ev = ev100FromCamera(mode);
    ev -= this.compensation;
    const prev = this.preExposure;
    this.preExposure = exposureScale(ev);
    this.exposureState = {
      mode: mode === 'auto' ? 'auto' : 'manual',
      ev100: ev,
      illuminanceLux: lux,
      skyLux,
      settings: describeEv(ev),
    };
    return this.preExposure !== prev;
  }

  /** Draw one frame now. Normally you call invalidate() instead. */
  render(): void {
    const t0 = performance.now();
    const cam = this.camera;
    if (this.ground) {
      const g = this.ground(cam.position.x, cam.position.z) + 1.5;
      if (cam.position.y < g) cam.position.y = g;
    }
    cam.updateMatrixWorld();
    this.invViewProj.copy(cam.matrixWorld).multiply(cam.projectionMatrixInverse);
    const R = this.atmosphere.params.bottomRadius;
    this.camAtm.set(cam.position.x * KM, R + Math.max(cam.position.y * KM, 0.001), cam.position.z * KM);

    const u = this.atmosphere.uniforms;
    u.uSunIlluminance.value.setScalar(this.sunLux * this.preExposure);
    this.atmosphere.update(this.renderer, this.camAtm.y);

    // Sun light: transmittance from the sun to the camera's altitude (CPU reference).
    const T = sunTransmittance(this.atmosphere.params, this.sunAngles.elevation, this.camAtm.y - R, 64);
    if (this.updateExposure(T, R)) {
      // Exposure moved: redraw the sky-view LUT at the new scale.
      u.uSunIlluminance.value.setScalar(this.sunLux * this.preExposure);
      this.atmosphere.update(this.renderer, this.camAtm.y);
    }
    this.sun.color.setRGB(T[0], T[1], T[2]);
    this.sun.intensity = this.sunLux * this.preExposure;
    this.sun.visible = this.sunAngles.elevation > -1;
    const sd = u.uSunDir.value as Vector3;
    this.sun.target.position.copy(this.controls.target);
    this.sun.position.copy(this.controls.target).addScaledVector(sd, 4000);
    this.sun.target.updateMatrixWorld();
    for (const o of this.sunAware) o.setSunDirection(sd, this.renderer);

    // The sun's shadow map depends on the sun and the orbit target, not on the camera angle,
    // so orbiting reuses it. Animated scenes (loop) and scene edits redraw it every frame.
    const key = `${sd.x},${sd.y},${sd.z},${this.controls.target.x},${this.controls.target.y},${this.controls.target.z}`;
    if (key !== this.shadowKey || this.loopFn || this.shadowsDirty) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowKey = key;
      this.shadowsDirty = false;
    }

    this.updateEnvironment(t0);
    // The environment cube may be up to one throttle window old; rescale it to the current
    // exposure so ambient light never lags the camera.
    this.scene.environmentIntensity = this.preExposure / this.envPreExposure;

    for (let z = 0; z < AERIAL_SLICES; z++) {
      this.aerialMat.uniforms.uSlice.value = z;
      this.renderer.setRenderTarget(this.aerial, z);
      this.aerialQuad.render(this.renderer);
    }

    this.renderer.setRenderTarget(this.hdr);
    this.renderer.render(this.scene, cam);
    this.renderer.setRenderTarget(null);
    this.composite.render(this.renderer);
    this.lastRenderMs = performance.now() - t0;
    for (const f of this.renderListeners) f();
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.atmosphere.dispose();
    this.hdr.dispose();
    this.cubeRT.dispose();
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.composite.dispose();
    this.aerialQuad.dispose();
    this.aerial.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

/** Make a stage inside `container` (it fills the container). Throws FirstlightUnsupportedError,
 * after showing a message in the container, when the device lacks WebGL 2 or float targets. */
export function createStage(container: HTMLElement, opts?: StageOptions): Stage {
  return new Stage(container, opts);
}
