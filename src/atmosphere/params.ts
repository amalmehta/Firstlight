/**
 * Earth atmosphere parameters, in kilometres (lengths) and 1/km (coefficients).
 *
 * Values follow Hillaire 2020 ("A Scalable and Production Ready Sky and Atmosphere
 * Rendering Technique", EGSR) and its reference code
 * (github.com/sebh/UnrealEngineSkyAtmosphere, SkyAtmosphereCommon.cpp), which in turn
 * take Rayleigh coefficients from Bruneton's precomputed_atmospheric_scattering
 * (beta_R = 1.24062e-6 * lambda[um]^-4 per metre at lambda = 680, 550, 440 nm for R, G, B).
 *
 * Two places where the paper and the code disagree, and what we use:
 * - Mie absorption: the paper's Table 1 says 4.40e-6 /m; the code (and Bruneton's demo,
 *   extinction = scattering / 0.9) use extinction 4.44e-6 /m. We follow the code.
 * - Ground albedo: the paper says 0.3, the code's default is 0. We use 0.3 so the ground
 *   bounces light into the multiple-scattering term, as in the paper's figures.
 */
export interface AtmosphereParams {
  /** Planet radius, km. */
  bottomRadius: number;
  /** Radius where the atmosphere ends, km. */
  topRadius: number;
  /** Rayleigh scattering at sea level, 1/km, RGB = 680/550/440 nm. */
  rayleighScattering: [number, number, number];
  /** Rayleigh density falls as exp(-h / H), km. */
  rayleighScaleHeight: number;
  /** Mie scattering at sea level, 1/km (grey). */
  mieScattering: number;
  /** Mie extinction (scattering + absorption) at sea level, 1/km. */
  mieExtinction: number;
  /** Mie density scale height, km. */
  mieScaleHeight: number;
  /** Mie phase asymmetry g (Cornette-Shanks). */
  mieG: number;
  /** Ozone absorption at peak density, 1/km, RGB. */
  ozoneAbsorption: [number, number, number];
  /** Ozone tent profile: peak altitude and half-width, km. Density = max(0, 1 - |h - c| / w). */
  ozoneCenter: number;
  ozoneHalfWidth: number;
  /** Lambertian ground albedo, RGB. */
  groundAlbedo: [number, number, number];
}

export const EARTH: Readonly<AtmosphereParams> = Object.freeze({
  bottomRadius: 6360,
  topRadius: 6460,
  rayleighScattering: [5.802e-3, 13.558e-3, 33.1e-3],
  rayleighScaleHeight: 8,
  mieScattering: 3.996e-3,
  mieExtinction: 4.44e-3,
  mieScaleHeight: 1.2,
  mieG: 0.8,
  ozoneAbsorption: [0.65e-3, 1.881e-3, 0.085e-3],
  ozoneCenter: 25,
  ozoneHalfWidth: 15,
  groundAlbedo: [0.3, 0.3, 0.3],
}) as AtmosphereParams;

/** Wavelengths (nm) the RGB channels stand for. */
export const CHANNEL_WAVELENGTHS_NM = [680, 550, 440] as const;
