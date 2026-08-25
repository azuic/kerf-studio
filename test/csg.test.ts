/**
 * Headless checks on the boolean core and the STL round-trip.
 *
 * Run with: npm test
 *
 * These assert *geometric* facts — signed volume against hand-computed values, and
 * surface closure — because a boolean that silently returns a broken mesh still
 * typechecks, still renders, and still exports.
 *
 * Note on closure: three-bvh-csg re-triangulates clipped faces in a way that leaves
 * T-junctions, so boolean output is not edge-manifold (a bare box−box through the
 * library has them too). It *is* closed, which is what matters for volume and for
 * slicers. So results are checked with `closureResidual` (Σ area-weighted normals,
 * zero on any closed surface, unaffected by T-junctions) rather than by edge pairing.
 * `checkMesh`'s edge test is reserved for imported STLs, where an unmatched edge is a
 * genuine defect.
 */
import { buildBody, buildInsert } from '../src/csg/booleans';
import {
  boundsOf,
  centerOnPlate,
  checkMesh,
  encodeBinarySTL,
  orientToYUp,
  parseSTL,
} from '../src/io/stl';
import { BURIED_OVERSHOOT, cutterMatrix, defaultParams } from '../src/model/geometry';
import { migrateState } from '../src/state/migrate';
import type { BaseSpec, Cutter } from '../src/types';
import { initialState } from '../src/types';
import { Vector3 } from 'three';

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  checks++;
  if (condition) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(label: string, actual: number, expected: number, tolPct: number): void {
  const err = Math.abs(actual - expected) / Math.abs(expected);
  ok(
    label,
    err <= tolPct / 100,
    `got ${actual.toFixed(2)}, expected ≈${expected.toFixed(2)} (${(err * 100).toFixed(3)}% off)`,
  );
}

/** Signed volume via the divergence theorem. */
function volume(p: Float32Array): number {
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
    const cx = p[i + 6], cy = p[i + 7], cz = p[i + 8];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

/**
 * Σ (area-weighted normal) / Σ area. Exactly zero on a closed surface whatever its
 * triangulation; a real hole pushes it up by roughly the hole's share of total area.
 */
function closureResidual(p: Float32Array): number {
  let sx = 0, sy = 0, sz = 0, total = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    sx += cx; sy += cy; sz += cz;
    total += Math.hypot(cx, cy, cz);
  }
  return Math.hypot(sx, sy, sz) / (total || 1);
}

function closed(label: string, p: Float32Array): void {
  const r = closureResidual(p);
  ok(`${label} is closed`, r < 1e-6, `residual ${r.toExponential(2)}`);
}

function baseOf(over: Partial<BaseSpec>): BaseSpec {
  return { ...initialState().base, ...over };
}

function cutter(over: Partial<Cutter> & { type: Cutter['type'] }, base: BaseSpec): Cutter {
  return {
    id: 1,
    name: 'test',
    enabled: true,
    group: null,
    params: defaultParams(over.type, base),
    ...over,
  };
}

/** Area of a regular n-gon inscribed in radius r — the cylinders are faceted, not round. */
function ngonArea(r: number, n: number): number {
  return 0.5 * n * r * r * Math.sin((2 * Math.PI) / n);
}

console.log('\nsolid box, no cutters');
{
  const base = baseOf({ type: 'box', w: 80, d: 60, h: 40 });
  const r = buildBody(base, [], null);
  ok('produces triangles', r.triangles > 0, `${r.triangles} tris`);
  near('volume = 80×60×40', volume(r.position), 192_000, 0.01);
  ok('untouched base is edge-manifold', checkMesh(r.position).ok);
}

console.log('\nsolid box minus a round hole');
{
  const base = baseOf({ type: 'box', w: 80, d: 60, h: 40 });
  const c = cutter({ type: 'cyl' }, base);
  c.params = { ...c.params, dia: 10, depth: 20 };
  const r = buildBody(base, [c], null);
  // 48-segment cylinder, so the removed prism is an n-gon not a circle.
  near('volume = box − hole', volume(r.position), 192_000 - ngonArea(5, 48) * 20, 0.05);
  closed('result', r.position);
}

