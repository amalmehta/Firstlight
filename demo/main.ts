import { CylinderGeometry, Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import { createStage, FirstlightUnsupportedError, Terrain, type Stage } from '../src/index';

/* ---------- Preferences (this device only) ---------- */
interface Prefs { elevation: number; azimuth: number; compensation: number; clouds: number; metering: 'auto' | 'sunny16'; quality: number; tone: 'agx' | 'aces'; settle: 'on' | 'off'; theme: 'system' | 'light' | 'dark' }
const DEFAULTS: Prefs = { elevation: 22, azimuth: 290, compensation: 0, clouds: 35, metering: 'auto', quality: 1.5, tone: 'agx', settle: 'on', theme: 'system' };
const KEY = 'firstlight.demo.v2'; // v2: exposure became EV compensation
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
prefs.compensation = clamp(prefs.compensation, -3, 3);
prefs.clouds = clamp(prefs.clouds, 0, 100);
if (prefs.metering !== 'sunny16') prefs.metering = 'auto';
if (![1, 1.5, 2].includes(prefs.quality)) prefs.quality = DEFAULTS.quality;
if (prefs.tone !== 'aces') prefs.tone = 'agx';
if (prefs.settle !== 'off') prefs.settle = 'on';
if (!['light', 'dark'].includes(prefs.theme)) prefs.theme = 'system';

const applyTheme = () => {
  if (prefs.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = prefs.theme;
};
applyTheme();
document.body.classList.add('intro');

const SUNNY_16 = { aperture: 16, shutter: 1 / 125, iso: 100 };
function meteringMode() { return prefs.metering === 'sunny16' ? SUNNY_16 : ('auto' as const); }

/* ---------- Scene ---------- */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const container = $('stage');

let stage: Stage;
try {
  stage = createStage(container, {
    sun: { elevation: prefs.elevation, azimuth: prefs.azimuth },
    exposure: meteringMode(),
    exposureCompensation: prefs.compensation,
    clouds: { coverage: prefs.clouds / 100 },
    maxPixelRatio: prefs.quality,
    toneMapping: prefs.tone,
    pathTrace: prefs.settle === 'on',
    camera: { position: [-26, 7, 46], target: [2, 4, 0] },
    label: $('scene-summary').textContent ?? undefined,
  });
} catch (e) {
  // Unsupported devices get a plain message inside the container (shown by createStage).
  container.classList.add('ready');
  if (e instanceof FirstlightUnsupportedError) document.querySelector('.panel')?.remove();
  throw e;
}


requestAnimationFrame(() => container.classList.add('ready'));
(window as unknown as { stage: Stage }).stage = stage;

/* ---------- Controls ---------- */
const elev = $<HTMLInputElement>('elev');
const azim = $<HTMLInputElement>('azim');
const expo = $<HTMLInputElement>('expo');
const cloudIn = $<HTMLInputElement>('clouds');
const compass = (a: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(a / 45) % 8];
function describeSun(e: number): string {
  if (e < -0.5) return `${e.toFixed(1)}° · below horizon`;
  if (e < 6) return `${e.toFixed(1)}° · golden hour`;
  return `${e.toFixed(1)}° above horizon`;
}
function syncOutputs(): void {
  $('elev-out').textContent = describeSun(prefs.elevation);
  $('azim-out').textContent = `${prefs.azimuth.toFixed(0)}° · from ${compass(prefs.azimuth)}`;
  const c = prefs.compensation;
  $('expo-out').textContent = `${c > 0 ? '+' : c < 0 ? '−' : '±'}${Math.abs(c).toFixed(1)} EV`;
  const k = prefs.clouds;
  $('clouds-out').textContent = k === 0 ? 'clear' : `${k.toFixed(0)}% · ${k < 25 ? 'a few' : k < 55 ? 'scattered' : k < 85 ? 'broken' : 'overcast'}`;
}
elev.value = String(prefs.elevation);
azim.value = String(prefs.azimuth);
expo.value = String(prefs.compensation);
cloudIn.value = String(prefs.clouds);
syncOutputs();

const fmtLux = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : v >= 10 ? Math.round(v).toString() : v.toFixed(1));
let lastMeter = '';
stage.onRender(() => {
  const e = stage.getExposure();
  const line1 = `☼ ${fmtLux(e.illuminanceLux)} lux at the camera · ${fmtLux(e.skyLux)} from the sky`;
  const line2 = `${e.mode === 'auto' ? 'Metered' : 'Fixed'} EV ${e.ev100.toFixed(1)} · ${e.settings}`;
  const pt = stage.getPathTraceState();
  // Only shown while the still view is being traced, so moving clears it at once.
  const line3 = !pt.enabled || pt.fade === 0 ? '' : pt.samples < pt.target ? `Path tracing · ${pt.samples} of ${pt.target} samples` : `Path traced · ${pt.samples} samples`;
  const text = line1 + line2 + line3;
  if (text !== lastMeter) {
    const m = $('meter');
    const a = document.createElement('span'); a.textContent = line1;
    const b = document.createElement('span'); b.textContent = line2;
    const c = document.createElement('span'); c.textContent = line3;
    m.replaceChildren(a, b, c);
    lastMeter = text;
  }
});

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
  prefs.compensation = Number(expo.value);
  stage.setExposureCompensation(prefs.compensation);
  syncOutputs(); savePrefs();
});

cloudIn.addEventListener('input', () => {
  prefs.clouds = Number(cloudIn.value);
  stage.setClouds({ coverage: prefs.clouds / 100 });
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
const metering = $<HTMLSelectElement>('metering');
const settle = $<HTMLSelectElement>('settle');
settle.value = prefs.settle;
settle.addEventListener('change', () => { prefs.settle = settle.value as Prefs['settle']; stage.setPathTracing(prefs.settle === 'on'); savePrefs(); });
metering.value = prefs.metering;
metering.addEventListener('change', () => { prefs.metering = metering.value as Prefs['metering']; stage.setExposure(meteringMode()); savePrefs(); });
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
  elev.value = String(prefs.elevation); azim.value = String(prefs.azimuth); expo.value = String(prefs.compensation); cloudIn.value = String(prefs.clouds); metering.value = prefs.metering;
  quality.value = String(prefs.quality); tone.value = prefs.tone; theme.value = prefs.theme; settle.value = prefs.settle;
  stage.setPathTracing(prefs.settle === 'on');
  stage.setSun(prefs).setExposure(meteringMode()).setExposureCompensation(prefs.compensation).setMaxPixelRatio(prefs.quality).setToneMapping(prefs.tone).setClouds({ coverage: prefs.clouds / 100 });
  applyTheme(); syncOutputs();
});

window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement && e.target.type !== 'range';
  if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); dialog.open ? dialog.close() : dialog.showModal(); return; }
  if (typing || dialog.open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'r' || e.key === 'R') stage.resetCamera();
  if (e.key === 's' || e.key === 'S') void saveImage();
});

/* ---------- Terrain (last, so the controls above work while it builds) ---------- */
// The sky draws at once; the valley is built in a Web Worker (a few seconds of noise and
// erosion) and added when it arrives.
$('meter').textContent = 'Building the valley…';
const terrain = await Terrain.load({ seed: 7 });
const gy = terrain.heightAt(0, 0);

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
stage.setView({ position: [-26, gy + 7, 46], target: [2, gy + 4, 0] }, { home: true });
