/**
 * Terrain sky-view factor (SVF), irradiance definition.
 *
 * The fraction of isotropic sky irradiance a surface receives once the surrounding terrain
 * hides part of the sky: SVF = (1/π) ∫ V(ω) max(n·ω, 0) dω over the upper hemisphere, where
 * V(ω) = 1 when direction ω is above the terrain horizon. This is the definition Dozier &
 * Frew (1990) use for radiation modelling (see Steger et al. 2022, HORAYZON, GMD 15, for the
 * two definitions in use); it is not the solid-angle "visible sky" used for visualisation
 * (Zakšek et al. 2011).
 *
 * Worked example: a flat surface in a pit whose rim is h = 30° above it all round gets
 * SVF = cos²(30°) = 0.75, so a quarter of its skylight is blocked.
 *
 * The GPU bake (Terrain.ts) does the same sum as `skyViewFactor` below; the CPU version is the
 * reference the tests check against closed forms.
 */
export type Vec3 = [number, number, number];

/**
 * horizons[i]: elevation (radians) of the terrain horizon in azimuth i·2π/N.
 * normal: unit surface normal, y up. Returns SVF in [0, 1].
 */
export function skyViewFactor(horizons: number[], normal: Vec3, elevSteps = 32): number {
  const n = horizons.length;
  const dPhi = (2 * Math.PI) / n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const phi = (i + 0.5) * dPhi;
    const dx = Math.cos(phi);
    const dz = Math.sin(phi);
    const nh = normal[0] * dx + normal[2] * dz; // normal's component along this azimuth
    const h = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, horizons[i]));
    const dTheta = (Math.PI / 2 - h) / elevSteps;
    for (let j = 0; j < elevSteps; j++) {
      const t = h + (j + 0.5) * dTheta; // elevation of the sample direction
      const ndotw = Math.cos(t) * nh + Math.sin(t) * normal[1];
      // Solid angle of a cell at elevation t: cos(t) dθ dφ.
      if (ndotw > 0) sum += ndotw * Math.cos(t) * dTheta * dPhi;
    }
  }
  return Math.min(1, sum / Math.PI);
}

/**
 * What lighting actually uses: the fraction of the *open-terrain* skylight that still reaches
 * the surface. Firstlight's environment map already treats everything below the horizontal as
 * ground, so the baseline is a surface of the same tilt with the horizon at 0° all round.
 * Dividing by it means open slopes keep all their skylight and only real blockage (ridges,
 * gully walls) darkens. Horizons below 0° are clamped to 0° for the same reason.
 */
export function skyOcclusion(horizons: number[], normal: Vec3, elevSteps = 32): number {
  const clamped = horizons.map((h) => Math.max(h, 0));
  const open = skyViewFactor(clamped.map(() => 0), normal, elevSteps);
  return open > 1e-6 ? Math.min(1, skyViewFactor(clamped, normal, elevSteps) / open) : 1;
}