console.log('\nsurface cut overshoots the top face');
{
  // topOffset 0 must extend the cutter 1 mm above the surface, or the coplanar top
  // faces make the boolean ambiguous. Same cut started 5 mm down must not breach the top.
  const base = baseOf({ type: 'box', w: 40, d: 40, h: 20 });
  const surface = cutter({ type: 'cyl' }, base);
  surface.params = { ...surface.params, dia: 8, depth: 10 };
  const buried = cutter({ type: 'cyl', id: 2 }, base);
  // 5 mm below the top face, so it needs no surface overshoot.
  buried.params = { ...buried.params, dia: 8, depth: 10, y: 20 - 5, overshoot: BURIED_OVERSHOOT };

  const a = buildBody(base, [surface], null);
  const b = buildBody(base, [buried], null);
  const prism = ngonArea(4, 48) * 10;
  near('surface cut removes a full prism', volume(a.position), 40 * 40 * 20 - prism, 0.05);
  near('buried cut removes the same volume', volume(b.position), 40 * 40 * 20 - prism, 0.05);
  closed('surface cut', a.position);
  closed('buried cut', b.position);
}

console.log('\nhollow box (open top)');
{
  const base = baseOf({ type: 'hbox', w: 80, d: 60, h: 40, wall: 3, floor: 3 });
  const r = buildBody(base, [], null);
  // The inner void overshoots the open top by 1 mm, so only 37 mm of it is inside.
  near('volume = shell', volume(r.position), 80 * 60 * 40 - 74 * 54 * 37, 0.01);
  closed('result', r.position);
}

console.log('\nwall gap punches both side walls but spares the floor');
{
  const base = baseOf({ type: 'hbox', w: 80, d: 60, h: 40, wall: 3, floor: 3 });
  const plain = buildBody(base, [], null);
  const gap = cutter({ type: 'gap' }, base);
  gap.params = { ...gap.params, w: 90, l: 3, depth: 24 };
  const r = buildBody(base, [gap], null);
  // Only the two 3 mm walls stand in the gap's path at that height; the floor is below it.
  near(
    'volume = shell − both walls',
    volume(r.position),
    volume(plain.position) - 2 * (3 * 3 * 24),
    0.5,
  );
  ok('floor survives', volume(r.position) > 0);
  closed('result', r.position);
}

console.log('\ncutters compose: two holes remove both volumes');
{
  const base = baseOf({ type: 'box', w: 60, d: 60, h: 30 });
  const one = cutter({ type: 'cyl', id: 1 }, base);
  one.params = { ...one.params, dia: 8, depth: 10, x: -15 };
  const two = cutter({ type: 'cyl', id: 2 }, base);
  two.params = { ...two.params, dia: 8, depth: 10, x: 15 };
  const r = buildBody(base, [one, two], null);
  near('volume = box − 2 holes', volume(r.position), 60 * 60 * 30 - 2 * ngonArea(4, 48) * 10, 0.05);
  closed('result', r.position);

  const disabled = buildBody(base, [one, { ...two, enabled: false }], null);
  near('disabled cutter is skipped', volume(disabled.position), 60 * 60 * 30 - ngonArea(4, 48) * 10, 0.05);
}

