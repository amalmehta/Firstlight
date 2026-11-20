# Viz log

One entry per graphic: what it shows, why it needs this fidelity, the library, the data,
how it was checked, and what changed.

## Alpine valley demo (index.html), 2026-11-19

- **Shows:** a 20 km procedural valley under Earth's atmosphere, with a mirror-steel sphere
  (sky reflection) and a rough stone pillar (sun, sky light and shadow). The sun's height and
  direction are controls.
- **Why 3D at this fidelity:** the point is light through air over distance: haze that
  grows with range, sun colour that changes with the path length, mountain shadows. A flat
  picture can't show those changing together.
- **Library:** three.js r187 (WebGL2) plus Firstlight's own Hillaire 2020 implementation.
  Chosen over takram's three-atmosphere (Bruneton) so every line is ours to verify and
  extend; see SYSTEM-DESIGN.md.
- **Data:** Earth atmosphere constants from Hillaire 2020 and its code; Rayleigh
  coefficients at 680/550/440 nm (Bruneton). Terrain is procedural (seed 7). Albedos are
  labeled estimates within published ranges. Exposure (6) was chosen by eye.
- **Checked:**
  - **GPU vs CPU:** the transmittance LUT matches the CPU reference to 0.14% (self-check page).
  - **Published values:** Rayleigh optical depth against Bucholtz 1995 (+9% to +13%, documented).
  - **Sunset:** red/blue ratio 54 at 2°.
  - **Speed:** about 13.7 ms net GPU frame while orbiting at 1920×1200. Measured with GPU sync in the app's hidden browser pane, so it is an upper bound; recheck with Settings → Measure in a visible window.
  - **Looks:** screenshots in light and dark mode and at phone width.
- **Changes, in order:**
  1. **Wash-out.** The first render looked washed out. Exposure went from 10 to 6, tone-curve candidates (AgX, PBR Neutral, ACES) were compared side by side, and AgX was kept.
  2. **Flat floor.** The valley floor was a flat khaki. Per-pixel albedo and bump detail were added, fading with distance.
  3. **Dune-like peaks.** The mountains read as sand dunes. Rock was made darker, a conifer belt and a higher snow line were added, and the ridges sharpened.
  4. **Front lighting.** The sun sat behind the camera and lit everything flat. The default moved to side light (290°, 22°).
  5. **Composite cost.** Per-pixel aerial ray-marching took about 8.5 ms. It was replaced with Hillaire's 32³ froxel volume (about 2 ms), and the images matched by eye.
  6. **Shadow edge.** At golden hour, the shadow-map box left a hard edge on the floor. Terrain shadowing became a heightfield march, then a sun-visibility texture baked once per sun move. Every lit material samples that texture, so objects fall into mountain shadow with the ground.
  7. **Shadow map.** The sun's shadow map is cached while orbiting, since it only depends on the sun and the target.

## Alpine valley demo: real light units (2026-11-19)

- **Changed:** light in lux and cd/m², with a physical camera: an Auto incident meter, or Sunny 16 fixed. The slider is now exposure compensation in stops. A readout shows lux at the camera and the camera settings.
- **Checked:** self-check rows for photometry at a 60° sun: direct 99.5 klx, sky 9.1 klx, EV 15.41; EV falls from 15.41 to 13.88 to 11.38 as the sun drops from 60° to 20° to 5°. Seven unit tests cover the formulas.
- **Speed:** orbit ≈14.6 ms net; sun drag ≈17.0 ms net, after making the meter's GPU readback asynchronous (it was ≈20.9 ms synchronous).
- **Found:** a shaded valley looks hazy at low sun because aerial perspective ignores terrain shadows. Logged as a proposal.

## Hello example (examples/hello.html), 2026-11-19

The same stage in 15 lines: terrain plus a steel sphere. It exists to prove the "30 lines"
done criterion and as a copy-paste starting point.

## Self-check (examples/selfcheck.html), 2026-11-19

A table, not a picture: the GPU-dependent done criteria with numbers and thresholds.
