# File structure

```
index.html                 Demo page (alpine valley, sun controls, settings, feedback)
demo/main.ts               Demo logic: scene, controls, preferences, shortcuts
demo/style.css             Demo look: warm light / quiet dark, opening animation
examples/hello.html        Smallest complete scene (13 lines)
examples/selfcheck.html/ts GPU checks: LUT vs CPU, Bucholtz, sunset, WebGL errors
public/icon.svg, icon-180.png  App icon (favicon, touch icon, header mark)

src/index.ts               Public API
src/atmosphere/
  params.ts                Earth constants with sources (Hillaire 2020, Bruneton)
  reference.ts             CPU reference: optical depth, transmittance, sun colour, LUT mapping
  glsl.ts                  GLSL: medium, LUT passes (transmittance, multi-scattering, sky-view), lookups
  Atmosphere.ts            Owns and updates the LUT render targets
src/camera/
  photometry.ts            Lux, cd/m², EV100, incident meter, exposure scale (with sources)
src/stage/
  Stage.ts                 createStage: renderer, HDR target, camera, controls, sun, environment,
                           froxel aerial perspective, composite, on-demand loop, snapshot, benchmark
  shaders.ts               Sky background, environment cube, aerial volume, composite
  ambientOcclusion.ts      GTAO computed via three's GTAOPass, applied to indirect light only
src/terrain/
  noise.ts                 Seeded gradient noise, fBm, ridged multifractal
  build.ts                 Pure terrain build: heights, erosion, normals, colours, mesh arrays
  erosion.ts               Erosion filter (stripe gullies along the slope)
  terrainWorker.ts         Runs build.ts in a Web Worker for Terrain.load()
  skyView.ts               Sky-view factor and relative sky occlusion (CPU reference, tested)
  Terrain.ts               Valley heightfield, albedo by slope and height, per-pixel detail,
                           baked sun visibility (also applied to your materials)

tests/atmosphere.test.ts   Physics checks against Bucholtz 1995 and integration accuracy
tests/photometry.test.ts Sunny 16, meter vs camera, grey-card exposure
tests/erosion.test.ts    Gullies run downhill, flat stays flat, determinism, mesh arrays
tests/skyView.test.ts    SVF closed forms: pit cos²h, wall ½, tilted plane, open slopes
tests/terrain.test.ts      Determinism, ranges, mesh vs heightAt

docs/                      README links: instructions, system design, concepts, viz log, prompts
```

The spec this was built from is the long-named `.md` file at the root, with `CLAUDE.md` and
`Shortcuts.md` beside it.
