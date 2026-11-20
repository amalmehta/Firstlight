import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import * as gpt from 'three-gpu-pathtracer';
import {
  TERRAIN_MARK,
  FRAME_TARGET_MS,
  initialTiles,
  nextTilesPerFrame,
  patchCloudShadow,
  patchPremultipliedMiss,
  patchTerrainDetail,
  withRgbaColors,
} from '../src/pathtrace/PathTrace';

// The patches rewrite the shader of the installed three-gpu-pathtracer (pinned to 0.0.28). These
// tests fail loudly if an upgrade moves the lines they anchor on, instead of the traced frame
// silently losing cloud shadows, terrain detail or its alpha.
// Exported by the package at runtime (deprecated WebGL path) but missing from its type declarations.
const { PhysicalPathTracingMaterial } = gpt as unknown as { PhysicalPathTracingMaterial: new () => { fragmentShader: string } };
const frag = new PhysicalPathTracingMaterial().fragmentShader;

describe('shader patches against the installed path tracer', () => {
  it('makes primary misses add nothing (premultiplied alpha)', () => {
    const out = patchPremultipliedMiss(frag);
    expect(out).not.toBeNull();
    expect(out).toContain('* ( state.firstRay ? backgroundAlpha : 1.0 );');
  });

  it('dims only the directional light (the sun) by the cloud shadow map', () => {
    const out = patchCloudShadow(frag)!;
    expect(out).not.toBeNull();
    expect(out).toContain('lightRec.type == DIR_LIGHT_TYPE ? cloudSunTransmittance(rayOrigin) : 1.0');
    // The lookup is declared before the function that calls it.
    expect(out.indexOf('float cloudSunTransmittance(')).toBeLessThan(out.indexOf('vec3 directLightContribution('));
  });

  it('adds terrain detail before the BSDF is sampled', () => {
    const out = patchTerrainDetail(frag)!;
    expect(out).not.toBeNull();
    const call = out.indexOf('flTerrainDetail(ray.origin');
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(out.indexOf('scatterRec = bsdfSample( - ray.direction, surf );'));
    expect(out.indexOf('void flTerrainDetail(')).toBeLessThan(call);
  });

  it('the three patches compose', () => {
    const out = patchCloudShadow(patchTerrainDetail(patchPremultipliedMiss(frag)!)!);
    expect(out).not.toBeNull();
  });

  it('refuses (null) when its anchor is missing', () => {
    expect(patchCloudShadow('void main() {}')).toBeNull();
    expect(patchTerrainDetail('void main() {}')).toBeNull();
    expect(patchPremultipliedMiss('void main() {}')).toBeNull();
  });
});

describe('automatic tiling', () => {
  it('uses small tiles: about 12k pixels each', () => {
    expect(initialTiles(1536, 960)).toBe(12);
    expect(initialTiles(100, 100)).toBe(1);
    expect(initialTiles(5120, 2880)).toBe(16); // capped
  });
  it('draws more tiles per frame while frames are fast, backs off at once when slow', () => {
    expect(nextTilesPerFrame(1, 10)).toBe(2);
    expect(nextTilesPerFrame(4, FRAME_TARGET_MS)).toBe(4);
    expect(nextTilesPerFrame(10, 480)).toBe(6); // one heavy frame: cut 40%
    expect(nextTilesPerFrame(1, 480)).toBe(1);
    expect(nextTilesPerFrame(32, 5)).toBe(32); // capped
  });
});

describe('RGB vertex colours for the tracer', () => {
  const make = (terrain: boolean) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]), 3));
    const m = new Mesh(g, new MeshStandardMaterial({ vertexColors: true }));
    if (terrain) Object.assign(m, { terrainUniforms: {} });
    return m;
  };

  it('swaps in RGBA copies (terrain marked in alpha) and restores the originals', () => {
    const plain = make(false);
    const terr = make(true);
    const root = new Group().add(plain, terr);
    const orig = terr.geometry.getAttribute('color');
    const undo = withRgbaColors(root);
    const a = terr.geometry.getAttribute('color') as BufferAttribute;
    expect(a.itemSize).toBe(4);
    expect([a.getX(1), a.getY(1), a.getZ(1)].map((v) => +v.toFixed(3))).toEqual([0.4, 0.5, 0.6]);
    expect(a.getW(2)).toBe(TERRAIN_MARK);
    expect((plain.geometry.getAttribute('color') as BufferAttribute).getW(0)).toBe(1);
    undo();
    expect(terr.geometry.getAttribute('color')).toBe(orig);
    expect(terr.geometry.getAttribute('color').itemSize).toBe(3);
  });

  it('reuses the copy until the colours change', () => {
    const m = make(false);
    const undo1 = withRgbaColors(m);
    const first = m.geometry.getAttribute('color');
    undo1();
    const undo2 = withRgbaColors(m);
    expect(m.geometry.getAttribute('color')).toBe(first);
    undo2();
    (m.geometry.getAttribute('color') as BufferAttribute).setX(0, 1).needsUpdate = true;
    const undo3 = withRgbaColors(m);
    const third = m.geometry.getAttribute('color') as BufferAttribute;
    expect(third).not.toBe(first);
    expect(third.getX(0)).toBe(1);
    undo3();
  });
});
