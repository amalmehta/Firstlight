import { CylinderGeometry, Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import { createStage, FirstlightUnsupportedError, Terrain, type Stage } from '../src/index';

/* ---------- Preferences (this device only) ---------- */
interface Prefs { elevation: number; azimuth: number; exposure: number; quality: number; tone: 'agx' | 'aces'; theme: 'system' | 'light' | 'dark' }
const DEFAULTS: Prefs = { elevation: 22, azimuth: 290, exposure: 6, quality: 1.5, tone: 'agx', theme: 'system' };
const KEY = 'firstlight.demo.v1';
function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...DEFAULTS, ...(typeof raw === 'object' && raw ? raw : {}) };
  } catch { return { ...DEFAULTS }; }
}
const prefs = loadPrefs();
let saveTimer = 0;
function savePrefs(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode: fine */ }
  }, 250);
}
const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
prefs.elevation = clamp(prefs.elevation, -4, 70);
prefs.azimuth = clamp(prefs.azimuth, 0, 360);
prefs.exposure = clamp(prefs.exposure, 1, 20);
if (![1, 1.5, 2].includes(prefs.quality)) prefs.quality = DEFAULTS.quality;
if (prefs.tone !== 'aces') prefs.tone = 'agx';
if (!['light', 'dark'].includes(prefs.theme)) prefs.theme = 'system';

const applyTheme = () => {
  if (prefs.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = prefs.theme;
};
applyTheme();
document.body.classList.add('intro');

/* ---------- Scene ---------- */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const container = $('stage');
const terrain = new Terrain({ seed: 7 });
const gy = terrain.heightAt(0, 0);

let stage: Stage;
try {
  stage = createStage(container, {
    sun: { elevation: prefs.elevation, azimuth: prefs.azimuth },
    exposure: prefs.exposure,
    maxPixelRatio: prefs.quality,
    toneMapping: prefs.tone,
    camera: { position: [-26, gy + 7, 46], target: [2, gy + 4, 0] },
    label: $('scene-summary').textContent ?? undefined,
  });
} catch (e) {
  // Unsupported devices get a plain message inside the container (shown by createStage).
  container.classList.add('ready');
  if (e instanceof FirstlightUnsupportedError) document.querySelector('.panel')?.remove();
  throw e;
}

// Two materials, two light paths: a mirror shows the sky (environment), rough stone shows
// sun + sky diffuse light and the shadow.
const steel = new Mesh(
  new SphereGeometry(3.2, 128, 64),
  new MeshStandardMaterial({ color: 0xd9d5cd, metalness: 1, roughness: 0.16 }),
);
steel.position.set(-3, terrain.heightAt(-3, 0) + 3.1, 0);
const stone = new Mesh(
  new CylinderGeometry(1.5, 1.9, 11, 7, 1),
  new MeshStandardMaterial({ color: 0x8a8278, roughness: 0.85, metalness: 0, flatShading: true }),
);
stone.position.set(6, terrain.heightAt(6, -4) + 5.2, -4);
stone.rotation.set(0.04, 0.5, -0.03);
for (const m of [steel, stone]) m.castShadow = m.receiveShadow = true;
stage.add(terrain, steel, stone);
requestAnimationFrame(() => container.classList.add('ready'));
(window as unknown as { stage: Stage }).stage = stage;

/* ---------- Controls ---------- */
const elev = $<HTMLInputElement>('elev');
const azim = $<HTMLInputElement>('azim');
const expo = $<HTMLInputElement>('expo');
const compass = (a: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(a / 45) % 8];
function describeSun(e: number): string {
  if (e < -0.5) return `${e.toFixed(1)}° · below horizon`;
  if (e < 6) return `${e.toFixed(1)}° · golden hour`;
  return `${e.toFixed(1)}° above horizon`;
}
function syncOutputs(): void {
  $('elev-out').textContent = describeSun(prefs.elevation);
  $('azim-out').textContent = `${prefs.azimuth.toFixed(0)}° · from ${compass(prefs.azimuth)}`;
  $('expo-out').textContent = `${prefs.exposure.toFixed(1)}×`;
}
elev.value = String(prefs.elevation);
azim.value = String(prefs.azimuth);
expo.value = String(prefs.exposure);
syncOutputs();

elev.addEventListener('input', () => {
  prefs.elevation = Number(elev.value);
  stage.setSun({ elevation: prefs.elevation });
  syncOutputs(); savePrefs();
});
azim.addEventListener('input', () => {
  prefs.azimuth = Number(azim.value);
  stage.setSun({ azimuth: prefs.azimuth });
  syncOutputs(); savePrefs();
});
expo.addEventListener('input', () => {
  prefs.exposure = Number(expo.value);
  stage.setExposure(prefs.exposure);
  syncOutputs(); savePrefs();
});

$('reset').addEventListener('click', () => stage.resetCamera());
async function saveImage(): Promise<void> {
  const blob = await stage.snapshot();
  if (!blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Firstlight ${prefs.elevation.toFixed(0)}° sun.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('save').addEventListener('click', saveImage);

/* ---------- Settings (⌘,) ---------- */
const dialog = $<HTMLDialogElement>('settings');
const quality = $<HTMLSelectElement>('quality');
const tone = $<HTMLSelectElement>('tone');
const theme = $<HTMLSelectElement>('theme');
quality.value = String(prefs.quality);
tone.value = prefs.tone;
theme.value = prefs.theme;
$('open-settings').addEventListener('click', () => dialog.showModal());
quality.addEventListener('change', () => { prefs.quality = Number(quality.value); stage.setMaxPixelRatio(prefs.quality); savePrefs(); });
tone.addEventListener('change', () => { prefs.tone = tone.value as Prefs['tone']; stage.setToneMapping(prefs.tone); savePrefs(); });
theme.addEventListener('change', () => { prefs.theme = theme.value as Prefs['theme']; applyTheme(); savePrefs(); });
$('bench').addEventListener('click', async () => {
  const out = $('bench-out');
  out.textContent = 'Measuring…';
  const r = await stage.benchmark(3);
  const fps = 1000 / r.medianMs;
  out.textContent = `Median ${r.medianMs.toFixed(1)} ms between frames (≈${fps.toFixed(0)} fps), slowest 5% ${r.p95Ms.toFixed(1)} ms, over ${r.frames} frames. ${r.medianMs <= 16.7 ? 'Meets 60 fps.' : 'Below 60 fps: try Fast quality.'}`;
});
$('clear-prefs').addEventListener('click', () => {
  try { localStorage.removeItem(KEY); } catch { /* nothing stored */ }
  Object.assign(prefs, DEFAULTS);
  elev.value = String(prefs.elevation); azim.value = String(prefs.azimuth); expo.value = String(prefs.exposure);
  quality.value = String(prefs.quality); tone.value = prefs.tone; theme.value = prefs.theme;
  stage.setSun(prefs).setExposure(prefs.exposure).setMaxPixelRatio(prefs.quality).setToneMapping(prefs.tone);
  applyTheme(); syncOutputs();
});

window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement && e.target.type !== 'range';
  if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); dialog.open ? dialog.close() : dialog.showModal(); return; }
  if (typing || dialog.open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'r' || e.key === 'R') stage.resetCamera();
  if (e.key === 's' || e.key === 'S') void saveImage();
});
