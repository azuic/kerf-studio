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

export interface CutterParams {
  /** cyl + groove: hole diameter (mm) */
  dia?: number;
  /** hex: across-flats (mm) */
  af?: number;
  /** box + gap: X width (mm) */
  w?: number;
  /** box + gap: Z length (mm) */
  l?: number;
  /** How deep the cut goes, measured from its start (mm). */
  depth: number;
  /** Start the cut this far *below* the model top. 0 = cut from the surface. */
  topOffset: number;
  x: number;
  z: number;
  /** Rotation about Y, degrees. */
  rotY: number;
}

export interface Cutter {
  id: number;
  type: CutterType;
  name: string;
  enabled: boolean;
  /** Bayonet set membership, e.g. "G1". Null for loose cutters. */
  group: string | null;
  params: CutterParams;
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
  clearance: number;
  withCap: boolean;
}

export interface AppState {
  base: BaseSpec;
  cutters: Cutter[];
  groups: Record<string, BayonetParams>;
  nextId: number;
  nextGroup: number;
  selected: number | null;
  insert: InsertSpec & { generated: boolean; label: string };
  autoPreview: boolean;
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
    insert: { source: null, clearance: 0.2, withCap: true, generated: false, label: '' },
    autoPreview: true,
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

/** Where the generated insert is parked in the viewport, clear of the body. */
export function insertPreviewX(b: BaseSpec): number {
  return baseSpanX(b) / 2 + 30;
}
