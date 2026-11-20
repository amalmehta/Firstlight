# Instructions

## Run it

```bash
npm install
```

```bash
npm run dev
```

Then open:
- http://localhost:5173/ for the demo (an alpine valley with sun controls)
- http://localhost:5173/examples/hello.html for the smallest complete scene (13 lines)
- http://localhost:5173/examples/selfcheck.html for the GPU checks against the CPU reference and published values

```bash
npm test          # CPU atmosphere + terrain tests (Vitest)
npm run typecheck
npm run build     # static site in dist/, ready for GitHub Pages
```

## Use it in another project

Until it is published to npm, import it by path (Vite resolves the TypeScript directly):

```js
import { createStage, Terrain } from '../Firstlight/src/index.ts';
```

`three@0.187.0` is a peer dependency: your project provides it.

### The API in one screen

| Call | What it does |
|---|---|
| `createStage(container, opts)` | Renderer, camera, orbit controls, sky, sun. Fills the container and renders on demand. |
| `stage.add(...objects)` | Adds any three.js objects. A `Terrain` also keeps the camera above ground and shadows every lit material. |
| `stage.setSun({ elevation, azimuth })` | Degrees above the horizon; degrees clockwise from north (−z). |
| `stage.setExposure(mode)` | `'auto'` (default: an incident light meter at the camera), a fixed EV100 number, or `{ aperture, shutter, iso }`. |
| `stage.setExposureCompensation(stops)` | Brighter (+) or darker (−) than the exposure gives. |
| `stage.getExposure()` | EV100 used, metered lux (total and from the sky), equivalent camera settings. |
| `stage.setSunIlluminance(lux)` | Sun above the atmosphere; Earth is 133 800 lux. |
| `await stage.ready` | Shaders have compiled (in parallel); frames start after this. |
| `stage.onRender(fn)` | Run after each drawn frame (for readouts). |
| `await stage.settle()` | Wait until added objects are in the scene and the exposure meter has caught up. `add()` inserts objects once their shaders have compiled. |
| `ambientOcclusion` option / `stage.setAmbientOcclusion(on)` | GTAO on indirect light only (default on, about +0.6 ms). Options: `{ radius, resolution, samples }`. |
| `terrain.setSkyOcclusion(on)` | Terrain sky-view factor on indirect light (default on; baked once). |
| `shadowedHaze` option | Terrain shadows the haze (default on, about +0.8 ms). |
| `stage.invalidate({ shadows? })` | Ask for a frame after you change something yourself. |
| `stage.loop((dt, t) => …)` | Opt into continuous animation (pass `null` to stop). |
| `stage.resetCamera()` | Also bound to double-click and R. |
| `stage.snapshot()` | PNG `Blob` of the current frame. |
| `stage.benchmark(3)` | Orbits for 3 s and reports median and p95 frame intervals. Needs a visible tab. |
| `await Terrain.load({ size, segments, height, snowLine, seed, erosion })` | Procedural eroded valley, built in a Web Worker; `terrain.heightAt(x, z)` places things on the ground. `new Terrain(opts)` builds synchronously (blocks ~3 s at the default size). |
| `erosion` option | `false` to turn off, or `{ spacing, depth, octaves, fullSlope, minSlope, seed }`. |
| `stage.setView({ position, target }, { home })` | Move the camera; with `home: true`, also where Reset returns. |
| `new Atmosphere(params)` / `EARTH` | The Hillaire 2020 model; pass `atmosphere: { mieScattering: 0.02 }` to `createStage` for a hazy day. |
| `Atmosphere.glsl` | GLSL with `skyLuminance()` and `integrateScattering()` for your own shaders. |

Units: metres in the scene, kilometres inside the atmosphere. Light is photometric: lux for
illuminance, cd/m² for luminance, exposure in EV100. Values are pre-exposed (multiplied by
the camera's exposure) before they reach the half-float buffers. `photometry` exports the
formulas (`ev100FromCamera`, `ev100FromIlluminance`, `exposureScale`).

## Add a module (path tracing, splats, clouds…)

Read [SYSTEM-DESIGN.md](SYSTEM-DESIGN.md), "Next ten steps". The hooks they need are the
public LUT textures (`stage.atmosphere.transmittance / multiScattering / skyView`), the HDR
target with depth, and the single render loop.

## Manual review checklist

Automated tests can't check these. Walk through them on the real machine with the
browser window **visible** (hidden tabs throttle animation to about 1 frame per second).

- [ ] **Feel:** dragging the sun slider updates the sky within a frame; no stutter while orbiting.
- [ ] **Frame rate:** Settings (⌘,) → Measure: median ≤ 16.7 ms at Balanced quality.
- [ ] **Opening:** the mark springs in and the panel eases up once, in under a second; with Reduce Motion on (System Settings → Accessibility → Display) it is a plain fade.
- [ ] **Taste:** the default view reads as a calm afternoon; golden hour (sun below 6°) shows alpenglow on the peaks.
- [ ] **Dark mode:** panel, dialog and feedback tab are readable in both themes; the theme setting overrides the system.
- [ ] **Phone width:** the controls sit in a bottom sheet; no sideways scroll.
- [ ] **Save image:** S or the button downloads a PNG of the current view.
- [ ] **Privacy:** nothing leaves the device. The only network requests are the page itself and Google Fonts (check in the Network tab).
- [ ] **Unsupported device:** in a browser with WebGL disabled, a plain message replaces the scene.
- [ ] **Self-check page:** every row passes.
- [ ] **Metering:** the readout under the sliders reads about EV 15 with the sun at 60°; Settings → Metering → Sunny 16 turns dusk nearly black while Auto keeps it visible.
