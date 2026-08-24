import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Matrix4,
} from 'three';
import type { BaseSpec, Cutter } from '../types';
import { baseHeight, baseSpanX } from '../types';

/**
 * A positioned solid: geometry in its own local frame plus the matrix that places it
 * in world (plate) space. Both the ghost renderer and the CSG worker consume these.
 */
export interface Solid {
  geom: BufferGeometry;
  matrix: Matrix4;
}

const RADIAL_SEGMENTS = 48;
const BASE_RADIAL_SEGMENTS = 64;

/**
 * three-bvh-csg requires every operand to carry the same attribute set. Everything
 * that enters a boolean goes through here first: position + normal, nothing else.
 */
export function normalizeForCSG(geom: BufferGeometry): BufferGeometry {
  for (const name of Object.keys(geom.attributes)) {
    if (name !== 'position' && name !== 'normal') geom.deleteAttribute(name);
  }
  if (!geom.attributes.normal) geom.computeVertexNormals();
  return geom;
}

function solid(geom: BufferGeometry, matrix: Matrix4): Solid {
  return { geom: normalizeForCSG(geom), matrix };
}

function translation(x: number, y: number, z: number): Matrix4 {
  return new Matrix4().makeTranslation(x, y, z);
}

/** Geometry from a raw triangle-soup position buffer (imported STL). */
export function geometryFromPositions(positions: Float32Array): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * The base model as an outer solid and an optional inner void to subtract.
 *
 * The inner void of a hollow type overshoots the open top by 1 mm so the boolean
 * never has to resolve coplanar faces — the same trick the cutters use.
 */
export function baseSolids(
  b: BaseSpec,
  stlPositions: Float32Array | null,
): { outer: Solid | null; inner: Solid | null } {
  switch (b.type) {
    case 'stl': {
      if (!stlPositions || stlPositions.length === 0) return { outer: null, inner: null };
      return { outer: solid(geometryFromPositions(stlPositions), new Matrix4()), inner: null };
    }
    case 'box':
      return { outer: solid(new BoxGeometry(b.w, b.h, b.d), translation(0, b.h / 2, 0)), inner: null };

    case 'cyl':
      return {
        outer: solid(
          new CylinderGeometry(b.r, b.r, b.h, BASE_RADIAL_SEGMENTS),
          translation(0, b.h / 2, 0),
        ),
        inner: null,
      };

    case 'hbox': {
      const ih = b.h - b.floor + 1;
      return {
        outer: solid(new BoxGeometry(b.w, b.h, b.d), translation(0, b.h / 2, 0)),
        inner: solid(
          new BoxGeometry(Math.max(1, b.w - 2 * b.wall), ih, Math.max(1, b.d - 2 * b.wall)),
          translation(0, b.floor + ih / 2, 0),
        ),
      };
    }

    case 'cup': {
      const ih = b.h - b.floor + 1;
      const ir = Math.max(0.5, b.r - b.wall);
      return {
        outer: solid(
          new CylinderGeometry(b.r, b.r, b.h, BASE_RADIAL_SEGMENTS),
          translation(0, b.h / 2, 0),
        ),
        inner: solid(
          new CylinderGeometry(ir, ir, ih, BASE_RADIAL_SEGMENTS),
          translation(0, b.floor + ih / 2, 0),
        ),
      };
    }
  }
}

/**
 * A cutter solid, positioned.
 *
 * Cuts always run downward (−Y). The solid's top sits at `baseHeight − topOffset`
 * and its bottom at that minus `depth`. When the cut starts at the surface the solid
 * is extended 1 mm *above* it, so the boolean never sees coplanar top faces.
 */
export function cutterSolid(c: Cutter, b: BaseSpec): Solid {
  const p = c.params;
  const top = baseHeight(b) - (p.topOffset || 0);
  const overshoot = (p.topOffset || 0) <= 0.001 ? 1.0 : 0.001;
  const h = p.depth + overshoot;

  let geom: BufferGeometry;
  if (c.type === 'cyl' || c.type === 'groove') {
    const r = Math.max(0.05, (p.dia ?? 10) / 2);
    geom = new CylinderGeometry(r, r, h, RADIAL_SEGMENTS);
  } else if (c.type === 'hex') {
    const R = Math.max(0.05, (p.af ?? 10) / 2) / Math.cos(Math.PI / 6);
    geom = new CylinderGeometry(R, R, h, 6);
  } else {
    geom = new BoxGeometry(Math.max(0.05, p.w ?? 10), h, Math.max(0.05, p.l ?? 10));
  }

  const cy = top - p.depth + h / 2;
  const matrix = translation(p.x || 0, cy, p.z || 0).multiply(
    new Matrix4().makeRotationY(((p.rotY || 0) * Math.PI) / 180),
  );
  return solid(geom, matrix);
}

