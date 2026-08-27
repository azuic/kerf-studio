/**
 * Shared vocabulary for the whole app. Everything here is plain JSON so it can be
 * snapshotted for undo, written to a .kerf.json project file, and posted to the
 * CSG worker without any custom serialisation.
 */

export type BaseType = 'box' | 'hbox' | 'cyl' | 'cup' | 'stl';

/** Cutter shapes. `gap` is a box with wide defaults; `groove` is a cylinder buried below the surface. */
export type CutterType = 'cyl' | 'box' | 'hex' | 'gap' | 'groove';

/**
 * Which axis of an imported STL points up.
 *
 * STL carries no unit or orientation metadata, but the de-facto convention across CAD
 * and every slicer is Z-up, while three.js is Y-up. Files exported from a Y-up tool
 * (some Blender setups) need the other setting.
 */
export type UpAxis = 'z' | 'y';

/**
 * A cutter is anchored at its **entry point** — the centre of the face where the cut
 * breaks the surface — and runs `depth` mm along its own −Y axis from there. Rotating
 * it pivots about that entry point, so aiming a hole never moves where it enters.
 *
 * In local coordinates the entry face sits at y = 0, the body spans y ∈ [−depth, 0], and
 * `overshoot` extends it to y = +overshoot so the boolean never has to resolve faces
 * coplanar with the surface.
 */
export interface CutterParams {
  /** cyl + groove: hole diameter (mm) */
  dia?: number;
  /** hex: across-flats (mm) */
  af?: number;
  /** box + gap: width across the cutter's local X (mm) */
  w?: number;
  /** box + gap: length along the cutter's local Z (mm) */
  l?: number;
  /** How far the cut runs from its entry point, along the cutter's own axis (mm). */
  depth: number;
  /** Entry point in world space (mm). */
  x: number;
  y: number;
  z: number;
  /** Rotation about each world axis, degrees, applied in XYZ order. */
  rotX: number;
  rotY: number;
  rotZ: number;
  /** How far to extend the cutter back past its entry face (mm). */
  overshoot: number;
}

export interface Cutter {
  id: number;
  type: CutterType;
  name: string;
  enabled: boolean;
  /** Bayonet set membership, e.g. "G1". Null for loose cutters. */
  group: string | null;
  params: CutterParams;
  /**
   * Omitted means inherit `AppState.clearance`. Present means this cutter overrides it,
   * and the UI shows an "overridden" badge.
   */
  clearance?: ClearanceSpec;
}

/* ------------------------------------------------------------------ *
 * Clearance
 *
 * Clearance is a *derivation parameter*, never geometry: inserts are a pure
 * function of (cutter, resolved clearance) and are regenerated whenever either
 * changes. See docs/KERF-STUDIO-CLEARANCE.md.
 * ------------------------------------------------------------------ */

/** Which side of the pair absorbs the gap. */
export type ClearanceMode =
  | 'socket' // socket inflated by the gap, insert stays nominal
  | 'insert' // insert deflated by the gap, socket stays nominal
  | 'split'; // half each way

/** Per-axis gap in mm. Every value is the TOTAL gap, not per side. */
export interface ClearanceAxes {
  /** Diameter / width growth, perpendicular to the cutter axis. */
  radial: number;
  /** Bayonet lug width vs slot width — rotational slop. */
  tangential: number;
  /** Depth, and lug thickness vs slot height. */
  axial: number;
}

export interface ClearanceSpec {
  /** The single user-facing number, mm. Drives every axis unless `axes` overrides it. */
  value: number;
  mode: ClearanceMode;
  /** Optional per-axis override; any axis left out falls back to `value`. */
  axes?: Partial<ClearanceAxes>;
  /** The preset this came from, for UI labelling only. */
  presetId?: string;
}

export interface ClearancePreset {
  id: string;
  label: string;
  material: string;
  fit: 'press' | 'slip' | 'rotating' | 'loose';
  spec: ClearanceSpec;
  /** Filled in by the tolerance-coupon workflow once the user calibrates. */
  calibrated?: { date: string; nozzle: number; layerHeight: number; note?: string };
}

export interface BayonetParams {
  dia: number;
  lugW: number;
  lugLen: number;
  lugTh: number;
  grooveH: number;
  depth: number;
  x: number;
  z: number;
}

export interface BaseSpec {
  type: BaseType;
  /** box + hbox */
  w: number;
  d: number;
  h: number;
  /** cyl + cup */
  r: number;
  /** hbox + cup */
  wall: number;
  floor: number;
  /** stl — the mesh itself lives outside undo history, see state/assets.ts */
  stlName: string;
  stlW: number;
  stlD: number;
  stlH: number;
  stlTris: number;
  /** Interpretation of the imported file's axes; the stored mesh is never re-baked. */
  stlUpAxis: UpAxis;
}

