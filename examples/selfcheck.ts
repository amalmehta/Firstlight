import { DataUtils } from 'three';
import { createStage, EARTH, reference, LUT_SIZES, Terrain, skyView } from '../src/index';

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
await stage.settle();
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
  await stage.settle();
  lit.push(stage.getExposure().ev100);
}
rows.push({
  name: 'Auto exposure: EV falls as the light falls (sun 60° → 20° → 5°)',
  result: lit.map((e) => e.toFixed(2)).join(' → '),
  pass: lit[0] > lit[1] && lit[1] > lit[2],
});

// 5. Terrain sky occlusion: GPU bake vs the CPU reference (skyView.skyOcclusion, unit-tested
// against closed forms), at sample vertices, with the same horizon march on terrain.heightAt.
{
  const terrain = new Terrain({ seed: 7 });
  stage.add(terrain);
  stage.render();
  const t = terrain as unknown as { skyOccTarget: import('three').WebGLRenderTarget; size: number };
  const n = 513;
  const buf = new Uint16Array(n * n * 4);
  stage.renderer.readRenderTargetPixels(t.skyOccTarget, 0, 0, n, n, buf);
  const cell = terrain.size / 512;
  const half = terrain.size / 2;
  // Sample the same 513² grid the GPU sees, bilinearly (heightAt has sub-grid detail the
  // bake never sees, so comparing against it would test the grid, not the implementation).
  const grid = new Float32Array(n * n);
  const pos = terrain.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const gx = Math.round((pos.getX(i) / terrain.size + 0.5) * 512);
    const gz = Math.round((pos.getZ(i) / terrain.size + 0.5) * 512);
    grid[gz * n + gx] = pos.getY(i);
  }
  const H = (x: number, z: number) => {
    const fx = Math.min(Math.max((x / terrain.size + 0.5) * 512, 0), 512);
    const fz = Math.min(Math.max((z / terrain.size + 0.5) * 512, 0), 512);
    const x0 = Math.min(Math.floor(fx), 511), z0 = Math.min(Math.floor(fz), 511);
    const tx = fx - x0, tz = fz - z0;
    const g = (a: number, b: number) => grid[b * n + a];
    return (g(x0, z0) * (1 - tx) + g(x0 + 1, z0) * tx) * (1 - tz) + (g(x0, z0 + 1) * (1 - tx) + g(x0 + 1, z0 + 1) * tx) * tz;
  };
  let maxErr = 0;
  let worst = '';
  let count = 0;
  for (let iz = 40; iz < n - 40; iz += 53) {
    for (let ix = 40; ix < n - 40; ix += 53) {
      const x = (ix / 512 - 0.5) * terrain.size;
      const z = (iz / 512 - 0.5) * terrain.size;
      const y = H(x, z) + 1.5;
      const nrm = [-(H(x + cell, z) - H(x - cell, z)) / (2 * cell), 1, -(H(x, z + cell) - H(x, z - cell)) / (2 * cell)];
      const l = Math.hypot(nrm[0], nrm[1], nrm[2]);
      const horizons: number[] = [];
      for (let i = 0; i < 16; i++) {
        const phi = ((i + 0.5) * 2 * Math.PI) / 16;
        let tan = 0;
        let s = cell;
        for (let k = 0; k < 40; k++) {
          const qx = x + Math.cos(phi) * s;
          const qz = z + Math.sin(phi) * s;
          if (Math.abs(qx) > half || Math.abs(qz) > half || s > 8000) break;
          tan = Math.max(tan, (H(qx, qz) - y) / s);
          s += Math.max(cell, s * 0.15);
        }
        horizons.push(Math.atan(tan));
      }
      const cpu = skyView.skyOcclusion(horizons, [nrm[0] / l, nrm[1] / l, nrm[2] / l], 12);
      const gpu = DataUtils.fromHalfFloat(buf[(iz * n + ix) * 4]);
      const err = Math.abs(gpu - cpu);
      count++;
      if (err > maxErr) { maxErr = err; worst = `vertex (${ix}, ${iz}): GPU ${gpu.toFixed(3)} vs CPU ${cpu.toFixed(3)}`; }
    }
  }
  rows.push({
    name: `Terrain sky occlusion: GPU bake vs CPU reference (same height grid) at ${count} vertices, within 0.02`,
    result: `max difference ${maxErr.toFixed(3)} (${worst})`,
    pass: maxErr < 0.02,
  });
}

// 6. No WebGL errors.
const gl = stage.renderer.getContext();
const err = gl.getError();
rows.push({ name: 'WebGL error flag after rendering', result: err === 0 ? 'none' : `0x${err.toString(16)}`, pass: err === 0 });
show();
