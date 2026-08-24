/**
 * Browser-side check of the worker plumbing: message shapes, buffer transfer, request
 * superseding. The boolean maths itself is covered headlessly in csg.test.ts; this only
 * proves the pieces talk to each other. No WebGL, so it runs in headless Chrome.
 *
 * Serve with `npm run dev` and open /test/worker-check.html.
 */
import { CsgEngine, StaleRequestError } from '../src/csg/engine';
import { initialState } from '../src/types';
import type { Cutter } from '../src/types';

const out = document.getElementById('out') as HTMLPreElement;
const lines: string[] = [];
let failures = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures++;
  lines.push(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  out.textContent = lines.join('\n');
}

async function run(): Promise<void> {
  const engine = new CsgEngine();
  const base = { ...initialState().base, type: 'box' as const, w: 80, d: 60, h: 40 };
  const cutter: Cutter = {
    id: 1,
    type: 'cyl',
    name: 'hole',
    enabled: true,
    group: null,
    params: { dia: 10, depth: 20, topOffset: 0, x: 0, z: 0, rotY: 0 },
  };

  let timed = 0;
  engine.onTiming = () => timed++;

  const plain = await engine.body(base, []);
  ok('body round-trips through the worker', plain.triangles === 12, `${plain.triangles} tris`);
  ok('position buffer arrived intact', plain.position.length === 12 * 9);
  ok('normals came back', plain.normal.length === plain.position.length);

  const cutBody = await engine.body(base, [cutter]);
  ok('cutter is applied', cutBody.triangles > plain.triangles, `${cutBody.triangles} tris`);
  ok('timing callback fired', timed >= 2, `${timed} reports`);

  // Superseding: the first of two back-to-back body requests must be rejected as stale.
  const first = engine.body(base, [cutter]);
  const second = engine.body(base, []);
  let staleSeen = false;
  await first.catch((e: unknown) => {
    staleSeen = e instanceof StaleRequestError;
  });
  const secondResult = await second;
  ok('older body request is superseded', staleSeen);
  ok('newer body request still resolves', secondResult.triangles === 12);

  const insert = await engine.insert({ kind: 'cutter', cutter }, 0.2, false, 60);
  ok('insert round-trips', insert.triangles > 0, `${insert.triangles} tris`);

  // An STL base with no mesh set must come back empty rather than throwing.
  const empty = await engine.body({ ...base, type: 'stl' }, []);
  ok('empty STL base returns nothing', empty.triangles === 0);

  // A real STL base: one tetrahedron, sent through setStl.
  await engine.setStl(
    new Float32Array([
      0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 10, 0, 0, 0, 0, 0, 0, 0, 10, 0, 10, 0, 10, 0,
      0, 0, 10, 0, 0, 0, 10,
    ]),
  );
  const stlBody = await engine.body({ ...base, type: 'stl', stlH: 10 }, []);
  ok('STL base is used', stlBody.triangles > 0, `${stlBody.triangles} tris`);

  await engine.clearStl();
  const cleared = await engine.body({ ...base, type: 'stl' }, []);
  ok('clearStl empties the base', cleared.triangles === 0);

  engine.dispose();
  lines.push(failures === 0 ? 'ALL OK' : `${failures} FAILURES`);
  out.textContent = lines.join('\n');
  document.title = failures === 0 ? 'ALL OK' : `${failures} FAILURES`;
}

run().catch((e: unknown) => {
  failures++;
  lines.push(`THREW ${e instanceof Error ? e.message : String(e)}`);
  out.textContent = lines.join('\n');
  document.title = 'THREW';
});
