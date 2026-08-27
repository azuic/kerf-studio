import type { ResolvedClearance } from '../model/clearance';
import type { BaseSpec, Cutter } from '../types';
import type { CsgRequest, CsgResponse, GeometryPayload, InsertRecipe } from './protocol';

/** Thrown into the promise of a body request that a newer one has replaced. */
export class StaleRequestError extends Error {
  constructor() {
    super('superseded by a newer request');
    this.name = 'StaleRequestError';
  }
}

interface Pending {
  resolve: (p: GeometryPayload) => void;
  reject: (e: Error) => void;
  kind: CsgRequest['kind'];
}

/**
 * Client for the boolean worker.
 *
 * The worker is single-threaded, so requests queue there rather than here. What this
 * class adds is *superseding*: while a body boolean is in flight, a newer body request
 * rejects the older promise with StaleRequestError instead of letting two results race
 * to the viewport.
 */
export class CsgEngine {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private latestBodyId = 0;

  /** Called with the ms a completed boolean took, for the status readout. */
  onTiming: ((ms: number, triangles: number) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<CsgResponse>) => this.receive(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(`CSG worker failed: ${e.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private receive(res: CsgResponse): void {
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);

    if (!res.ok) {
      p.reject(new Error(res.error));
      return;
    }
    if (res.kind === 'setStl') {
      p.resolve({ position: new Float32Array(0), normal: new Float32Array(0), triangles: 0 });
      return;
    }
    this.onTiming?.(res.ms, res.payload.triangles);
    p.resolve(res.payload);
  }

  private send(req: CsgRequest, transfer: Transferable[] = []): Promise<GeometryPayload> {
    return new Promise<GeometryPayload>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject, kind: req.kind });
      this.worker.postMessage(req, transfer);
    });
  }

  /** Hand the imported mesh to the worker once; later booleans reference it by side effect. */
  setStl(positions: Float32Array): Promise<void> {
    const copy = new Float32Array(positions);
    return this.send({ id: ++this.seq, kind: 'setStl', positions: copy }, [copy.buffer]).then(
      () => undefined,
    );
  }

  clearStl(): Promise<void> {
    return this.setStl(new Float32Array(0));
  }

  /** Base minus every enabled cutter. Rejects with StaleRequestError if superseded. */
  body(
    base: BaseSpec,
    cutters: Cutter[],
    clearances: Record<number, ResolvedClearance>,
  ): Promise<GeometryPayload> {
    const id = ++this.seq;

    // Drop any body request that has not come back yet — its result is already obsolete.
    for (const [pid, p] of this.pending) {
      if (p.kind === 'body') {
        this.pending.delete(pid);
        p.reject(new StaleRequestError());
      }
    }
    this.latestBodyId = id;

    return this.send({
      id,
      kind: 'body',
      base: structuredClone(base),
      cutters: structuredClone(cutters),
      clearances: structuredClone(clearances),
    });
  }

  insert(
    recipe: InsertRecipe,
    clearance: ResolvedClearance,
    withCap: boolean,
    px: number,
  ): Promise<GeometryPayload> {
    return this.send({
      id: ++this.seq,
      kind: 'insert',
      recipe: structuredClone(recipe),
      clearance,
      withCap,
      px,
    });
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  get inFlightBodyId(): number {
    return this.latestBodyId;
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
