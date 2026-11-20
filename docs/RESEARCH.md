# Research: what to build next (state of the art, checked 2026-11-19)

**The short answer.** First, put Firstlight on real light units with a physical camera
(EV100). It costs about 0 ms and roughly 150 lines, and clouds, night sky, path tracing and
splat relighting all need it. Second, add an erosion filter to the terrain, the biggest
visible jump per line of code. Third, add volumetric clouds, the biggest new feature, already
proven possible in WebGL2 by another three.js library. Hold the WebGPU port until a
measurement says it pays off.

How this was done: four parallel literature passes (sky and clouds; global illumination
and path tracing; Gaussian splats; materials, terrain and WebGPU), reading primary sources.
Package and API claims were then rechecked here against the npm registry and the installed
three r187 (see "Verified locally"). Anything not confirmed is marked *unverified*. Costs
are the authors' published numbers on their hardware, not Firstlight measurements.

## Ranked candidates

Ranked by visible gain for the "cinematic scene in about 30 lines" goal, divided by effort,
with dependencies first.

### 1. Photometric units and a physical camera (EV100) — built 2026-11-19
- **Status.** Built; see SYSTEM-DESIGN.md. The measured values are in VIZ-LOG.md.
- **What.** Hillaire's tables are built with sun illuminance = 1, so they are transfer
  functions. Multiply by the sun's illuminance in lux and you get luminance in cd/m². Then
  expose like a camera: EV100 from aperture, shutter and ISO, and exposure = 1 / (1.2 · 2^EV100).
- **Evidence.**
  - Hillaire 2020, Eq. 6 and §5.5: https://sebh.github.io/publications/egsr2020.pdf
  - Unreal's physical lighting units: https://dev.epicgames.com/documentation/en-us/unreal-engine/using-physical-lighting-units-in-unreal-engine
  - Frostbite's reference values: sun about 100,000 lux, checked with the Sunny-16 rule, in Lagarde & de Rousiers 2014. The exposure formula was read in Unity's port of it; the original notes are *unverified*.
- **Cost.** About 0 ms; about 150 lines.
- **WebGL2.** Yes. Pre-expose before writing to the half-float target, because the range runs from about 10⁵ lux down to 10⁻³ lux.
- **Check.**
  - A unit test that EV100(f/16, 1/125 s, ISO 100) ≈ 15. By hand: log₂(16² × 125) = 14.97.
  - A noon render at Sunny-16 settings should put an 18% grey card at mid-grey.
- **Why first.** Purkinje shift (night), clouds, path tracing and splat relighting all need absolute luminance.

### 2. Terrain erosion filter — built 2026-11-19 (independent implementation; see VIZ-LOG.md)
- **What.** Rune Skovbo Johansen's "Advanced Terrain Erosion Filter" (March 2026). It is
  evaluated per point, with no simulation, and gives branching gullies and sharp ridges plus
  approximate derivatives.
  - Blog: https://blog.runevision.com/2026/03/
  - Shader (MPL-2.0): https://www.shadertoy.com/view/wXcfWn
- **Alternatives.**
  - Lague's droplet erosion (MIT), as a CPU pass at mesh build.
  - Stream-power erosion (Schott et al., TOG 2023).
- **Cost.** A few hundred lines (estimate). Apply it to the vertex heights, and per pixel for normals and colour masks, because the 39 m grid can't hold small gullies.
- **Risk.** The author says its derivatives are approximate and that some drainage lines don't reach the lowest point. It is not a physical simulation.
- **Check.** Fixed-camera before/after screenshots and a slope histogram.

