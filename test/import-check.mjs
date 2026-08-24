/**
 * End-to-end import check: feeds a genuine Z-up binary STL into the running app's file
 * input and asserts the dimensions it reports.
 *
 * The fixture is a 10 (X) × 20 (Y) × 40 (Z) box written the way CAD tools write STL —
 * Z-up, sitting on z = 0. Read correctly it must come out 10 wide, 20 deep and 40 tall.
 * Read as Y-up (the bug this covers) it comes out 20 tall and tipped on its side.
 *
 * Usage: npm run dev, then: node test/import-check.mjs [url]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5199/';
const PORT = 9334;
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* ---- fixture: a Z-up box, written by hand so the test does not lean on our own writer ---- */
function zUpBoxStl(sx, sy, sz) {
  const x0 = -sx / 2, x1 = sx / 2, y0 = -sy / 2, y1 = sy / 2, z0 = 0, z1 = sz;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [0, 3, 2, 1], // bottom (z0), outward = −Z
    [4, 5, 6, 7], // top (z1)
    [0, 1, 5, 4], // −Y
    [1, 2, 6, 5], // +X
    [2, 3, 7, 6], // +Y
    [3, 0, 4, 7], // −X
  ];
  const tris = [];
  for (const [a, b, d, e] of quads) {
    tris.push([c[a], c[b], c[d]], [c[a], c[d], c[e]]);
  }

  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    const [a, b, d] = t;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    for (let i = 0; i < 3; i++) dv.setFloat32(off + i * 4, n[i] / len, true);
    off += 12;
    for (const p of t) {
      for (let i = 0; i < 3; i++) dv.setFloat32(off + i * 4, p[i], true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return Buffer.from(buf).toString('base64');
}

/* ---- CDP plumbing ---- */
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TMPDIR ?? '/tmp'}/kerf-import`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => chrome.kill('SIGKILL');
process.on('exit', cleanup);

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Chrome did not expose a debugging endpoint');
}

const ws = new WebSocket(await endpoint());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('CDP socket failed'));
});

let nextId = 1;
const waiting = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  const w = waiting.get(msg.id);
  if (w) {
    waiting.delete(msg.id);
    msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const evaluate = async (expression) => {
  const r = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
};

await send('Page.enable', {}, sessionId);
await send('Page.navigate', { url: APP_URL }, sessionId);

// Wait for the app to finish its first boolean.
for (let i = 0; i < 60; i++) {
  await sleep(500);
  if (await evaluate("!!document.querySelector('#status')?.textContent")) break;
}

const b64 = zUpBoxStl(10, 20, 40);
await evaluate(`(() => {
  const bin = atob(${JSON.stringify(b64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], 'zup-box.stl', { type: 'model/stl' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.querySelector('input[type=file]');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

let readout = '';
for (let i = 0; i < 60; i++) {
  await sleep(500);
  readout = await evaluate("document.querySelector('.readout')?.textContent ?? ''");
  if (readout.includes('height')) break;
}

const nums = [...readout.matchAll(/([\d.]+)/g)].map((m) => Number(m[1]));
const [w, d, h] = nums;
const pass = Math.abs(w - 10) < 0.05 && Math.abs(d - 20) < 0.05 && Math.abs(h - 40) < 0.05;

console.log('readout:', readout.trim());
console.log(
  pass
    ? 'ok   Z-up STL imported upright (10 × 20 × 40)'
    : `FAIL expected 10 × 20 × 40, got ${w} × ${d} × ${h}`,
);

// The up-axis control is the escape hatch for files that really are Y-up. Flipping it
// must re-seat the same mesh without a re-import, and flipping back must restore it.
async function setUpAxis(value) {
  await evaluate(`(() => {
    const sel = [...document.querySelectorAll('select')].find(s =>
      [...s.options].some(o => o.value === 'z') && [...s.options].some(o => o.value === 'y'));
    sel.value = ${JSON.stringify(value)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const t = await evaluate("document.querySelector('.readout')?.textContent ?? ''");
    if (t.includes('height')) return t;
  }
  return '';
}

const asY = await setUpAxis('y');
const yh = Number([...asY.matchAll(/([\d.]+)/g)].map((m) => Number(m[1]))[2]);
const flipped = Math.abs(yh - 20) < 0.05;
console.log(flipped ? 'ok   toggling to Y-up tips it (height 20)' : `FAIL Y-up gave height ${yh}`);

const backToZ = await setUpAxis('z');
const zh = Number([...backToZ.matchAll(/([\d.]+)/g)].map((m) => Number(m[1]))[2]);
const restored = Math.abs(zh - 40) < 0.05;
console.log(
  restored ? 'ok   toggling back restores it (height 40)' : `FAIL back to Z gave height ${zh}`,
);

cleanup();
process.exit(pass && flipped && restored ? 0 : 1);
