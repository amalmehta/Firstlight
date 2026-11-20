# Firstlight

Physically based sky, sun and haze for three.js. One atmosphere model lights the whole
scene, so the sky, the sun's colour, the ambient light and the distance haze always agree.

**[Open the live demo →](https://amalmehta.github.io/Firstlight/)**

![An alpine valley in afternoon light: a steel sphere and a stone pillar on a meadow, ridges fading blue with distance](docs/images/demo-light.jpg)

![The same valley at a 6° sun, in dark mode: the floor in the ridges' shadow, alpenglow on the peaks](docs/images/demo-dark-golden.jpg)

```js
import { createStage, Terrain } from 'firstlight';

const terrain = new Terrain({ seed: 7 });
const stage = createStage(document.body, {
  sun: { elevation: 22, azimuth: 290 },
  camera: { position: [-30, terrain.heightAt(-30, 60) + 8, 60], target: [0, terrain.heightAt(0, 0) + 5, 0] },
});
stage.add(terrain, myMesh); // any three.js object; it is lit, shadowed and hazed like the rest
```

| What | Measured |
|---|---|
| GPU transmittance LUT vs CPU reference | 0.14% max error (threshold 1%) |
| Sea-level Rayleigh depth vs Bucholtz 1995 | +9% to +13% (the standard coefficients run high; labeled) |
| Orbit frame cost, 1920×1200, Apple GPU in the app's browser | ≈13.7 ms net (budget 16.7 ms) |

**[Instructions](docs/INSTRUCTIONS.md)** · [System design](docs/SYSTEM-DESIGN.md) ·
[Concepts (CS184 → papers)](docs/CONCEPTS.md) · [Viz log](docs/VIZ-LOG.md) ·
[File structure](docs/FILE-STRUCTURE.md) · [Prompt log](docs/PROMPTS.md) · MIT license