/* ------------------------------------------------------------------ *
 * Mating inserts — every piece is unioned into one part.
 * ------------------------------------------------------------------ */

/** Twist-lock pin: shaft + lug bar + optional knob, parked beside the body. */
export function bayonetPinSolids(
  P: { dia: number; lugW: number; lugLen: number; grooveH: number; depth: number },
  clearance: number,
  withCap: boolean,
  px: number,
): Solid[] {
  const shaftH = Math.max(1, P.depth - clearance);
  const shaftR = Math.max(0.5, (P.dia - 2 * clearance) / 2);
  const out: Solid[] = [
    solid(
      new CylinderGeometry(shaftR, shaftR, shaftH, RADIAL_SEGMENTS),
      translation(px, shaftH / 2, 0),
    ),
  ];

  const lugTh = Math.max(0.8, P.grooveH - 0.6);
  const lugW = Math.max(0.8, P.lugW - 2 * clearance);
  const lugSpan = Math.max(1, P.dia + 2 * (P.lugLen - clearance));
  out.push(solid(new BoxGeometry(lugSpan, lugTh, lugW), translation(px, lugTh / 2, 0)));

  if (withCap) {
    const capR = (P.dia + 8) / 2;
    const capH = 4;
    out.push(
      solid(
        new CylinderGeometry(capR, capR, capH, RADIAL_SEGMENTS),
        translation(px, shaftH + capH / 2, 0),
      ),
    );
  }
  return out;
}

/** Plain insert: the hole's own cross-section shrunk by `clearance` per side. */
export function cutterInsertSolids(
  c: Cutter,
  clearance: number,
  withCap: boolean,
  px: number,
): Solid[] {
  const p = c.params;
  const h = Math.max(1, p.depth - clearance);
  const out: Solid[] = [];

  if (c.type === 'cyl' || c.type === 'groove') {
    const r = Math.max(0.5, ((p.dia ?? 10) - 2 * clearance) / 2);
    out.push(solid(new CylinderGeometry(r, r, h, RADIAL_SEGMENTS), translation(px, h / 2, 0)));
  } else if (c.type === 'hex') {
    const R = Math.max(0.5, ((p.af ?? 10) - 2 * clearance) / 2) / Math.cos(Math.PI / 6);
    out.push(solid(new CylinderGeometry(R, R, h, 6), translation(px, h / 2, 0)));
  } else {
    out.push(
      solid(
        new BoxGeometry(
          Math.max(0.5, (p.w ?? 10) - 2 * clearance),
          h,
          Math.max(0.5, (p.l ?? 10) - 2 * clearance),
        ),
        translation(px, h / 2, 0),
      ),
    );
  }

  if (withCap) {
    const capH = 3;
    if (c.type === 'cyl' || c.type === 'groove') {
      const r = (p.dia ?? 10) / 2 + 2;
      out.push(
        solid(new CylinderGeometry(r, r, capH, RADIAL_SEGMENTS), translation(px, h + capH / 2, 0)),
      );
    } else if (c.type === 'hex') {
      const R = ((p.af ?? 10) / 2 + 2) / Math.cos(Math.PI / 6);
      out.push(solid(new CylinderGeometry(R, R, capH, 6), translation(px, h + capH / 2, 0)));
    } else {
      out.push(
        solid(
          new BoxGeometry((p.w ?? 10) + 4, capH, (p.l ?? 10) + 4),
          translation(px, h + capH / 2, 0),
        ),
      );
    }
  }
  return out;
}

/** Default parameters for a freshly added cutter, scaled to the current model. */
export function defaultParams(type: Cutter['type'], b: BaseSpec): Cutter['params'] {
  const h = baseHeight(b) || 20;
  const depth = Math.max(4, h * 0.5);
  switch (type) {
    case 'cyl':
      return { dia: 10, depth, topOffset: 0, x: 0, z: 0, rotY: 0 };
    case 'hex':
      return { af: 10, depth, topOffset: 0, x: 0, z: 0, rotY: 0 };
    case 'box':
      return { w: 12, l: 8, depth, topOffset: 0, x: 0, z: 0, rotY: 0 };
    case 'gap':
      return {
        w: baseSpanX(b) + 10,
        l: 3,
        depth: Math.max(4, h * 0.6),
        topOffset: 0,
        x: 0,
        z: 0,
        rotY: 0,
      };
    case 'groove':
      return { dia: 16, depth: 3.6, topOffset: 0, x: 0, z: 0, rotY: 0 };
  }
}

export function defaultName(type: Cutter['type']): string {
  return {
    cyl: 'Round hole',
    box: 'Rect hole',
    hex: 'Hex hole',
    gap: 'Wall gap',
    groove: 'Lock groove',
  }[type];
}