console.log('\nbayonet set: shaft + lug entry + buried groove');
{
  const base = baseOf({ type: 'box', w: 60, d: 60, h: 30 });
  const P = { dia: 12, lugW: 4, lugLen: 3.2, lugTh: 3, grooveH: 3.6, depth: 12, x: 0, z: 0 };
  const surface = { x: 0, y: 30, z: 0, rotX: 0, rotY: 0, rotZ: 0, overshoot: 1 };
  const cutters: Cutter[] = [
    cutter(
      { type: 'cyl', id: 1, group: 'G1', params: { ...surface, dia: P.dia, depth: P.depth } },
      base,
    ),
    cutter(
      {
        type: 'box',
        id: 2,
        group: 'G1',
        params: { ...surface, w: P.dia + 2 * P.lugLen, l: P.lugW, depth: P.depth },
      },
      base,
    ),
    cutter(
      {
        type: 'groove',
        id: 3,
        group: 'G1',
        params: {
          ...surface,
          y: 30 - (P.depth - P.grooveH),
          dia: P.dia + 2 * P.lugLen,
          depth: P.grooveH,
          overshoot: BURIED_OVERSHOOT,
        },
      },
      base,
    ),
  ];
  const r = buildBody(base, cutters, null);
  ok('produces triangles', r.triangles > 0, `${r.triangles} tris`);
  closed('result', r.position);

  // The groove must be strictly wider than the shaft — that overhang is what traps the lug.
  const shaftOnly = buildBody(base, [cutters[0]], null);
  ok(
    'groove + notch remove more than the shaft alone',
    volume(r.position) < volume(shaftOnly.position),
    `${volume(r.position).toFixed(0)} < ${volume(shaftOnly.position).toFixed(0)} mm³`,
  );
}

console.log('\ntwist-lock pin (union of shaft + lug + knob)');
{
  const P = { dia: 12, lugW: 4, lugLen: 3.2, lugTh: 3, grooveH: 3.6, depth: 12, x: 0, z: 0 };
  const withKnob = buildInsert({ kind: 'group', params: P }, 0.2, true, 60);
  const noKnob = buildInsert({ kind: 'group', params: P }, 0.2, false, 60);
  ok('produces triangles', withKnob.triangles > 0, `${withKnob.triangles} tris`);
  closed('pin', withKnob.position);
  ok('has positive volume', volume(withKnob.position) > 0, `${volume(withKnob.position).toFixed(1)} mm³`);
  ok('knob adds volume', volume(withKnob.position) > volume(noKnob.position));

  // The pin's shaft must clear the shaft hole it drops into.
  const shaftHole = ngonArea(P.dia / 2, 48) * P.depth;
  const shaftPin = ngonArea((P.dia - 2 * 0.2) / 2, 48) * (P.depth - 0.2);
  ok('shaft is undersized by the clearance', shaftPin < shaftHole);
}

console.log('\nplain insert fits its hole');
{
  const base = baseOf({ type: 'box', w: 60, d: 60, h: 30 });
  const c = cutter({ type: 'cyl' }, base);
  c.params = { ...c.params, dia: 10, depth: 15 };
  const clearance = 0.2;
  const ins = buildInsert({ kind: 'cutter', cutter: c }, clearance, false, 60);
  closed('insert', ins.position);
  near(
    'volume = shrunk shaft',
    volume(ins.position),
    ngonArea((10 - 2 * clearance) / 2, 48) * (15 - clearance),
    0.5,
  );

  const bigger = buildInsert({ kind: 'cutter', cutter: c }, 0.05, false, 60);
  ok('tighter clearance means more material', volume(bigger.position) > volume(ins.position));
}