### 3. Ambient occlusion: GTAO — built 2026-11-19 (indirect-only, see VIZ-LOG.md)
- **What.** Ground-truth AO: horizon-based occlusion with specular occlusion (Jimenez et al. 2016,
  https://www.iryoku.com/downloads/Practical-Realtime-Strategies-for-Accurate-Indirect-Occlusion.pdf).
  The paper matches ray-traced AO in 0.5 ms on a PS4 at 1080p, at half resolution.
- **Already available.** `GTAOPass` ships in three r187 (WebGL). N8AO 2.1 (CC0) claims about 0.7 ms at 1080p and accumulates while the camera is still, which suits render-on-demand. That figure is the author's.
- **Risk.** Screen-space only. It darkens the sky-lit ambient light where it should; it adds no bounce light.
- **Check.** Compare against path-traced AO from candidate 6.

### 4. Volumetric clouds (Nubis and Frostbite lineage) — built 2026-11-19 (see VIZ-LOG.md)
- **Status.** Built: weather map + Perlin-Worley/Worley noise, Jendersie & d'Eon 2023 phase
  function, Frostbite step integration, octaves *refitted* against a path tracer (the quoted
  ½ values were 2.5–6× too dark), half/third-resolution march with depth-aware upsampling,
  cloud shadow map for ground, objects, haze and the exposure meter. Not built: temporal
  upscaling, distance-field empty-space skipping, clouds in the environment map.
- **What.**
  - Density from a weather map plus 3D noise.
  - Frostbite's energy-conserving step integration.
  - Multiple-scattering octaves after Wrenninge (Oz): N = 8, a = b = c = ½. Frostbite adds that a ≤ b keeps energy conserved.
  - Beer shadow maps.
  - Empty-space skipping on a coarse distance field (Nubis³).
  - The clouds would read the sky tables Firstlight already exposes, which is why those tables are public.
- **Evidence.**
  - Frostbite: 0.91 ms at 720p on Xbox One at half resolution (Hillaire, SIGGRAPH 2016 course, Table 4).
  - Nubis Evolved, distance-field marching: 4.2 ms → 1.3 ms (SIGGRAPH 2022 Advances).
  - Nubis³: 10 ms → 2.2 ms (SIGGRAPH 2023 Advances).
- **Proof it runs in WebGL2.** `@takram/three-clouds` does this in fragment shaders. It reports 92–95 fps at 4K on an M3 Max with temporal upscaling, versus 31 fps without (author's numbers).
- **Cost.** About 2–4k lines (estimate). The largest item on this list.
- **Risks.** Ghosting from temporal upscaling. Aerial perspective through partially transparent cloud. Takram reports both.
- **Check.** A path-traced reference cloud (Mitsuba or PBRT) on the same density field, and timings at 1080p.

### 5. Captured scenes: Gaussian splats via Spark
- **What.** `@sparkjsdev/spark` 2.4.0 (MIT, needs three ≥0.180; verified on npm).
  - It loads PLY, SPZ, SPLAT, KSPLAT and SOG.
  - 2.x adds LOD, streaming and per-splat modifiers.
  - Splats don't write depth by default.
- **Integration.**
  - Apply aerial perspective per splat, inside Spark's modifier, at each splat's distance. Exclude splat pixels from the depth-based composite.
  - The honest relighting available today: scale colour by (sky irradiance now) / (estimated capture irradiance), and multiply by the baked terrain sun visibility.
- **Limit.** I found no browser implementation of physically based relightable splats.
  - Relightable 3D Gaussians (https://arxiv.org/abs/2311.16043) and GS-IR (https://arxiv.org/abs/2311.16473) need offline CUDA training.
  - The relighting ratio above is a heuristic. No paper validates it.
- **Licences.** The original 3DGS code is for non-commercial use only. TRELLIS and LGM (photo/text → splats) are MIT but need a 10–16 GB NVIDIA GPU.
- **Check.** A splat and a grey proxy mesh at 1, 5 and 20 km should get the same haze. Compare at three sun angles.

### 6. "Settle to photoreal" when the camera stops
- **What.** three-gpu-pathtracer 0.0.28 (2026-11-02; needs three ≥0.187 and three-mesh-bvh; verified on npm).
  - It waits until the camera stops, accumulates samples, and fades over the raster frame.
  - It has multiple importance sampling and environment importance sampling.
- **Why it fits.** Firstlight already renders on demand, so "camera stopped" is one hook.
- **Catches.**
  - The README now says the project requires WebGPU. The WebGL path still ships in the tarball but is undocumented.
  - Denoising (OIDN) is WebGPU-only.
  - The sky must be passed as an equirect map and re-captured when the sun moves.
  - Custom shader materials aren't supported.
  - A 524k-triangle terrain BVH is a risk.
- **Check.** Compare the converged frame with raster using SSIM or FLIP. Use it as the ground truth for #3 and #4.

### 7. Terrain materials and LOD
- **Textures.** Hex-tiling (Mikkelsen, JCGT 2022: three texture taps, no precompute; https://jcgt.org/published/0011/03/05/paper.pdf), triplanar projection on steep slopes, and height-blended splatting. About 150–300 lines plus texture assets and their licences.
- **Geometry.** CDLOD (Strugar 2009) lifts the 39 m limit so erosion detail shows in silhouettes. About 400–600 lines.

## Found while building #1
- **Terrain-shadowed in-scattering — built 2026-11-19** (see VIZ-LOG.md). In the froxel pass, scale single scattering by the
  terrain's sun visibility at each sample (a heightfield march toward the sun at the volume's
  32³ resolution: roughly 32 768 texels × slices × about 12 steps per frame). Without it, air in
  a ridge's shadow glows, and a shaded valley at golden hour looks foggy. This is also the
  basis for "god rays" through ridges.

- **Terrain sky-view factor — built 2026-11-19** (see VIZ-LOG.md). Bake, per grid texel, the fraction of sky the surrounding terrain
  leaves open (horizon angles in 8–16 directions). Like the sun-visibility bake, but it
  doesn't depend on the sun, so it's baked once. It covers the valley- and gully-scale
  skylight occlusion that GTAO can't see at distance.

## Later, or gated on a measurement
- **WebGPU port.**
  - Safari 26, Chrome and Firefox (Windows and Apple Silicon) ship WebGPU on by default.
  - Several things are WebGPU-only in three r187: `TRAANode`, `TAAUNode`, `SSGINode` and `VXGIVolume` (verified in the installed package).
  - Users report about 2× CPU per frame on many-mesh scenes (r183). That is not an official number, and Firstlight draws few meshes.
  - **Gate:** port only after a side-by-side frame-time measurement of this scene.
- **Diffuse bounce light.** `LightProbeGridWebGL` (L2 spherical-harmonics probes, in r187, WebGL) re-baked when the sun moves. Speedball GI 0.8 claims a WebGL2 fallback, but that is *unverified*.
- **Night.**
  - Purkinje shift: Patry, SIGGRAPH 2021 Advances, which gives explicit constants. It needs #1.
  - Moon and stars: Jensen et al. 2001.
- **Vegetation.** Octahedral impostors (a three.js 200k-tree demo, 2025, described as work in progress) and instanced grass. The most code of anything here, about 1–2k lines plus assets.
- **Accuracy work.**
  - Mie-theory aerosols (Schneegans et al., EG 2024). They were built on Bruneton's model, and porting to Hillaire's is an open question.
  - A spectral validation harness using the Prague sky model (Wilkie 2021) through colour-science, run offline. The full model is 2.4 GB, too big to ship.

## Not recommended now
- **Neural appearance models and neural texture compression** (NVIDIA 2023). They need tensor-core matrix intrinsics, and I found no web demonstration. WebGPU subgroups exist, but I found no evidence of cooperative-matrix support.
- **ReSTIR (DI, GI, PT).** One WebGPU demo (Web-RTRT, 2024) with no timings; no maintained library.
- **Lumen-, GIBS- or DDGI-style ray-traced GI.** They assume hardware ray tracing.

## Where the research disagreed with us
- **Transmittance steps.** The sky literature says the paper's 40 steps are enough. Our test shows 40 steps misses zenith optical depth by 1.7%, so we keep 128; the table is built once, so the cost is one-off.
- **Paper vs code.** Hillaire's paper and code disagree on Mie absorption and ground albedo; see `src/atmosphere/params.ts`.

## Verified locally (2026-11-19)
- `GTAOPass`, `LightProbeGridWebGL`, `LightProbeGrid`, `LightMapper`, `VXGIVolume` ("can only be used with WebGPURenderer"), `SSGINode`, `TRAANode`, `TAAUNode`, `GTAONode` and `DenoiseNode` all exist in the installed three@0.187.0.
- `@sparkjsdev/spark@2.4.0`: MIT, peer dependency three ≥0.180.0.
- `three-gpu-pathtracer@0.0.28`: peer dependencies three ≥0.187.0, three-mesh-bvh ≥0.9.17, xatlas-web.

## Unverified (needs a primary source or a measurement)
- The EV100 formula in the original Frostbite notes.
- Ghost of Tsushima grass timings.
- Real GPU cost of `SSGINode`, VXGI and Speedball.
- Path tracer convergence time on this scene.
- PlayCanvas splat depth behaviour.
- WebGPURenderer performance in r187.
- All line-count estimates.
