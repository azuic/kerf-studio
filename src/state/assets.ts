import { boundsOf, centerOnPlate, orientToYUp, type Bounds } from '../io/stl';
import type { UpAxis } from '../types';

/**
 * The imported STL mesh, held outside the undoable state.
 *
 * A 30k-triangle model is ~1 MB of floats; JSON-snapshotting that on every slider tick
 * would make undo unusable. The state keeps only the descriptive fields (`stlName`,
 * `stlW/D/H`, `stlTris`, `stlUpAxis`) and the buffers live here.
 *
 * The file is kept exactly as parsed. Everything downstream uses the *oriented* copy —
 * rotated to Y-up and dropped onto the plate — which is derived on demand and cached, so
 * changing the up axis never needs a re-import and never compounds rotations.
 */
let raw: Float32Array | null = null;
let oriented: Float32Array | null = null;
let orientedBounds: Bounds | null = null;
let orientedAxis: UpAxis | null = null;

export function setStlRaw(positions: Float32Array | null): void {
  raw = positions;
  oriented = null;
  orientedBounds = null;
  orientedAxis = null;
}

/** The file as parsed, unrotated — what gets written to a .kerf.json. */
export function getStlRaw(): Float32Array | null {
  return raw;
}

export interface OrientedStl {
  positions: Float32Array;
  bounds: Bounds;
}

/** The mesh rotated to Y-up and seated on the plate, cached per axis choice. */
export function getOrientedStl(up: UpAxis): OrientedStl | null {
  if (!raw || raw.length === 0) return null;
  if (!oriented || orientedAxis !== up) {
    oriented = orientToYUp(raw, up);
    orientedBounds = centerOnPlate(oriented);
    orientedAxis = up;
  }
  return { positions: oriented, bounds: orientedBounds ?? boundsOf(oriented) };
}

export function hasStl(): boolean {
  return raw !== null && raw.length > 0;
}
