# Prompt log

## 2026-11-19: build v1 from the spec

1. "full 3d graphics library that can make extremely novel high fiedelity graphics by looking at the SOTA reseach: build this project. Read full 3d graphics library that can make extremely novel high fiedelity graphics by looking at the SOTA reseach.md in this folder and build what it describes, following its META-INSTRUCTIONS exactly."
   → Read the spec. Found three earlier graphics projects (GraphicsLibrary, beautiful_viz, 3d_viz) and pushed back on building a fourth.
   Settled in the question widget: a TypeScript library on three.js; ES module import; win condition "a cinematic scene in ~30 lines".

2. Answers to the second round: all four first uses (robotics viewer, worlds, science, portfolio hero); v1 module sky and atmosphere; public repo plus Pages demo; calm daylight.
   → Scope narrowed to the core plus the Hillaire sky.

3. "look at cs184 from berkeley for concepts"
   → Read the CS184 Fall 2026 syllabus. Modules are now mapped to its lectures (docs/CONCEPTS.md).
   Third round: write Hillaire 2020 ourselves, CS184 as a concept map with citations, an alpine valley demo, the name Firstlight.

4. Done criteria accepted as written.
   → Built v1: atmosphere (CPU reference + GPU LUTs), stage, terrain, demo, hello, self-check, docs.

5. "Push, MIT license"
   → Added an MIT LICENSE and a GitHub Actions workflow (typecheck, test, build, deploy to Pages). Created the public repo amalmehta/Firstlight and pushed main.

6. "*spend another 30 minutes doing deep deep research"
   → Four parallel literature passes (sky/clouds, GI/path tracing, splats, materials/terrain/WebGPU). Package and API claims were rechecked locally. Ranked roadmap in docs/RESEARCH.md; nothing built from it yet.

7. "Yes, build item 1"
   → Photometric units and a physical camera: lux and cd/m², EV100, an auto incident meter (asynchronous GPU sky readback), Sunny 16 mode, compensation slider, meter readout. Photometry tests and self-check rows. Found that terrain-shadowed in-scattering is missing; logged as a proposal.

8. "Yes, fix the haze"
   → Terrain-shadowed single scattering in the aerial volume: shaded far ridges lose their false glow (pixel 111→85), +0.8 ms, noon unchanged. The near-floor flatness turned out not to be haze (it is sky-only light; AO would help). Fixed a stale-meter race in the self-check with stage.settle().

9. "Yes, add GTAO"
   → GTAO via three's GTAOPass, applied to indirect light only through a material patch. Tuned by inspecting the AO buffer and GPU timer queries: radius 10 m, 0.35 resolution, 12/16 samples, +0.6 ms. Found that screen-space AO can't do terrain-scale occlusion; proposed a baked terrain sky-view factor.

10. "Yes, sky-view factor"
   → Terrain sky occlusion: CPU reference tested against closed forms, GPU bake (8.2 ms once) matching it to 0.002, applied to indirect light with a 35% bounce estimate. The visible effect is small in this open valley (−1%). Fixed a render-target clone bug. Flagged that the absolute frame-time claim is marginal.

11. "Yes, erosion filter"
   → Independent implementation of the stripe-based erosion filter, iterated with top-down debug images and side-by-side views (900 m / 40 m). Terrain build moved to a Web Worker (Terrain.load) because it blocked the main thread for 2–4 s. heightAt now matches the mesh. Lit ground replaces the dark void below the horizon while terrain loads.
