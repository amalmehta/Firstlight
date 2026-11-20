/**
 * Photometric units and a physical camera.
 *
 * The atmosphere LUTs are transfer functions: they give luminance per unit of sun
 * illuminance. Multiply by the sun's illuminance in lux and every pixel is in cd/m²
 * (nits), the unit a light meter or a camera sensor responds to. A physical camera then
 * maps that to the sensor's 0..1 range with its exposure value.
 *
 * Sources:
 * - Luminous solar constant, about 133.8 klx above the atmosphere (yearly mean): Kittler & Darula,
 *   citing Darula, Kittler & Gueymard, "Reference luminous solar constant and solar luminance
 *   for illuminance calculations", Solar Energy 79(5), 2005. We could not open the 2005 paper
 *   itself; the value is cited second-hand.
 * - Saturation-based exposure: Lagarde & de Rousiers, "Moving Frostbite to Physically Based
 *   Rendering" (2014), after ISO 12232: L_max = 78 / (S q) * N² / t, with q = 0.65, which at
 *   ISO 100 is 1.2 * 2^EV100. (q = 0.65 as given in Unity's PhysicalCamera.hlsl, which cites it.)
 * - Incident light meter: N² / t = E S / C, with C = 250 for a flat receptor (ISO 2720 allows
 *   240-400; real meters use 250-340).
 */

/** Sun illuminance above the atmosphere, lux (Darula et al. 2005, as cited). */
export const SOLAR_ILLUMINANCE_LUX = 133_800;

/** Incident-meter calibration constant for a flat receptor (ISO 2720 range 240-400). */
export const INCIDENT_METER_C = 250;

/** Lens and sensor factor in the saturation-based model (Lagarde 2014, via Unity). */
const LENS_Q = 0.65;

export interface CameraSettings {
  /** f-number, e.g. 16 for f/16. */
  aperture: number;
  /** Shutter time in seconds, e.g. 1/125. */
  shutter: number;
  /** ISO sensitivity, e.g. 100. */
  iso: number;
}

/** Exposure value at ISO 100 for camera settings: EV100 = log2(N² / t * 100 / S). */
export function ev100FromCamera({ aperture, shutter, iso }: CameraSettings): number {
  return Math.log2(((aperture * aperture) / shutter) * (100 / iso));
}

/** EV100 an incident light meter would read under illuminance E (lux): log2(E * 100 / C). */
export function ev100FromIlluminance(lux: number, c = INCIDENT_METER_C): number {
  return Math.log2((Math.max(lux, 1e-6) * 100) / c);
}

/** Luminance (cd/m²) that just saturates the sensor at this EV100: 78/(100 q) * 2^EV ≈ 1.2 * 2^EV. */
export function saturationLuminance(ev100: number): number {
  return (78 / (100 * LENS_Q)) * Math.pow(2, ev100);
}

/** Multiply luminance (cd/m²) by this to get the sensor value (1 = saturation). */
export function exposureScale(ev100: number): number {
  return 1 / saturationLuminance(ev100);
}

/** Readable camera settings near an EV100, holding ISO 100 and f/8 unless the shutter runs out of range. */
export function describeEv(ev100: number): string {
  const stops = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];
  let best = { n: 8, t: 1 };
  let err = Infinity;
  for (const n of stops) {
    const t = (n * n) / Math.pow(2, ev100);
    if (t > 30 || t < 1 / 8000) continue;
    const e = Math.abs(Math.log2(n / 8));
    if (e < err) { err = e; best = { n, t }; }
  }
  const t = best.t >= 1 ? `${best.t.toFixed(best.t < 10 ? 1 : 0)} s` : `1/${Math.round(1 / best.t)} s`;
  return `f/${best.n} · ${t} · ISO 100`;
}
