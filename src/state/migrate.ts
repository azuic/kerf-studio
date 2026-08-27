import { BURIED_OVERSHOOT, SURFACE_OVERSHOOT } from '../model/geometry';
import type { AppState, Cutter } from '../types';
import { baseHeight, initialState } from '../types';

/**
 * Bring a state object written by an older build up to the current shape.
 *
 * Kept separate from `deserializeProject` because the localStorage autosave needs the
 * same treatment — a browser holding yesterday's autosave is just as much an old file
 * as one on disk.
 */

/** The pre-3D cutter shape: vertical only, anchored relative to the model top. */
interface LegacyCutterParams {
  depth: number;
  topOffset?: number;
  x?: number;
  y?: number;
  z?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  overshoot?: number;
  [k: string]: unknown;
}

export function migrateState(raw: Partial<AppState> | undefined): AppState {
  const base = initialState();
  if (!raw || typeof raw !== 'object') return base;

  const state: AppState = {
    ...base,
    ...raw,
    base: { ...base.base, ...raw.base },
    insert: { ...base.insert, ...raw.insert },
    clearance: raw.clearance ?? migrateClearance(raw),
    presets: raw.presets?.length ? raw.presets : base.presets,
  };

  const modelTop = baseHeight(state.base);
  state.cutters = (raw.cutters ?? []).map((c) => migrateCutter(c, modelTop));
  return state;
}

/** The pre-clearance-model shape: one number on the insert spec, applied per side. */
interface LegacyInsert {
  clearance?: number;
}

/**
 * Convert the old single `insert.clearance` into a ClearanceSpec that produces byte-for-
 * byte identical geometry.
 *
 * The old code was not self-consistent: radially it subtracted the value from *each*
 * side (`dia - 2c`, a total gap of 2c), but axially it subtracted it once
 * (`depth - c`, a total gap of c). The new model states every value as a total gap, so
 * preserving both needs an explicit per-axis spec — a single number cannot express it.
 *
 * Tangential had no old equivalent; bayonet lug width used the radial `2c` rule, so it
 * inherits the same doubled value.
 */
function migrateClearance(raw: Partial<AppState>): AppState['clearance'] {
  const legacy = (raw.insert as LegacyInsert | undefined)?.clearance;
  if (typeof legacy !== 'number') return initialState().clearance;
  return {
    value: legacy * 2,
    mode: 'insert',
    axes: { radial: legacy * 2, tangential: legacy * 2, axial: legacy },
  };
}

function migrateCutter(c: Cutter, modelTop: number): Cutter {
  const p = c.params as unknown as LegacyCutterParams;

  // Already migrated: a 3D cutter always carries an explicit y.
  if (typeof p.y === 'number' && typeof p.rotX === 'number') return c;

  // Legacy cutters were anchored `topOffset` below the model top and always pointed
  // straight down, with the overshoot implied by whether the cut started at the surface.
  const topOffset = p.topOffset ?? 0;
  const buried = topOffset > 0.001;

  const migrated: Record<string, unknown> = { ...p };
  delete migrated.topOffset;

  return {
    ...c,
    params: {
      ...(migrated as unknown as Cutter['params']),
      depth: p.depth,
      x: p.x ?? 0,
      y: modelTop - topOffset,
      z: p.z ?? 0,
      rotX: 0,
      rotY: p.rotY ?? 0,
      rotZ: 0,
      overshoot: buried ? BURIED_OVERSHOOT : SURFACE_OVERSHOOT,
    },
  };
}
