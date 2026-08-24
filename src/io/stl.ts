/**
 * STL import and export, in millimetres.
 *
 * Ported from the v1 prototype — the parser and the binary writer both worked; only
 * their data type changed (triangle-soup Float32Array instead of BSP polygons).
 */

export interface ParsedStl {
  positions: Float32Array;
  triangles: number;
}

/** Autodetects ASCII vs binary. Returns a raw triangle soup, no normals. */
export function parseSTL(buf: ArrayBuffer): ParsedStl {
  const u8 = new Uint8Array(buf);
  const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 512)));
  const isAscii = head.trimStart().toLowerCase().startsWith('solid') && head.includes('facet');

  if (isAscii) {
    const text = new TextDecoder().decode(u8);
    const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    const out: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    }
    if (out.length === 0) throw new Error('no vertices found');
    if (out.length % 9 !== 0) throw new Error('vertex count is not a whole number of triangles');
    return { positions: new Float32Array(out), triangles: out.length / 9 };
  }

  if (buf.byteLength < 84) throw new Error('file too small');
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  if (84 + n * 50 > buf.byteLength) throw new Error('triangle count mismatch');

  const positions = new Float32Array(n * 9);
  let off = 84;
  let w = 0;
  for (let i = 0; i < n; i++) {
    off += 12; // skip the stored facet normal; we recompute on export
    for (let v = 0; v < 3; v++) {
      positions[w++] = dv.getFloat32(off, true);
      positions[w++] = dv.getFloat32(off + 4, true);
      positions[w++] = dv.getFloat32(off + 8, true);
      off += 12;
    }
    off += 2; // attribute byte count
  }
  return { positions, triangles: n };
}

export interface Bounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export function boundsOf(positions: Float32Array): Bounds {
  const b: Bounds = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (z < b.minZ) b.minZ = z;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
    if (z > b.maxZ) b.maxZ = z;
  }
  return b;
}

/** Centre in XZ and drop min-Y to the plate, matching the v1 import convention. */
export function centerOnPlate(positions: Float32Array): Bounds {
  const b = boundsOf(positions);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= cx;
    positions[i + 1] -= b.minY;
    positions[i + 2] -= cz;
  }
  return boundsOf(positions);
}

/**
 * A cheap manifold sanity check: in a closed mesh every edge is shared by exactly two
 * triangles. Reports the counts rather than refusing the import, because plenty of
 * usable models have a handful of bad edges.
 */
export interface MeshCheck {
  openEdges: number;
  nonManifoldEdges: number;
  degenerate: number;
  ok: boolean;
}

export function checkMesh(positions: Float32Array): MeshCheck {
  const triCount = positions.length / 9;
  const key = (a: number, b: number): string => {
    // Quantise to 1e-4 mm so float noise from the exporter does not split shared edges.
    const q = (i: number) =>
      `${Math.round(positions[i] * 1e4)},${Math.round(positions[i + 1] * 1e4)},${Math.round(positions[i + 2] * 1e4)}`;
    const ka = q(a);
    const kb = q(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  const edges = new Map<string, number>();
  let degenerate = 0;

  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const i1 = i0 + 3;
    const i2 = i0 + 6;
    if (isDegenerate(positions, i0, i1, i2)) {
      degenerate++;
      continue;
    }
    for (const [a, b] of [
      [i0, i1],
      [i1, i2],
      [i2, i0],
    ] as const) {
      const k = key(a, b);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }

  let openEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edges.values()) {
    if (count === 1) openEdges++;
    else if (count > 2) nonManifoldEdges++;
  }
  return {
    openEdges,
    nonManifoldEdges,
    degenerate,
    ok: openEdges === 0 && nonManifoldEdges === 0,
  };
}

function isDegenerate(p: Float32Array, i0: number, i1: number, i2: number): boolean {
  const ax = p[i1] - p[i0];
  const ay = p[i1 + 1] - p[i0 + 1];
  const az = p[i1 + 2] - p[i0 + 2];
  const bx = p[i2] - p[i0];
  const by = p[i2 + 1] - p[i0 + 1];
  const bz = p[i2 + 2] - p[i0 + 2];
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return cx * cx + cy * cy + cz * cz < 1e-18;
}

/** Binary STL, little-endian, per-face normals recomputed, millimetres. */
export function encodeBinarySTL(positions: Float32Array): ArrayBuffer {
  const n = Math.floor(positions.length / 9);
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  new TextEncoder().encodeInto('Kerf Studio binary STL (mm)', new Uint8Array(buf, 0, 80));
  dv.setUint32(80, n, true);

  let off = 84;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const ax = positions[i];
    const ay = positions[i + 1];
    const az = positions[i + 2];
    const bx = positions[i + 3];
    const by = positions[i + 4];
    const bz = positions[i + 5];
    const cx = positions[i + 6];
    const cy = positions[i + 7];
    const cz = positions[i + 8];

    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    dv.setFloat32(off, nx, true);
    dv.setFloat32(off + 4, ny, true);
    dv.setFloat32(off + 8, nz, true);
    off += 12;
    for (let k = 0; k < 9; k++) {
      dv.setFloat32(off, positions[i + k], true);
      off += 4;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return buf;
}

export function downloadSTL(positions: Float32Array, filename: string): void {
  downloadBlob(new Blob([encodeBinarySTL(positions)], { type: 'model/stl' }), filename);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
