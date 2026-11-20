import {
  ClampToEdgeWrapping,
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

  private draw(renderer: WebGLRenderer, mat: ShaderMaterial, target: WebGLRenderTarget): void {
    this.quad.material = mat;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  dispose(): void {
    for (const t of [this.transmittance, this.multiScattering, this.skyView]) t.dispose();
    for (const m of [this.transmittanceMat, this.multiScatMat, this.skyViewMat]) m.dispose();
    this.quad.dispose();
  }
}
