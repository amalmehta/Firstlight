/**
 * Screen-space ambient occlusion that dims only *indirect* light.
 *
 * GTAO (Jimenez et al. 2016, "Practical Real-Time Strategies for Accurate Indirect Occlusion")
 * estimates, per pixel, how much of the sky hemisphere nearby geometry hides. Think of standing
 * in a narrow gully: the sky overhead is a thinner strip, so less skylight reaches you, but the
 * sun, if it shines in, is just as bright.
 *
 * three's GTAOPass computes it (normal + depth G-buffer at half resolution, GTAO, Poisson
 * denoise). Its usual output multiplies the whole image, which also darkens sunlit creases;
 * instead we take the denoised AO texture and patch every lit material so it scales only
 * indirect diffuse and (via three's computeSpecularOcclusion, Lagarde 2014) indirect specular.
 */
import { Vector2, type Camera, type Material, type Object3D, type Scene, type WebGLRenderer } from 'three';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';

export interface AOOptions {
  /**
   * World-space radius, metres. Default 10: grounds objects (contact occlusion) and catches
   * metre-scale creases. Screen-space AO can't see terrain-scale (100 m+) occlusion far away:
   * its search is capped in pixels. A baked terrain sky-view factor would cover that.
   */
  radius?: number;
  /** Resolution relative to the frame. Default 0.35: measured +0.24 ms GPU at 1920×1200 (vs +3 ms at 0.5). */
  resolution?: number;
  /** GTAO samples per pixel. Default 12 (8 left visible grain at 0.35 resolution). */
  samples?: number;
}

const INDIRECT_AO = /* glsl */ `
{
  float flAO = mix(1.0, texture2D(uFlAO, gl_FragCoord.xy * uFlAOInvSize).r, uFlAOOn);
  reflectedLight.indirectDiffuse *= flAO;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float flNV = saturate(dot(geometryNormal, geometryViewDir));
    reflectedLight.indirectSpecular *= computeSpecularOcclusion(flNV, flAO, material.roughness);
  #endif
}
`;

export class ScreenAO {
  readonly uniforms = {
    uFlAO: { value: null as unknown },
    uFlAOInvSize: { value: new Vector2(1, 1) },
    uFlAOOn: { value: 1 },
  };
  private pass: GTAOPass;
  resolution: number;
  enabled = true;

  constructor(scene: Scene, camera: Camera, opts: AOOptions = {}) {
    this.resolution = opts.resolution ?? 0.35;
    this.pass = new GTAOPass(scene, camera, 2, 2);
    this.pass.updateGtaoMaterial({
      radius: opts.radius ?? 10,
      distanceExponent: 1,
      thickness: 10,
      distanceFallOff: 1,
      scale: 1.2,
      samples: opts.samples ?? 12,
    });
    // Poisson denoise: 16 samples over 2 rings (three's default; fewer left grain).
    this.pass.updatePdMaterial({ samples: 16, rings: 2 });
    this.pass.output = GTAOPass.OUTPUT.Off;
    this.uniforms.uFlAO.value = this.pass.pdRenderTarget.texture;
  }

  /** GTAO's internal materials (for compiling ahead of the first frame). */
  get materials(): Material[] {
    const p = this.pass as unknown as { gtaoMaterial: Material; pdMaterial: Material; normalMaterial: Material };
    return [p.gtaoMaterial, p.pdMaterial, p.normalMaterial];
  }

  /** frameWidth/Height: the HDR target's size in pixels. */
  setSize(frameWidth: number, frameHeight: number): void {
    this.pass.setSize(
      Math.max(1, Math.round(frameWidth * this.resolution)),
      Math.max(1, Math.round(frameHeight * this.resolution)),
    );
    this.uniforms.uFlAOInvSize.value.set(1 / frameWidth, 1 / frameHeight);
  }

  /** Compute this frame's AO. `hide` are objects to leave out (e.g. the full-screen sky). */
  update(renderer: WebGLRenderer, hide: Object3D[]): void {
    this.uniforms.uFlAOOn.value = this.enabled ? 1 : 0;
    if (!this.enabled) return;
    const vis = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    const prev = renderer.getRenderTarget();
    const auto = renderer.shadowMap.autoUpdate;
    const needs = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.autoUpdate = false; // the G-buffer pass must not consume a shadow refresh
    renderer.shadowMap.needsUpdate = false;
    this.pass.render(renderer, null as never, null as never, 0, false);
    renderer.shadowMap.autoUpdate = auto;
    renderer.shadowMap.needsUpdate = needs;
    renderer.setRenderTarget(prev);
    hide.forEach((o, i) => (o.visible = vis[i]));
  }

  /** Patch a lit material so its indirect light is scaled by the AO. Keeps earlier hooks. */
  apply(material: Material): void {
    const tagged = material as Material & { userData: { firstlightAO?: boolean } };
    if (tagged.userData.firstlightAO) return;
    tagged.userData.firstlightAO = true;
    const prev = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
      prev.call(material, shader, renderer);
      if (!shader.fragmentShader.includes('#include <aomap_fragment>')) return; // unlit
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uFlAO;\nuniform vec2 uFlAOInvSize;\nuniform float uFlAOOn;')
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + INDIRECT_AO);
    };
    material.customProgramCacheKey = () => prevKey.call(material) + '|firstlight-ao';
    material.needsUpdate = true;
  }

  dispose(): void {
    this.pass.dispose();
  }
}
