import { DataUtils } from 'three';
import { createStage, EARTH, reference, LUT_SIZES } from '../src/index';

type Row = { name: string; result: string; pass: boolean };
const rows: Row[] = [];
const show = () => {
  document.getElementById('rows')!.innerHTML = rows
    .map((r) => `<tr><td>${r.name}</td><td>${r.result}</td><td class="${r.pass ? 'ok' : 'bad'}">${r.pass ? '✓ pass' : '✗ fail'}</td></tr>`)
    .join('');
  (window as unknown as { selfcheck: Row[] }).selfcheck = rows;
};

// 1. GPU transmittance LUT vs CPU reference, texel by texel.
const stage = createStage(document.getElementById('stage')!);
stage.render();
const [w, h] = LUT_SIZES.transmittance;
const buf = new Uint16Array(w * h * 4);
stage.renderer.readRenderTargetPixels(stage.atmosphere.transmittance, 0, 0, w, h, buf);
let maxRel = 0;
let worst = '';
let compared = 0;
for (let j = 0; j < h; j++) {
  for (let i = 0; i < w; i++) {
    const [r, mu] = reference.transmittanceUvToRMu(EARTH, (i + 0.5) / w, (j + 0.5) / h);
    const cpu = reference.transmittance(EARTH, r, mu);
    for (let c = 0; c < 3; c++) {
      if (cpu[c] < 1e-3) continue; // below half-float's useful range; nothing visible depends on it
      const gpu = DataUtils.fromHalfFloat(buf[(j * w + i) * 4 + c]);
      const rel = Math.abs(gpu - cpu[c]) / cpu[c];
      compared++;
      if (rel > maxRel) { maxRel = rel; worst = `texel (${i}, ${j}) channel ${'RGB'[c]}`; }
    }
  }
}
rows.push({
  name: `GPU transmittance LUT (${w}×${h}) vs CPU reference, ${compared} values where T ≥ 0.001`,
  result: `max relative error ${(maxRel * 100).toFixed(3)}% at ${worst}`,
  pass: maxRel < 0.01,
});

// 2. Rayleigh optical depth vs Bucholtz 1995 (Table 4, US Standard Atmosphere 1962).
const bucholtz = [0.04102, 0.09721, 0.2429];
const ours = reference.verticalRayleighDepth(EARTH);
const rels = ours.map((v, i) => (v - bucholtz[i]) / bucholtz[i]);
rows.push({
  name: 'Sea-level Rayleigh optical depth vs Bucholtz 1995 at 680 / 550 / 440 nm',
  result: ours.map((v, i) => `${v.toFixed(4)} vs ${bucholtz[i]} (${rels[i] > 0 ? '+' : ''}${(rels[i] * 100).toFixed(1)}%)`).join('<br>'),
  pass: rels.every((r) => Math.abs(r) < 0.15),
});

// 3. Sunset reddening and midday brightness.
const t2 = reference.sunTransmittance(EARTH, 2);
const t60 = reference.sunTransmittance(EARTH, 60);
rows.push({ name: 'Sun at 2°: red / blue transmittance > 2', result: (t2[0] / t2[2]).toFixed(2), pass: t2[0] / t2[2] > 2 });
rows.push({ name: 'Sun at 60°: every channel > 0.7', result: t60.map((v) => v.toFixed(3)).join(', '), pass: t60.every((v) => v > 0.7) });

// 4. Photometry at a 60° sun: direct and sky light on a horizontal surface, in lux.
// Plausibility bands around Frostbite's reference values (Lagarde & de Rousiers 2014:
// sun ≈ 100 klx, sky ≈ 20 klx), not a measurement of a specific day.
stage.setSun({ elevation: 60, azimuth: 180 });
stage.render();
const ex = stage.getExposure();
const direct = ex.illuminanceLux - ex.skyLux;
rows.push({
  name: 'Sun at 60°: direct light on the ground 80–120 klx; sky light 8–30 klx',
  result: `direct ${(direct / 1000).toFixed(1)} klx, sky ${(ex.skyLux / 1000).toFixed(1)} klx, EV ${ex.ev100.toFixed(2)} (${ex.settings})`,
  pass: direct > 80_000 && direct < 120_000 && ex.skyLux > 8_000 && ex.skyLux < 30_000,
});
// Auto exposure keeps a lit grey card near the same display value from noon to dusk.
const lit: number[] = [];
for (const el of [60, 20, 5]) {
  stage.setSun({ elevation: el });
  stage.render();
  lit.push(stage.getExposure().ev100);
}
rows.push({
  name: 'Auto exposure: EV falls as the light falls (sun 60° → 20° → 5°)',
  result: lit.map((e) => e.toFixed(2)).join(' → '),
  pass: lit[0] > lit[1] && lit[1] > lit[2],
});

// 5. No WebGL errors.
const gl = stage.renderer.getContext();
const err = gl.getError();
rows.push({ name: 'WebGL error flag after rendering', result: err === 0 ? 'none' : `0x${err.toString(16)}`, pass: err === 0 });
show();
