import { CsgEngine, StaleRequestError } from './csg/engine';
import type { GeometryPayload, InsertRecipe } from './csg/protocol';
import {
  clearAutosave,
  deserializeProject,
  downloadProject,
  loadAutosave,
  saveAutosave,
} from './io/project';
import { downloadSTL, parseSTL } from './io/stl';
import { cutterSolid } from './model/geometry';
import { Viewport } from './scene/viewport';
import { getOrientedStl, getStlRaw, hasStl, setStlRaw } from './state/assets';
import { Store } from './state/store';
import type { AppState, UpAxis } from './types';
import { baseHeight, baseSpanX, baseSpanZ, initialState, insertPreviewX } from './types';

const RECOMPUTE_DEBOUNCE_MS = 160;
const AUTOSAVE_DEBOUNCE_MS = 1200;
const BIG_MESH_TRIS = 30_000;

/**
 * Everything that is not React: the worker, the viewport, and the actions the panels
 * invoke. React subscribes to `store` for model changes and to `subscribeView` for the
 * transient bits (status line, busy flag, whether an insert exists) that do not belong
 * in undo history.
 */
export interface ViewState {
  status: string;
  tone: 'info' | 'error';
  busy: boolean;
  hasInsert: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export class KerfController {
  readonly store: Store;
  private engine = new CsgEngine();
  private viewport: Viewport | null = null;

  private bodyPayload: GeometryPayload | null = null;
  private insertPayload: GeometryPayload | null = null;

  private recomputeTimer: number | null = null;
  private autosaveTimer: number | null = null;
  /**
   * What the worker was last told about the imported mesh. The worker caches it, so
   * every boolean reconciles against this rather than re-sending — and undo, which only
   * restores the store, cannot leave the worker holding the wrong mesh.
   */
  private sentStlKey: string | null = null;

  private view: ViewState = {
    status: '',
    tone: 'info',
    busy: false,
    hasInsert: false,
    canUndo: false,
    canRedo: false,
  };
  private viewListeners = new Set<() => void>();

  constructor() {
    const restored = loadAutosave();
    this.store = new Store(restored?.state ?? initialState());
    if (restored?.stl) setStlRaw(restored.stl);

    this.engine.onTiming = (ms, tris) => {
      this.status(`${tris.toLocaleString()} triangles · boolean ${ms} ms`);
    };

    this.store.subscribe(() => {
      this.refreshGhosts();
      this.scheduleAutosave();
      this.patchView({ canUndo: this.store.canUndo, canRedo: this.store.canRedo });
    });
  }

  /** Ghost world matrices — used by the browser tests to check cutter orientation. */
  debugGhostMatrices(): number[][] {
    return this.viewport?.ghostMatrices() ?? [];
  }

  /** Where a cutter's entry point lands on screen — used by the browser tests to aim. */
  debugProjectEntry(id: number): { x: number; y: number } | null {
    return this.viewport?.projectEntry(id) ?? null;
  }

  /** Called once the canvas element exists. */
  attachViewport(host: HTMLElement): void {
    if (this.viewport) return;
    this.viewport = new Viewport(host);
    this.bindViewportDragging(this.viewport);
    this.refreshGhosts();

    this.frameBase();
    this.computeNow();
  }

  /* ---------------- view state ---------------- */

  subscribeView = (fn: () => void): (() => void) => {
    this.viewListeners.add(fn);
    return () => this.viewListeners.delete(fn);
  };

  getView = (): ViewState => this.view;

  private patchView(patch: Partial<ViewState>): void {
    const next = { ...this.view, ...patch };
    const changed = (Object.keys(patch) as (keyof ViewState)[]).some(
      (k) => this.view[k] !== next[k],
    );
    if (!changed) return;
    this.view = next;
    for (const fn of this.viewListeners) fn();
  }

  status(message: string, tone: 'info' | 'error' = 'info'): void {
    this.patchView({ status: message, tone });
  }

  /* ---------------- geometry pipeline ---------------- */

  private refreshGhosts(): void {
    const s = this.store.state;
    this.viewport?.setGhosts(
      s.cutters
        .filter((c) => c.enabled)
        .map((c) => ({
          id: c.id,
          solid: cutterSolid(c, s.base),
          selected: c.id === s.selected,
          entry: { x: c.params.x, y: c.params.y, z: c.params.z },
        })),
    );
  }

  /**
   * Dragging a cutter in the viewport.
   *
   * The whole drag is one undo step: a single committing update at the start captures
   * the pre-drag state, and every move after that is transient. Without this a drag
   * would leave one history entry per pointer event.
   */
  private bindViewportDragging(vp: Viewport): void {
    vp.onCutterPick = (id) => {
      this.store.update(
        (s) => {
          s.selected = id;
        },
        { transient: true },
      );
      this.refreshGhosts();
    };

    vp.onCutterDragStart = () => {
      this.store.update(() => {
        /* no change — this only opens the undo step */
      });
    };

    vp.onCutterDragMove = (id, x, y, z) => {
      this.store.update(
        (s) => {
          const c = s.cutters.find((t) => t.id === id);
          if (!c) return;
          c.params.x = x;
          c.params.y = y;
          c.params.z = z;
        },
        { transient: true },
      );
      this.requestBody();
    };

    vp.onCutterDragEnd = () => this.requestBody();
  }

  /** Refresh ghosts now; recompute the boolean shortly, if auto-preview is on. */
  requestBody(): void {
    this.refreshGhosts();
    if (!this.store.state.autoPreview) return;
    if (this.recomputeTimer !== null) clearTimeout(this.recomputeTimer);
    this.recomputeTimer = window.setTimeout(() => {
      this.recomputeTimer = null;
      void this.runBody();
    }, RECOMPUTE_DEBOUNCE_MS);
  }

  computeNow(): void {
    if (this.recomputeTimer !== null) {
      clearTimeout(this.recomputeTimer);
      this.recomputeTimer = null;
    }
    void this.runBody();
  }

  /**
   * Make the worker's cached mesh match what the state now asks for. Cheap when nothing
   * changed, and it is what makes undo/redo across an import or a delete correct.
   */
  private async ensureWorkerStl(): Promise<void> {
    const b = this.store.state.base;
    const needsMesh = b.type === 'stl' && hasStl();
    const key = needsMesh ? `mesh:${b.stlUpAxis}` : 'none';
    if (key === this.sentStlKey) return;

    if (needsMesh) {
      const oriented = getOrientedStl(b.stlUpAxis);
      if (oriented) await this.engine.setStl(oriented.positions);
    } else {
      await this.engine.clearStl();
    }
    this.sentStlKey = key;
  }

  private async runBody(): Promise<GeometryPayload | null> {
    this.patchView({ busy: true });
    try {
      await this.ensureWorkerStl();
      const s = this.store.state;
      const payload = await this.engine.body(s.base, s.cutters);
      this.bodyPayload = payload;
      this.viewport?.setBody(payload);
      return payload;
    } catch (err) {
      // A stale result is the normal outcome of typing quickly; only real errors surface.
      if (err instanceof StaleRequestError) return null;
      this.status(`Boolean failed: ${message(err)}`, 'error');
      return null;
    } finally {
      this.patchView({ busy: this.engine.busy });
    }
  }

  /* ---------------- inserts ---------------- */

  async generateInsert(): Promise<void> {
    const s = this.store.state;
    const src = s.insert.source;
    if (!src) {
      this.status('Add a hole or twist-lock set first.', 'error');
      return;
    }

    let recipe: InsertRecipe;
    let label: string;
    if (src.kind === 'group') {
      const params = s.groups[src.groupId];
      if (!params) {
        this.status('That twist-lock set no longer exists.', 'error');
        return;
      }
      recipe = { kind: 'group', params };
      label = 'twist-lock pin';
    } else {
      const cutter = s.cutters.find((c) => c.id === src.cutterId);
      if (!cutter) {
        this.status('That hole no longer exists.', 'error');
        return;
      }
      recipe = { kind: 'cutter', cutter };
      label = `${cutter.name} insert`;
    }

    this.patchView({ busy: true });
    try {
      const payload = await this.engine.insert(
        recipe,
        s.insert.clearance,
        s.insert.withCap,
        insertPreviewX(s.base),
      );
      this.insertPayload = payload;
      this.viewport?.setInsert(payload);
      this.store.update((st) => {
        st.insert.generated = true;
        st.insert.label = label;
      });
      this.patchView({ hasInsert: true });
      this.status(`Insert ready — ${payload.triangles.toLocaleString()} triangles`);
    } catch (err) {
      this.status(`Insert failed: ${message(err)}`, 'error');
    } finally {
      this.patchView({ busy: this.engine.busy });
    }
  }

  clearInsert(): void {
    this.insertPayload = null;
    this.viewport?.setInsert(null);
    this.store.update((s) => {
      s.insert.generated = false;
      s.insert.label = '';
    });
    this.patchView({ hasInsert: false });
  }

  /* ---------------- import / orientation ---------------- */

  importStl(file: File): void {
    const reader = new FileReader();
    reader.onerror = () => this.status('Could not read that file.', 'error');
    reader.onload = () => {
      try {
        const parsed = parseSTL(reader.result as ArrayBuffer);
        setStlRaw(parsed.positions);

        this.sentStlKey = null;
        this.store.update((s) => {
          s.base.type = 'stl';
          s.base.stlName = file.name;
          s.base.stlTris = parsed.triangles;
          // STL carries no orientation metadata; Z-up is what CAD tools and slicers
          // write, so a fresh import always starts there.
          s.base.stlUpAxis = 'z';
          if (parsed.triangles > BIG_MESH_TRIS) s.autoPreview = false;
        });
        this.applyStlOrientation();

        this.status(
          parsed.triangles > BIG_MESH_TRIS
            ? `${parsed.triangles.toLocaleString()} triangles — live preview switched off. Use “Apply cuts now”.`
            : `Imported ${file.name}`,
        );
      } catch (err) {
        this.status(`Could not read this STL: ${message(err)}`, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  setStlUpAxis(axis: UpAxis): void {
    if (this.store.state.base.stlUpAxis === axis) return;
    this.store.update((s) => {
      s.base.stlUpAxis = axis;
    });
    this.applyStlOrientation();
  }

  /**
   * Re-derive the seated mesh for the current up axis, refresh the recorded dimensions,
   * reframe the camera and hand the new buffer to the worker.
   *
   * The dimensions have to be updated before the next boolean runs, or anything anchored
   * to the model top lands at the wrong height.
   */
  private applyStlOrientation(): void {
    const oriented = getOrientedStl(this.store.state.base.stlUpAxis);
    if (!oriented) return;
    const { bounds } = oriented;

    this.store.update(
      (s) => {
        s.base.stlW = bounds.maxX - bounds.minX;
        s.base.stlD = bounds.maxZ - bounds.minZ;
        s.base.stlH = bounds.maxY;
      },
      { transient: true },
    );

    this.sentStlKey = null;
    this.frameBase();
    this.computeNow();
  }

  private frameBase(): void {
    const b = this.store.state.base;
    this.viewport?.frame(baseSpanX(b), baseSpanZ(b), baseHeight(b));
  }

  /* ---------------- base model ---------------- */

  /**
   * Restore the base to its default proportions, keeping the type and any loaded mesh.
   * For an STL that means putting the up axis back to Z and re-seating it on the plate.
   */
  resetBase(): void {
    const defaults = initialState().base;
    const wasStl = this.store.state.base.type === 'stl';

    this.store.update((s) => {
      const { type, stlName, stlTris } = s.base;
      s.base = { ...defaults, type, stlName, stlTris };
    });

    if (wasStl) {
      this.applyStlOrientation();
    } else {
      this.sentStlKey = null;
      this.frameBase();
      this.requestBody();
    }
    this.status('Base model reset');
  }

  /**
   * Drop the base back to the default box, unloading any imported mesh.
   *
   * The raw STL buffer is deliberately kept in assets: it lives outside undo history, so
   * discarding it here would make an undo restore a base that points at a mesh no longer
   * in memory. It is released by New, or replaced by the next import.
   */
  deleteBase(): void {
    this.store.update((s) => {
      s.base = initialState().base;
    });
    this.sentStlKey = null;
    this.frameBase();
    this.requestBody();
    this.status('Base model removed');
  }

  /* ---------------- export ---------------- */

  exportBody(): void {
    const download = (p: GeometryPayload | null): void => {
      if (!p || p.triangles === 0) {
        this.status('Nothing to export yet.', 'error');
        return;
      }
      downloadSTL(p.position, 'kerf-body.stl');
      this.status(`Exported kerf-body.stl · ${p.triangles.toLocaleString()} triangles`);
    };
    if (this.bodyPayload) download(this.bodyPayload);
    else void this.runBody().then(download);
  }

  exportInsert(): void {
    if (!this.insertPayload) {
      this.status('Generate the insert first.', 'error');
      return;
    }
    downloadSTL(this.insertPayload.position, 'kerf-insert.stl');
    this.status(
      `Exported kerf-insert.stl · ${this.insertPayload.triangles.toLocaleString()} triangles`,
    );
  }

  /* ---------------- projects ---------------- */

  saveProject(): void {
    // The raw file goes in, not the seated copy — the up axis is recorded in the state,
    // so re-orienting on load stays idempotent.
    downloadProject(this.store.state, getStlRaw(), 'model.kerf.json');
    this.status('Saved model.kerf.json');
  }

  loadProject(file: File): void {
    const reader = new FileReader();
    reader.onerror = () => this.status('Could not read that file.', 'error');
    reader.onload = () => {
      try {
        const { state, stl } = deserializeProject(String(reader.result));
        setStlRaw(stl);
        this.store.replace(state);
        this.insertPayload = null;
        this.viewport?.setInsert(null);
        this.patchView({ hasInsert: false });

        this.sentStlKey = null;
        if (stl) {
          this.applyStlOrientation();
        } else {
          this.frameBase();
          this.computeNow();
        }
        this.status(`Loaded ${file.name}`);
      } catch (err) {
        this.status(`Could not open this project: ${message(err)}`, 'error');
      }
    };
    reader.readAsText(file);
  }

  newProject(): void {
    setStlRaw(null);
    clearAutosave();
    this.store.replace(initialState());
    this.insertPayload = null;
    this.viewport?.setInsert(null);
    this.patchView({ hasInsert: false });
    this.sentStlKey = null;
    this.frameBase();
    this.computeNow();
    this.status('New project');
  }

  undo(): void {
    if (this.store.undo()) this.requestBody();
  }

  redo(): void {
    if (this.store.redo()) this.requestBody();
  }

  /* ---------------- plumbing ---------------- */

  private scheduleAutosave(): void {
    if (this.autosaveTimer !== null) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      saveAutosave(this.store.state, getStlRaw());
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /** Mutate the model and schedule a recompute — the path almost every control takes. */
  edit(mutate: (s: AppState) => void, coalesce?: string): void {
    this.store.update(mutate, coalesce ? { coalesce } : {});
    this.requestBody();
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
