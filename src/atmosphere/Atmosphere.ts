import {
  ClampToEdgeWrapping,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type IUniform,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { EARTH, type AtmosphereParams } from './params';
import {
  COMMON,
  FULLSCREEN_VERT,
  LOOKUPS,
  LUT_SIZES,
  MULTISCAT_FRAG,
  SKYVIEW_FRAG,
  SKY_IRRADIANCE_FRAG,
  TRANSMITTANCE_FRAG,
} from './glsl';

function lut(w: number, h: number): WebGLRenderTarget {
  return new WebGLRenderTarget(w, h, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  });
}

/** Uniforms every atmosphere-aware shader shares. Values are live references. */
export type AtmosphereUniforms = Record<string, IUniform>;

/**
 * Owns the three Hillaire LUTs. Transmittance and multi-scattering depend only on the
 * atmosphere parameters, so they are built once (and again after setParams). The sky-view
 * LUT depends on the sun and the camera height, so the stage rebuilds it each frame it draws
 * (192x108 texels x 32 samples: well under a millisecond on an integrated GPU).
 */
export class Atmosphere {
  readonly params: AtmosphereParams;
  readonly uniforms: AtmosphereUniforms;
  readonly transmittance = lut(...LUT_SIZES.transmittance);
  readonly multiScattering = lut(...LUT_SIZES.multiScattering);
  readonly skyView = lut(...LUT_SIZES.skyView);
  /** GLSL to prepend to your own shader to use skyLuminance() / integrateScattering(). */
  static readonly glsl = COMMON + LOOKUPS;

  private quad = new FullScreenQuad();
  private transmittanceMat: ShaderMaterial;
  private multiScatMat: ShaderMaterial;
  private skyViewMat: ShaderMaterial;
  private irradianceMat: ShaderMaterial;
  private irradianceTarget = lut(1, 1);
  private irradianceBuf = new Uint16Array(4);
  private staticDirty = true;

