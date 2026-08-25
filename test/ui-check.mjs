/**
 * Browser checks for the interactions that only exist in the DOM: drag-to-scrub on
 * numeric fields, the full 3D cutter controls, and drag-and-drop import.
 *
 * Uses real CDP mouse input for the scrub, so it exercises the same pointer events a
 * person generates — including movementX, which is what the scrub reads.
 *
 * Usage: npm run dev, then: node test/ui-check.mjs [url]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5199/';
const PORT = 9335;
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
function ok(label, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--no-first-run',
    '--window-size=1400,900',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TMPDIR ?? '/tmp'}/kerf-ui`,
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
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
};

const pageErrors = [];
await send('Runtime.enable', {}, sessionId);
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(
      msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text,
    );
  }
});

await send('Page.enable', {}, sessionId);
await send('Page.navigate', { url: APP_URL }, sessionId);
for (let i = 0; i < 60; i++) {
  await sleep(500);
  if (await evaluate("!!document.querySelector('#status')")) break;
}

/* ---------------- add a cutter ---------------- */
const clickByText = async (text) =>
  evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(el => el.textContent.trim() === ${JSON.stringify(text)});
    if (!b) throw new Error('button not found: ' + ${JSON.stringify(text)});
    b.click();
    return true;
  })()`);

await clickByText('+ Round hole');
await sleep(600);

/** Read the input that sits under a given scrub label. */
const fieldValue = async (label) =>
  evaluate(`(() => {
    const span = [...document.querySelectorAll('[role=slider]')]
      .find(el => el.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!span) throw new Error('field not found: ' + ${JSON.stringify(label)});
    return span.parentElement.querySelector('input').value;
  })()`);

// CDP dispatches at viewport coordinates, so the field has to be on screen first —
// the sidebar scrolls, and the rotation row sits well below the fold.
const labelBox = async (label) => {
  await evaluate(`(() => {
    const span = [...document.querySelectorAll('[role=slider]')]
      .find(el => el.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!span) throw new Error('field not found: ' + ${JSON.stringify(label)});
    span.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(200);
  return evaluate(`(() => {
    const span = [...document.querySelectorAll('[role=slider]')]
      .find(el => el.getAttribute('aria-label') === ${JSON.stringify(label)});
    const r = span.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
};

const has = async (label) =>
  evaluate(`[...document.querySelectorAll('[role=slider]')]
    .some(el => el.getAttribute('aria-label') === ${JSON.stringify(label)})`);

ok('a new cutter exposes all three rotation axes', (await has('Rot X')) && (await has('Rot Z')));
ok('and all three position axes', (await has('X')) && (await has('Y')) && (await has('Z')));

/* ---------------- a fresh cutter is square to the bed ---------------- */
// Measured from the rendered ghost's world matrix, not from the params it was built
// from — that is the only way to catch a transform that skews on the way to the screen.
const basis = await evaluate(`(() => {
  const m = window.__kerf.debugGhostMatrices()[0];
  if (!m) return null;
  const col = i => [m[i*4], m[i*4+1], m[i*4+2]].map(v => Math.round(v * 1e6) / 1e6);
  return { x: col(0), y: col(1), z: col(2) };
})()`);
const axisAligned =
  basis &&
  JSON.stringify(basis.x) === '[1,0,0]' &&
  JSON.stringify(basis.y) === '[0,1,0]' &&
  JSON.stringify(basis.z) === '[0,0,1]';
ok(
  'an unrotated cutter renders square to the bed',
  axisAligned,
  basis ? `X=${basis.x} Y=${basis.y} Z=${basis.z}` : 'no ghost',
);

/* ---------------- drag to scrub ---------------- */
async function drag(label, dx, modifiers = 0) {
  const p = await labelBox(label);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1, modifiers }, sessionId);
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + (dx * i) / steps, y: p.y, button: 'left', buttons: 1, modifiers }, sessionId);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + dx, y: p.y, button: 'left', clickCount: 1, buttons: 0, modifiers }, sessionId);
  await sleep(350);
}

const diaBefore = Number(await fieldValue('Diameter'));
await drag('Diameter', 40);
const diaAfter = Number(await fieldValue('Diameter'));
// step 0.25/px over 40 px of drag.
ok(
  'dragging a label scrubs the value',
  Math.abs(diaAfter - (diaBefore + 10)) < 0.51,
  `${diaBefore} → ${diaAfter}`,
);

const fineBefore = Number(await fieldValue('Diameter'));
await drag('Diameter', 40, 8); // 8 = Shift
const fineAfter = Number(await fieldValue('Diameter'));
ok(
  'shift scrubs ten times finer',
  Math.abs(fineAfter - (fineBefore + 1)) < 0.3,
  `${fineBefore} → ${fineAfter}`,
);

const rotBefore = Number(await fieldValue('Rot X'));
await drag('Rot X', 20);
const rotAfter = Number(await fieldValue('Rot X'));
ok('rotation scrubs too', Math.abs(rotAfter - (rotBefore + 20)) < 1.1, `${rotBefore}° → ${rotAfter}°`);

// ...and that rotation must actually reach the ghost, then be undoable in one click.
// A rotation about X leaves the X axis alone, so the tilt shows up in the Y column:
// 20° about X puts local Y at [0, cos20, sin20].
const tiltedY = await evaluate(
  '(() => { const m = window.__kerf.debugGhostMatrices()[0]; return [m[4],m[5],m[6]]; })()',
);
const rad = (20 * Math.PI) / 180;
ok(
  'the rotation reaches the ghost',
  Math.abs(tiltedY[1] - Math.cos(rad)) < 0.02 && Math.abs(tiltedY[2] - Math.sin(rad)) < 0.02,
  `Y=[${tiltedY.map((n) => n.toFixed(3)).join(', ')}]`,
);

await clickByText('Reset rotation');
await sleep(500);
const resetBasis = await evaluate(`(() => {
  const m = window.__kerf.debugGhostMatrices()[0];
  const col = i => [m[i*4], m[i*4+1], m[i*4+2]].map(v => Math.round(v * 1e6) / 1e6);
  return [col(0), col(1), col(2)];
})()`);
ok(
  'Reset rotation squares it back up on every axis',
  JSON.stringify(resetBasis) === '[[1,0,0],[0,1,0],[0,0,1]]',
  JSON.stringify(resetBasis),
);
ok('and clears the rotation fields', Number(await fieldValue('Rot X')) === 0);

// Scrubbing must actually reach the geometry, not just the input.
const statusAfterScrub = await evaluate("document.querySelector('#status')?.textContent ?? ''");
ok('the boolean re-runs after a scrub', /triangles/.test(statusAfterScrub), statusAfterScrub.trim());

/* ---------------- typing still works ---------------- */
await evaluate(`(() => {
  const span = [...document.querySelectorAll('[role=slider]')]
    .find(el => el.getAttribute('aria-label') === 'Diameter');
  const input = span.parentElement.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  input.focus();
  setter.call(input, '7.5');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.blur();
  return true;
})()`);
await sleep(400);
ok('typing a value still works', Number(await fieldValue('Diameter')) === 7.5);

/* ---------------- drag and drop import ---------------- */
function zUpBoxStl(sx, sy, sz) {
  const x0 = -sx / 2, x1 = sx / 2, y0 = -sy / 2, y1 = sy / 2, z0 = 0, z1 = sz;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const tris = [];
  for (const [a, b, d, e] of quads) tris.push([c[a], c[b], c[d]], [c[a], c[d], c[e]]);
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

const b64 = zUpBoxStl(12, 24, 36);

// dragenter must raise the drop overlay...
await evaluate(`(() => {
  const dt = new DataTransfer();
  const bin = atob(${JSON.stringify(b64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  dt.items.add(new File([bytes], 'dropped.stl', { type: 'model/stl' }));
  window.__dt = dt;
  const target = document.querySelector('#status').parentElement;
  window.__target = target;
  target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
  return true;
})()`);
await sleep(300);
const overlayShown = await evaluate(
  "!![...document.querySelectorAll('p')].find(p => p.textContent.includes('Drop an'))",
);
ok('dragging a file over the viewport shows a drop target', overlayShown);

// ...and dropping must import it.
await evaluate(`(() => {
  window.__target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: window.__dt }));
  return true;
})()`);

let readout = '';
for (let i = 0; i < 40; i++) {
  await sleep(400);
  readout = await evaluate(
    "document.querySelector('[data-testid=base-readout]')?.textContent ?? ''",
  );
  if (readout.includes('12.0')) break;
}
const nums = [...readout.matchAll(/([\d.]+)/g)].map((m) => Number(m[1]));
ok(
  'dropping an STL imports it, upright',
  Math.abs(nums[0] - 12) < 0.05 && Math.abs(nums[1] - 24) < 0.05 && Math.abs(nums[2] - 36) < 0.05,
  readout.trim(),
);
const overlayGone = await evaluate(
  "![...document.querySelectorAll('p')].find(p => p.textContent.includes('Drop an'))",
);
ok('the drop target clears after dropping', overlayGone);

/* ---------------- base model reset / delete ---------------- */
const readBase = async () =>
  evaluate("document.querySelector('[data-testid=base-readout]')?.textContent ?? ''");
const barOpen = async () => evaluate("!!document.querySelector('[data-testid=base-action-bar]')");

ok('importing opens the base action bar', await barOpen());

// Reset on an imported mesh re-seats it rather than unloading it.
await evaluate(`(() => {
  const bar = document.querySelector('[data-testid=base-action-bar]');
  [...bar.querySelectorAll('button')].find(b => b.textContent.trim() === 'Reset').click();
  return true;
})()`);
await sleep(1200);
ok(
  'Reset keeps the imported mesh',
  (await readBase()).includes('12.0') && (await readBase()).includes('36.0'),
  (await readBase()).trim(),
);

// Delete drops back to the default hollow box.
await evaluate(`(() => {
  const bar = document.querySelector('[data-testid=base-action-bar]');
  [...bar.querySelectorAll('button')].find(b => b.textContent.trim() === 'Delete').click();
  return true;
})()`);
await sleep(1500);
const afterDelete = await readBase();
ok(
  'Delete returns the base to the default box',
  afterDelete.includes('80.0') && afterDelete.includes('60.0') && afterDelete.includes('40.0'),
  afterDelete.trim(),
);
ok('and closes the action bar', !(await barOpen()));

// The raw mesh is deliberately kept in memory so this undo can restore it. If it were
// dropped, the state would come back pointing at a mesh that no longer exists.
await evaluate("window.__kerf.undo()");
await sleep(1800);
const afterUndo = await readBase();
ok(
  'undo brings the imported mesh back',
  afterUndo.includes('12.0') && afterUndo.includes('36.0'),
  afterUndo.trim(),
);
const bodyTris = await evaluate("document.querySelector('#status')?.textContent ?? ''");
ok(
  'and the worker recomputes from that mesh, not a stale one',
  /triangles/.test(bodyTris),
  bodyTris.trim(),
);

for (const e of pageErrors) console.log('PAGE ERROR:', e);
ok('no uncaught page errors', pageErrors.length === 0);

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
cleanup();
process.exit(failures === 0 ? 0 : 1);
