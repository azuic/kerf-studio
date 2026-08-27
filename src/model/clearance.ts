import type {
  AppState,
  ClearanceAxes,
  ClearanceMode,
  ClearanceSpec,
  Cutter,
  CutterType,
} from '../types';

/**
 * Clearance resolution.
 *
 * Every value here is a TOTAL gap in millimetres — the amount by which a dimension
 * changes overall, so half of it lands on each side of a bore. Callers never halve it
 * themselves; `growRadius` and friends do that.
 *
 * See docs/KERF-STUDIO-CLEARANCE.md for the model this implements.
 */

export interface ResolvedClearance {
  mode: ClearanceMode;
  axes: ClearanceAxes;
  /** How much the socket's dimensions grow, per axis (total gap). */
  socketGrow: ClearanceAxes;
  /** How much the insert's dimensions shrink, per axis (total gap). */
  insertShrink: ClearanceAxes;
  /** True when this cutter carries its own spec rather than inheriting. */
  overridden: boolean;
}

/**
 * Which side absorbs the gap, by default, for a given cutter type.
 *
 * The rule is what the hole *mates with*:
 *
 * - A **generated** mate — a plain hole with a Kerf-made insert, or a bayonet pin —
 *   uses `insert`. Both halves are ours, so the gap can go on either dimensionally, and
 *   shrinking the insert keeps the red cutter ghost equal to what is actually
 *   subtracted. That matters now that cutters are positioned by dragging the ghost.
 *
 * - An **external** mate — an M3 nut, a heat-set insert, a bearing, a dowel — must use
 *   `socket`. The nominal number is the real part's spec (an M3 nut trap is drawn at
 *   AF 5.5 because that is what a nut measures), so the hole has to end up larger.
 *   There is no insert to shrink, and `insert` mode would silently do nothing.
 *
 * Every cutter type that exists today takes a generated mate. The fastener presets on
 * the P1 roadmap — heat-set pocket, nut trap, counterbore — are the external ones, and
 * they return 'socket' from here when they land.
 */
export function defaultModeForCutter(_type: CutterType): ClearanceMode {
  return 'insert';
}

function fill(spec: ClearanceSpec): ClearanceAxes {
  const v = spec.value;
  return {
    radial: spec.axes?.radial ?? v,
    tangential: spec.axes?.tangential ?? v,
    axial: spec.axes?.axial ?? v,
  };
}

/** Split a total gap into how much each side moves. */
export function splitGap(total: number, mode: ClearanceMode): { grow: number; shrink: number } {
  switch (mode) {
    case 'socket':
      return { grow: total, shrink: 0 };
    case 'insert':
      return { grow: 0, shrink: total };
    case 'split':
      return { grow: total / 2, shrink: total / 2 };
  }
}

function mapAxes(axes: ClearanceAxes, f: (v: number) => number): ClearanceAxes {
  return { radial: f(axes.radial), tangential: f(axes.tangential), axial: f(axes.axial) };
}

/**
 * The effective clearance for one cutter: its own spec if it has one, otherwise the
 * project default, with the mode falling back to whatever suits the cutter's mate.
 */
export function resolveClearance(
  cutter: Pick<Cutter, 'type' | 'clearance'>,
  state: Pick<AppState, 'clearance'>,
): ResolvedClearance {
  const overridden = cutter.clearance !== undefined;
  const spec = cutter.clearance ?? state.clearance;
  const mode = spec.mode ?? defaultModeForCutter(cutter.type);
  const axes = fill(spec);

  return {
    mode,
    axes,
    socketGrow: mapAxes(axes, (v) => splitGap(v, mode).grow),
    insertShrink: mapAxes(axes, (v) => splitGap(v, mode).shrink),
    overridden,
  };
}

/** The clearance a bayonet set's pin is built against; groups inherit like any cutter. */
export function resolveGroupClearance(
  state: Pick<AppState, 'clearance'>,
  override?: ClearanceSpec,
): ResolvedClearance {
  return resolveClearance({ type: 'cyl', clearance: override }, state);
}

export const ZERO_CLEARANCE: ResolvedClearance = {
  mode: 'insert',
  axes: { radial: 0, tangential: 0, axial: 0 },
  socketGrow: { radial: 0, tangential: 0, axial: 0 },
  insertShrink: { radial: 0, tangential: 0, axial: 0 },
  overridden: false,
};