console.log('\ncutters aim in any direction');
{
  const base = baseOf({ type: 'box', w: 40, d: 40, h: 20 });

  // A cutter is anchored at its entry point, so the transform must map the entry face
  // centre — local (0, h/2 − overshoot, 0) — exactly onto (x, y, z) whatever the rotation.
  const aimed = cutter({ type: 'cyl' }, base);
  aimed.params = {
    ...aimed.params,
    dia: 8,
    depth: 12,
    x: -20,
    y: 10,
    z: 3,
    rotX: 15,
    rotY: 40,
    rotZ: -90,
  };
  const h = aimed.params.depth + aimed.params.overshoot;
  const entry = new Vector3(0, h / 2 - aimed.params.overshoot, 0).applyMatrix4(
    cutterMatrix(aimed.params),
  );
  ok(
    'rotation pivots about the entry point',
    entry.distanceTo(new Vector3(-20, 10, 3)) < 1e-6,
    `entry landed at ${entry.toArray().map((n) => n.toFixed(3)).join(', ')}`,
  );

  // Side entry: enter the −X face at mid height and drive through in +X. The cut runs
  // along local −Y, so +90° about Z swings that onto +X.
  const through = cutter({ type: 'cyl', id: 2 }, base);
  through.params = {
    ...through.params,
    dia: 8,
    depth: 50,
    x: -20,
    y: 10,
    z: 0,
    rotZ: 90,
  };
  const side = buildBody(base, [through], null);
  near(
    'side-entry hole removes a prism through the full width',
    volume(side.position),
    40 * 40 * 20 - ngonArea(4, 48) * 40,
    0.05,
  );
  closed('side-entry result', side.position);

  // Aiming a surface cutter straight back out of the material removes nothing. The
  // overshoot is dropped here because flipping the cutter buries it in the material —
  // which is correct, but it would leave a 1 mm dimple and muddy the assertion.
  const outward = cutter({ type: 'cyl', id: 3 }, base);
  outward.params = { ...outward.params, dia: 8, depth: 10, rotX: 180, overshoot: 0 };
  const nothing = buildBody(base, [outward], null);
  near('a cut aimed out of the model removes nothing', volume(nothing.position), 40 * 40 * 20, 0.01);

  // ...and with the overshoot left on, exactly that sliver goes.
  const dimple = cutter({ type: 'cyl', id: 6 }, base);
  dimple.params = { ...dimple.params, dia: 8, depth: 10, rotX: 180 };
  near(
    'a flipped cutter buries only its overshoot',
    volume(buildBody(base, [dimple], null).position),
    40 * 40 * 20 - ngonArea(4, 48) * 1,
    0.05,
  );

  // Tilting must not change how much is removed while the cut stays buried.
  const straight = cutter({ type: 'cyl', id: 4 }, base);
  straight.params = { ...straight.params, dia: 6, depth: 8 };
  const tilted = cutter({ type: 'cyl', id: 5 }, base);
  tilted.params = { ...tilted.params, dia: 6, depth: 8, rotZ: 20 };
  const vs = volume(buildBody(base, [straight], null).position);
  const vt = volume(buildBody(base, [tilted], null).position);
  near('a 20° tilt removes the same volume', vt, vs, 0.5);
}

console.log('\nlegacy projects migrate to 3D cutters');
{
  const base = baseOf({ type: 'box', w: 80, d: 60, h: 40 });

  // Exactly what an older .kerf.json holds: vertical only, anchored below the top.
  const legacy = {
    ...initialState(),
    base,
    cutters: [
      {
        id: 1,
        type: 'cyl' as const,
        name: 'old hole',
        enabled: true,
        group: null,
        params: { dia: 10, depth: 20, topOffset: 0, x: 0, z: 0, rotY: 0 },
      },
      {
        id: 2,
        type: 'groove' as const,
        name: 'old groove',
        enabled: true,
        group: null,
        params: { dia: 16, depth: 4, topOffset: 12, x: 0, z: 0, rotY: 0 },
      },
    ],
  };

  const migrated = migrateState(legacy as never);
  const p0 = migrated.cutters[0].params;
  ok('surface cut anchors at the model top', p0.y === 40, `y = ${p0.y}`);
  ok('surface cut keeps its overshoot', p0.overshoot === 1);
  ok('topOffset is gone', !('topOffset' in p0));
  ok('new rotation axes default to zero', p0.rotX === 0 && p0.rotZ === 0);

  const p1 = migrated.cutters[1].params;
  ok('buried cut anchors below the top', p1.y === 40 - 12, `y = ${p1.y}`);
  ok('buried cut takes the small overshoot', p1.overshoot === BURIED_OVERSHOOT);

  // The real assertion: migration must not move any material.
  const modern = cutter({ type: 'cyl' }, base);
  modern.params = { ...modern.params, dia: 10, depth: 20 };
  near(
    'migrated geometry matches an equivalent new cutter',
    volume(buildBody(base, [migrated.cutters[0]], null).position),
    volume(buildBody(base, [modern], null).position),
    0.001,
  );

  ok('migrating twice is a no-op', migrateState(migrated).cutters[0].params.y === 40);
}

