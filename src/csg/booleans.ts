import type { BufferGeometry } from 'three';
import { MeshBasicMaterial } from 'three';
import { ADDITION, Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import {
  bayonetPinSolids,
  baseSolids,
  cutterInsertSolids,
  cutterSolid,
  type Solid,
} from '../model/geometry';
import type { BaseSpec, BayonetParams, Cutter } from '../types';
import type { GeometryPayload, InsertRecipe } from './protocol';

/**
 * The boolean core. Deliberately free of any worker plumbing so it can be exercised
 * headlessly — csg/worker.ts is only a message shell around these two functions.
 */

const evaluator = new Evaluator();
evaluator.useGroups = false;
evaluator.attributes = ['position', 'normal'];

const material = new MeshBasicMaterial();

/**
 * A fresh object every time — the caller transfers these buffers to the main thread,
 * which detaches them, so a shared singleton would be dead after the first use.
 */
export function emptyPayload(): GeometryPayload {
  return { position: new Float32Array(0), normal: new Float32Array(0), triangles: 0 };
}

function toBrush(s: Solid): Brush {
  const brush = new Brush(s.geom, material);
  s.matrix.decompose(brush.position, brush.quaternion, brush.scale);
  brush.updateMatrixWorld(true);
  return brush;
}

/**
 * Every geometry reaching here is built fresh by the factories in model/geometry.ts,
 * so intermediates can always be disposed.
 */
function dispose(b: Brush): void {
  (b.geometry as BufferGeometry).dispose();
}

function apply(acc: Brush, s: Solid, op: number): Brush {
  const operand = toBrush(s);
  const next = evaluator.evaluate(acc, operand, op) as Brush;
  dispose(acc);
  dispose(operand);
  return next;
}

export function payloadFrom(geom: BufferGeometry): GeometryPayload {
  // three-bvh-csg emits an indexed result; flat shading, the STL writer and the ghost
  // pipeline all want a plain triangle soup, so expand it once here.
  const flat = geom.index ? geom.toNonIndexed() : geom;
  const position = new Float32Array(flat.attributes.position.array as ArrayLike<number>);
  const normalAttr = flat.attributes.normal;
  const normal = normalAttr
    ? new Float32Array(normalAttr.array as ArrayLike<number>)
    : new Float32Array(position.length);
  if (flat !== geom) flat.dispose();
  return { position, normal, triangles: position.length / 9 };
}

/** Base solid, hollowed if the type calls for it, minus every enabled cutter. */
export function buildBody(
  base: BaseSpec,
  cutters: Cutter[],
  stlPositions: Float32Array | null,
): GeometryPayload {
  const { outer, inner } = baseSolids(base, stlPositions);
  if (!outer) return emptyPayload();

  let acc = toBrush(outer);
  if (inner) acc = apply(acc, inner, SUBTRACTION);
  for (const c of cutters) {
    if (c.enabled) acc = apply(acc, cutterSolid(c, base), SUBTRACTION);
  }

  const payload = payloadFrom(acc.geometry as BufferGeometry);
  dispose(acc);
  return payload;
}

/** Mating part: the shaft/lug/knob pieces (or the shrunk hole profile) unioned together. */
export function buildInsert(
  recipe: InsertRecipe,
  clearance: number,
  withCap: boolean,
  px: number,
): GeometryPayload {
  const solids =
    recipe.kind === 'group'
      ? bayonetPinSolids(recipe.params as BayonetParams, clearance, withCap, px)
      : cutterInsertSolids(recipe.cutter, clearance, withCap, px);
  if (solids.length === 0) return emptyPayload();

  let acc = toBrush(solids[0]);
  for (let i = 1; i < solids.length; i++) acc = apply(acc, solids[i], ADDITION);

  const payload = payloadFrom(acc.geometry as BufferGeometry);
  dispose(acc);
  return payload;
}
