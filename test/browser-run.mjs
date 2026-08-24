/**
 * Drives test/worker-check.html in headless Chrome over the DevTools protocol and
 * prints its results. Used to verify the worker plumbing (message shapes, buffer
 * transfer, request superseding) that the headless csg.test.ts cannot reach.
 *
 * Usage: npm run dev  (in one shell), then: node test/browser-run.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_UNDER_TEST = process.argv[2] ?? 'http://127.0.0.1:5199/test/worker-check.html';
/** Element to read results from — the app itself reports into #status. */
const SELECTOR = process.argv[3] ?? '#out';
const PORT = 9333;
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TMPDIR ?? '/tmp'}/kerf-cdp`,
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

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const evaluate = async (expression) => {
  const r = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable', {}, sessionId);
await send('Page.navigate', { url: URL_UNDER_TEST }, sessionId);

/** Surface page errors — a WebGL or module failure would otherwise look like silence. */
const errors = [];
await send('Runtime.enable', {}, sessionId);
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
});

let text = '';
let title = '';
for (let i = 0; i < 120; i++) {
  await sleep(500);
  try {
    title = await evaluate('document.title');
    text = await evaluate(`document.querySelector(${JSON.stringify(SELECTOR)})?.textContent ?? ''`);
  } catch {
    continue;
  }
  if (title === 'ALL OK' || title.includes('FAIL') || title === 'THREW') break;
  if (SELECTOR !== '#out' && text) break;
}

console.log(text || '(no output)');
for (const e of errors) console.log('PAGE ERROR:', e);
cleanup();
const passed = SELECTOR === '#out' ? title === 'ALL OK' : Boolean(text) && errors.length === 0;
process.exit(passed ? 0 : 1);
