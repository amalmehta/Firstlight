# Concepts: from CS184 to the papers

Firstlight is organised around Berkeley's CS184/284A *Foundations of Computer Graphics*
(Fall 2026 syllabus, cs184.eecs.berkeley.edu/fa26). Each module rests on a lecture and
goes one step past it with a published technique. This page is the map; the code comments
carry the details.

| CS184 lecture | The idea in plain words | Where it lives | The step past the course |
|---|---|---|---|
| Sampling and Aliasing | A pixel is a sample, not a little square; patterns finer than two pixels turn into noise or moiré. | MSAA ×4 HDR target; terrain detail fades with distance before it can alias | — |
| Transforms, Perspective Projection | Matrices take points between spaces; the inverse view-projection turns a pixel back into a ray. | `viewDir()` in `stage/shaders.ts`; depth → world position in the composite | — |
| Hidden Surface Removal | The depth buffer keeps the nearest surface. We also *read* it, to know how much air is in front of each pixel. | float depth texture in `Stage` | Aerial perspective needs distance, so depth becomes data |
| Texture Mapping | A texture is a function you sample, with filtering between texels. | The three atmosphere LUTs; the terrain height and sun-visibility textures | Bruneton 2017 non-linear LUT parametrisations |
| Shading, Materials | BRDFs: how much light a surface sends towards the eye. | three's `MeshStandardMaterial` (GGX microfacet); `Terrain` albedos | Image-based lighting from our own sky (cube → PMREM) |
| Meshes | A surface as triangles; normals from neighbouring faces. | `Terrain` (512² grid, `computeVertexNormals`) plus per-pixel bump | Ridged multifractal noise (Musgrave) |
| Ray Tracing and Acceleration | Intersect rays with geometry. | `raySphere()` for planet and atmosphere; heightfield march for terrain shadows | Soft heightfield shadows (Quilez penumbra) |
| Radiometry | Radiance, irradiance, and how light is measured. | `params.ts`, `reference.ts` | Hillaire 2020 participating medium: Rayleigh, Mie, ozone |
| Monte Carlo Integration | Estimate an integral by averaging samples. | Ray-marching optical depth and in-scattering (deterministic quadrature) | Hillaire's 64-direction multiple-scattering estimate |
| Global Illumination & Path Tracing | Light bounces; the rendering equation (Kajiya 1986). | Multiple-scattering LUT: infinite bounces as a geometric series 1/(1 − f) | Hillaire 2020 §5.5 |
| Color and Perception | Spectra → RGB; the eye compresses huge brightness ranges. | Exposure + AgX tone mapping + sRGB output | AgX (Sobotka), via Blender → Filament → three |
| Animation | Motion over time. | Eased camera reset; render-on-demand loop | — |

## The equations that matter

**Transmittance.** What fraction of light survives a path of length *d* through the air:

> T = exp(−∫₀ᵈ σₜ(s) ds)

- *T*: transmittance, 0 to 1, no unit
- *σₜ*: extinction coefficient, 1/km (Rayleigh + Mie + ozone, each scaled by its density profile)
- *s*: distance along the path, km

Every kilometre removes a fraction of the light, so losses multiply, and multiplying many
factors close to 1 is an exponential of a sum.

**Multiple scattering (Hillaire 2020, Eq. 9).** If a fraction *f* of light scatters again
after each event, the total over all bounces is a geometric series:

> F = 1 + f + f² + … = 1 / (1 − f)

**Rayleigh's λ⁻⁴.** Scattering grows as the inverse fourth power of wavelength:
(680 / 440)⁴ ≈ 5.7, so blue scatters about 5.7× more than red. That's why the sky is
blue and a low sun, seen through roughly 20 times more air, is orange.

The demo's "How this works" panel shows the transmittance equation typeset (MathML), with
symbols defined beneath.

## Reusable principle

When a scene looks fake, look for two parts that were tuned separately but describe the same
physical thing (a sky picture and a light colour; fog and the sky's horizon). Derive both from
one model, and they will agree under every condition you didn't test.

## References

- S. Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique", EGSR 2020. https://sebh.github.io/publications/egsr2020.pdf; code: https://github.com/sebh/UnrealEngineSkyAtmosphere
- E. Bruneton, Precomputed Atmospheric Scattering (2017 revision). https://github.com/ebruneton/precomputed_atmospheric_scattering
- A. Bucholtz, "Rayleigh-scattering calculations for the terrestrial atmosphere", Applied Optics 34(15), 1995. https://opg.optica.org/abstract.cfm?URI=ao-34-15-2765
- J. Kajiya, "The Rendering Equation", SIGGRAPH 1986.
- K. Perlin, "Improving Noise", SIGGRAPH 2002. F. K. Musgrave, ridged multifractals, in *Texturing & Modeling: A Procedural Approach*.
- I. Quilez, "Soft shadows in raymarched SDFs" (penumbra estimate k·h/t). https://iquilezles.org/articles/rmshadows/
- T. Sobotka, AgX. https://github.com/sobotka/AgX; three.js implementation notes in `tonemapping_pars_fragment.glsl.js`.
- UC Berkeley CS184/284A, Fall 2026. https://cs184.eecs.berkeley.edu/fa26
