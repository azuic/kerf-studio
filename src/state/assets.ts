/**
 * The imported STL mesh, held outside the undoable state.
 *
 * A 30k-triangle model is ~1 MB of floats; JSON-snapshotting that on every slider
 * tick would make undo unusable. The state keeps only the descriptive fields
 * (`stlName`, `stlW/D/H`, `stlTris`) and the buffer lives here.
 */
let positions: Float32Array | null = null;

export function setStlPositions(p: Float32Array | null): void {
  positions = p;
}

export function getStlPositions(): Float32Array | null {
  return positions;
}

export function hasStl(): boolean {
  return positions !== null && positions.length > 0;
}
