/// <reference lib="webworker" />
import { buildBody, buildInsert } from './booleans';
import type { CsgRequest, CsgResponse } from './protocol';

/**
 * Thin message shell around csg/booleans.ts. Keeping the booleans off the main thread
 * is the whole point: a slow cut on a dense mesh no longer freezes the viewport.
 */

/** The imported STL lives here for the worker's lifetime — sent once, reused per boolean. */
let stlPositions: Float32Array | null = null;

function post(msg: CsgResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

self.onmessage = (e: MessageEvent<CsgRequest>) => {
  const req = e.data;
  const started = performance.now();
  try {
    if (req.kind === 'setStl') {
      stlPositions = req.positions.length ? req.positions : null;
      post({ id: req.id, ok: true, kind: 'setStl' });
      return;
    }

    const payload =
      req.kind === 'body'
        ? buildBody(req.base, req.cutters, stlPositions, req.clearances)
        : buildInsert(req.recipe, req.clearance, req.withCap, req.px);

    post(
      {
        id: req.id,
        ok: true,
        kind: 'geometry',
        payload,
        ms: Math.round(performance.now() - started),
      },
      [payload.position.buffer, payload.normal.buffer],
    );
  } catch (err) {
    post({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
