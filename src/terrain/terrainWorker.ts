/// <reference lib="webworker" />
// Builds terrain off the main thread (a few seconds of noise and erosion), so the page stays
// responsive and the sky can draw while the ground is being made.
import { buildTerrainData, type TerrainOptions } from './build';

self.onmessage = (e: MessageEvent<TerrainOptions>) => {
  const d = buildTerrainData(e.data);
  (self as unknown as Worker).postMessage(d, [
    d.grid.buffer,
    d.positions.buffer,
    d.normals.buffer,
    d.colors.buffer,
    d.index.buffer,
  ]);
};