console.log('\nimported STL orientation');
{
  // A tall box authored Y-up: 10 wide (X), 20 deep (Z), 40 tall (Y).
  const upright = buildBody(baseOf({ type: 'box', w: 10, d: 20, h: 40 }), [], null).position;

  // The same solid as a Z-up file writes it: undo the Z-up→Y-up rotation, so
  // (x, y, z) → (x, −z, y). This is what a CAD/slicer STL actually contains.
  const zUpFile = new Float32Array(upright);
  for (let i = 0; i < zUpFile.length; i += 3) {
    const y = zUpFile[i + 1];
    zUpFile[i + 1] = -zUpFile[i + 2];
    zUpFile[i + 2] = y;
  }
  const fileBounds = boundsOf(zUpFile);
  ok(
    'the Z-up file really is lying on its side in raw coords',
    Math.abs(fileBounds.maxY - fileBounds.minY - 20) < 1e-4,
    `raw Y extent ${(fileBounds.maxY - fileBounds.minY).toFixed(1)} mm`,
  );

  const asZ = orientToYUp(zUpFile, 'z');
  const zBounds = centerOnPlate(asZ);
  near('Z-up import: height', zBounds.maxY, 40, 0.01);
  near('Z-up import: width X', zBounds.maxX - zBounds.minX, 10, 0.01);
  near('Z-up import: depth Z', zBounds.maxZ - zBounds.minZ, 20, 0.01);
  ok('Z-up import sits on the plate', Math.abs(zBounds.minY) < 1e-6, `minY ${zBounds.minY}`);
  near('rotation preserves volume and winding', volume(asZ), 8_000, 0.01);
  closed('re-oriented mesh', asZ);

  // Misreading the same file as Y-up must tip it over — that was the ported bug.
  const asY = orientToYUp(zUpFile, 'y');
  const yBounds = centerOnPlate(asY);
  near('Y-up reading: height is the wrong axis', yBounds.maxY, 20, 0.01);
  ok('the two readings differ', Math.abs(zBounds.maxY - yBounds.maxY) > 1, 'tipped 90°');
  ok('but both still sit on the plate', Math.abs(yBounds.minY) < 1e-6);

  // Orienting must never mutate the caller's buffer, or flipping the axis twice
  // would compound rotations.
  const after = boundsOf(zUpFile);
  ok(
    'the raw file is left untouched',
    after.minY === fileBounds.minY && after.maxY === fileBounds.maxY,
  );
  const twice = centerOnPlate(orientToYUp(zUpFile, 'z'));
  near('re-orienting is idempotent', twice.maxY, 40, 0.01);
}

console.log('\nSTL round-trip');
{
  const base = baseOf({ type: 'box', w: 20, d: 20, h: 20 });
  const r = buildBody(base, [], null);
  const parsed = parseSTL(encodeBinarySTL(r.position));
  ok('triangle count survives', parsed.triangles === r.triangles, `${parsed.triangles} tris`);
  near('volume survives', volume(parsed.positions), volume(r.position), 0.001);
  ok('re-parsed mesh is edge-manifold', checkMesh(parsed.positions).ok);
}

console.log('\nASCII STL parses too');
{
  const ascii = `solid t
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
endsolid t`;
  const parsed = parseSTL(new TextEncoder().encode(ascii).buffer as ArrayBuffer);
  ok('one triangle', parsed.triangles === 1, `${parsed.triangles} tris`);
  ok('vertex read back', parsed.positions[3] === 1);
}

console.log('\nmesh check catches a hole');
{
  const base = baseOf({ type: 'box', w: 10, d: 10, h: 10 });
  const r = buildBody(base, [], null);
  const punctured = r.position.slice(0, r.position.length - 9); // drop one triangle
  const c = checkMesh(punctured);
  ok('reports open edges', !c.ok && c.openEdges === 3, `openEdges=${c.openEdges}`);
  ok('and the hole shows up as non-closure', closureResidual(punctured) > 1e-3);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