/** Which hole the mating insert is generated from. */
export type InsertSource =
  | { kind: 'group'; groupId: string }
  | { kind: 'cutter'; cutterId: number };

export interface InsertSpec {
  source: InsertSource | null;
  withCap: boolean;
}

export interface AppState {
  base: BaseSpec;
  cutters: Cutter[];
  groups: Record<string, BayonetParams>;
  nextId: number;
  nextGroup: number;
  selected: number | null;
  /** Project-wide default; individual cutters may override it. */
  clearance: ClearanceSpec;
  presets: ClearancePreset[];
  insert: InsertSpec & { generated: boolean; label: string };
  autoPreview: boolean;
  /** Show the rotation gizmo on the selected cutter. */
  showGizmo: boolean;
  /** Render the body translucent so buried cutters are visible inside it. */
  xray: boolean;
}

/**
 * Starting values for a 0.4 mm nozzle on a P1S. Users are expected to replace these by
 * calibrating with a tolerance coupon.
 *
 * These are the spec's table with every value doubled, because the spec states a
 * total-gap convention but lists the familiar *per-side* FDM numbers (0.10 / 0.20 /
 * 0.30 / 0.40). Read as totals those would halve every fit — a "slip fit" at 0.1 mm per
 * side is a press fit in practice. Doubling keeps the fit names honest under the
 * total-gap convention, and keeps `pla-slip` identical to what this app shipped before
 * clearance became a first-class model.
 */
export function builtInPresets(): ClearancePreset[] {
  const p = (
    id: string,
    label: string,
    material: string,
    fit: ClearancePreset['fit'],
    value: number,
  ): ClearancePreset => ({ id, label, material, fit, spec: { value, mode: 'insert', presetId: id } });

  return [
    p('pla-press', 'PLA · Press fit', 'PLA', 'press', 0.2),
    p('pla-slip', 'PLA · Slip fit', 'PLA', 'slip', 0.4),
    p('pla-rotating', 'PLA · Rotating fit', 'PLA', 'rotating', 0.6),
    p('pla-loose', 'PLA · Loose', 'PLA', 'loose', 0.8),
    p('petg-slip', 'PETG · Slip fit', 'PETG', 'slip', 0.5),
    p('petg-rotating', 'PETG · Rotating fit', 'PETG', 'rotating', 0.7),
    p('tpu-slip', 'TPU 95A · Slip fit', 'TPU 95A', 'slip', 0.7),
  ];
}

export function initialState(): AppState {
  return {
    base: {
      type: 'hbox',
      w: 80,
      d: 60,
      h: 40,
      r: 30,
      wall: 3,
      floor: 3,
      stlName: '',
      stlW: 0,
      stlD: 0,
      stlH: 0,
      stlTris: 0,
      stlUpAxis: 'z',
    },
    cutters: [],
    groups: {},
    nextId: 1,
    nextGroup: 1,
    selected: null,
    clearance: { value: 0.4, mode: 'insert', presetId: 'pla-slip' },
    presets: builtInPresets(),
    insert: { source: null, withCap: true, generated: false, label: '' },
    autoPreview: true,
    showGizmo: true,
    xray: true,
  };
}

/* --- derived dimensions, used everywhere (main thread + worker) --- */

export function baseHeight(b: BaseSpec): number {
  return b.type === 'stl' ? b.stlH : b.h;
}

export function baseSpanX(b: BaseSpec): number {
  if (b.type === 'stl') return b.stlW || 60;
  if (b.type === 'cyl' || b.type === 'cup') return b.r * 2;
  return b.w;
}

export function baseSpanZ(b: BaseSpec): number {
  if (b.type === 'stl') return b.stlD || 60;
  if (b.type === 'cyl' || b.type === 'cup') return b.r * 2;
  return b.d;
}

/**
 * True when the base is untouched — the default type at its default proportions and no
 * imported mesh. Drives whether there is anything for Reset to undo.
 */
export function isBaseDefault(b: BaseSpec): boolean {
  const d = initialState().base;
  if (b.type === 'stl' || b.stlName) return false;
  return (
    b.type === d.type &&
    b.w === d.w &&
    b.d === d.d &&
    b.h === d.h &&
    b.r === d.r &&
    b.wall === d.wall &&
    b.floor === d.floor
  );
}

/** Short human label for the current base, for the action bar's badge. */
export function describeBase(b: BaseSpec): string {
  if (b.type === 'stl') return b.stlName || 'Imported STL';
  return {
    box: 'Solid box',
    hbox: 'Hollow box',
    cyl: 'Solid cylinder',
    cup: 'Cup',
    stl: 'Imported STL',
  }[b.type];
}

/** Where the generated insert is parked in the viewport, clear of the body. */
export function insertPreviewX(b: BaseSpec): number {
  return baseSpanX(b) / 2 + 30;
}