  constructor(params: Partial<AtmosphereParams> = {}) {
    this.params = { ...EARTH, ...params };
    this.uniforms = {
      uBottomRadius: { value: 0 },
      uTopRadius: { value: 0 },
      uRayleighScattering: { value: new Vector3() },
      uRayleighScaleHeight: { value: 0 },
      uMieScattering: { value: 0 },
      uMieExtinction: { value: 0 },
      uMieScaleHeight: { value: 0 },
      uMieG: { value: 0 },
      uOzoneAbsorption: { value: new Vector3() },
      uOzoneCenter: { value: 0 },
      uOzoneHalfWidth: { value: 0 },
      uGroundAlbedo: { value: new Vector3() },
      uTransmittanceLut: { value: this.transmittance.texture },
      uMultiScatLut: { value: this.multiScattering.texture },
      uSkyViewLut: { value: this.skyView.texture },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uSunIlluminance: { value: new Vector3(1, 1, 1) },
      uViewRadius: { value: this.params.bottomRadius + 0.002 },
    };
    this.writeParams();
    const make = (frag: string, extra = '') =>
      new ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: COMMON + extra + frag,
        depthTest: false,
        depthWrite: false,
      });
    this.transmittanceMat = make(TRANSMITTANCE_FRAG);
    this.multiScatMat = make(MULTISCAT_FRAG);
    this.skyViewMat = make(SKYVIEW_FRAG, LOOKUPS);
    this.irradianceMat = make(SKY_IRRADIANCE_FRAG, LOOKUPS);
  }

  /** The LUT pass materials (for compiling ahead of the first frame). */
  get materials(): ShaderMaterial[] {
    return [this.transmittanceMat, this.multiScatMat, this.skyViewMat, this.irradianceMat];
  }

  /** Draw LUT pass i once (its first draw is the slow one); used by the stage's staged warm-up. */
  warmDraw(renderer: WebGLRenderer, i: number): void {
    const targets = [this.transmittance, this.multiScattering, this.skyView, this.irradianceTarget];
    const prev = renderer.getRenderTarget();
    this.draw(renderer, this.materials[i], targets[i]);
    renderer.setRenderTarget(prev);
  }

  /** Change atmosphere parameters (e.g. a thicker haze); LUTs rebuild on next update. */
  setParams(p: Partial<AtmosphereParams>): void {
    Object.assign(this.params, p);
    this.writeParams();
    this.staticDirty = true;
  }

  private writeParams(): void {
    const p = this.params;
    const u = this.uniforms;
    u.uBottomRadius.value = p.bottomRadius;
    u.uTopRadius.value = p.topRadius;
    u.uRayleighScattering.value.set(...p.rayleighScattering);
    u.uRayleighScaleHeight.value = p.rayleighScaleHeight;
    u.uMieScattering.value = p.mieScattering;
    u.uMieExtinction.value = p.mieExtinction;
    u.uMieScaleHeight.value = p.mieScaleHeight;
    u.uMieG.value = p.mieG;
    u.uOzoneAbsorption.value.set(...p.ozoneAbsorption);
    u.uOzoneCenter.value = p.ozoneCenter;
    u.uOzoneHalfWidth.value = p.ozoneHalfWidth;
    u.uGroundAlbedo.value.set(...p.groundAlbedo);
  }

  /** Rebuild whatever is stale. viewRadiusKm is the camera's distance from the planet centre. */
  update(renderer: WebGLRenderer, viewRadiusKm: number): void {
    const prev = renderer.getRenderTarget();
    if (this.staticDirty) {
      this.draw(renderer, this.transmittanceMat, this.transmittance);
      this.draw(renderer, this.multiScatMat, this.multiScattering);
      this.staticDirty = false;
    }
    this.uniforms.uViewRadius.value = Math.min(
      Math.max(viewRadiusKm, this.params.bottomRadius + 0.001),
      this.params.topRadius - 0.01,
    );
    this.draw(renderer, this.skyViewMat, this.skyView);
    renderer.setRenderTarget(prev);
  }

  /**
   * Horizontal sky illuminance at the camera, per unit of sun illuminance (so multiply by the
   * sun's lux). Uses the current sky-view LUT; call after update(). Reads one pixel back from
   * the GPU, which waits for the GPU to finish: call it only when the sun or altitude changed.
   * Luminance is taken as Rec. 709 Y of the RGB channels (an approximation: our channels are
   * 680/550/440 nm samples, not sRGB primaries).
   */
  measureSkyIrradiance(renderer: WebGLRenderer): number {
    this.drawIrradiance(renderer);
    renderer.readRenderTargetPixels(this.irradianceTarget, 0, 0, 1, 1, this.irradianceBuf);
    return this.decodeIrradiance();
  }

  /** As measureSkyIrradiance, but without stalling: the GPU result arrives a frame or so later. */
  async measureSkyIrradianceAsync(renderer: WebGLRenderer): Promise<number> {
    this.drawIrradiance(renderer);
    const scale = (this.uniforms.uSunIlluminance.value as Vector3).y || 1;
    await renderer.readRenderTargetPixelsAsync(this.irradianceTarget, 0, 0, 1, 1, this.irradianceBuf);
    return this.decodeIrradiance(scale);
  }

  private drawIrradiance(renderer: WebGLRenderer): void {
    const prev = renderer.getRenderTarget();
    this.draw(renderer, this.irradianceMat, this.irradianceTarget);
    renderer.setRenderTarget(prev);
  }

  private decodeIrradiance(scale = (this.uniforms.uSunIlluminance.value as Vector3).y || 1): number {
    const [r, g, b] = [0, 1, 2].map((i) => DataUtils.fromHalfFloat(this.irradianceBuf[i]));
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / scale;
  }

  private draw(renderer: WebGLRenderer, mat: ShaderMaterial, target: WebGLRenderTarget): void {
    this.quad.material = mat;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  dispose(): void {
    for (const t of [this.transmittance, this.multiScattering, this.skyView, this.irradianceTarget]) t.dispose();
    for (const m of [this.transmittanceMat, this.multiScatMat, this.skyViewMat, this.irradianceMat]) m.dispose();
    this.quad.dispose();
  }
}
