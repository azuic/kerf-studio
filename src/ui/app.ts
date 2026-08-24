import { CsgEngine, StaleRequestError } from '../csg/engine';
import type { GeometryPayload, InsertRecipe } from '../csg/protocol';
import {
  deserializeProject,
  downloadProject,
  clearAutosave,
  loadAutosave,
  saveAutosave,
} from '../io/project';
import { centerOnPlate, downloadSTL, parseSTL } from '../io/stl';
import { cutterSolid } from '../model/geometry';
import { getStlPositions, setStlPositions } from '../state/assets';
import { Store } from '../state/store';
import { Viewport } from '../scene/viewport';
import type { AppState } from '../types';
import { baseHeight, baseSpanX, baseSpanZ, initialState, insertPreviewX } from '../types';
import { createBasePanel } from './basePanel';
import { createCutterPanel } from './cutterPanel';
import type { Panel, UiContext } from './context';
import { createExportPanel, createProjectPanel } from './exportPanel';
import { createInsertPanel } from './insertPanel';

const RECOMPUTE_DEBOUNCE_MS = 160;
const AUTOSAVE_DEBOUNCE_MS = 1200;
const BIG_MESH_TRIS = 30_000;

export class App implements UiContext {
  readonly store: Store;
  private engine = new CsgEngine();
  private viewport: Viewport;
  private panels: Panel[] = [];

  private bodyPayload: GeometryPayload | null = null;
  private insertPayload: GeometryPayload | null = null;

  private recomputeTimer: number | null = null;
  private autosaveTimer: number | null = null;
  private statusEl: HTMLElement;
  private busyEl: HTMLElement;

  constructor(sidebar: HTMLElement, viewportHost: HTMLElement, statusEl: HTMLElement, busyEl: HTMLElement) {
    this.statusEl = statusEl;
    this.busyEl = busyEl;
    this.viewport = new Viewport(viewportHost);

    const restored = loadAutosave();
    this.store = new Store(restored?.state ?? initialState());
    if (restored?.stl) setStlPositions(restored.stl);

    this.engine.onTiming = (ms, tris) => {
      this.status(`${tris.toLocaleString()} triangles · boolean ${ms} ms`);
    };

    this.panels = [
      createBasePanel(this),
      createCutterPanel(this),
      createInsertPanel(this),
      createExportPanel(this),
      createProjectPanel(this),
    ];
    for (const p of this.panels) sidebar.appendChild(p.el);

    this.store.subscribe(() => {
      this.renderPanels();
      this.scheduleAutosave();
    });

    this.bindKeys();
    this.renderPanels();

    // A restored STL must reach the worker before the first boolean runs.
    const stl = getStlPositions();
    const ready = stl ? this.engine.setStl(stl) : Promise.resolve();
    void ready.then(() => this.computeNow());
  }

  private renderPanels(): void {
    const s = this.store.state;
    for (const p of this.panels) p.update(s);
    this.refreshGhosts(s);
  }

  private refreshGhosts(s: AppState): void {
    this.viewport.setGhosts(
      s.cutters
        .filter((c) => c.enabled)
        .map((c) => ({ solid: cutterSolid(c, s.base), selected: c.id === s.selected })),
    );
  }

  /* ---------------- UiContext ---------------- */

  requestBody(): void {
    this.renderPanels();
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

  private async runBody(): Promise<GeometryPayload | null> {
    const s = this.store.state;
    this.setBusy(true);
    try {
      const payload = await this.engine.body(s.base, s.cutters);
      this.bodyPayload = payload;
      this.viewport.setBody(payload);
      return payload;
    } catch (err) {
      // A stale result is the normal outcome of typing quickly; only real errors surface.
      if (err instanceof StaleRequestError) return null;
      this.status(
        `Boolean failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
      return null;
    } finally {
      this.setBusy(this.engine.busy);
    }
  }

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

    this.setBusy(true);
    try {
      const payload = await this.engine.insert(
        recipe,
        s.insert.clearance,
        s.insert.withCap,
        insertPreviewX(s.base),
      );
      this.insertPayload = payload;
      this.viewport.setInsert(payload);
      this.store.update((st) => {
        st.insert.generated = true;
        st.insert.label = label;
      });
      this.status(`Insert ready — ${payload.triangles.toLocaleString()} triangles`);
    } catch (err) {
      this.status(
        `Insert failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    } finally {
      this.setBusy(this.engine.busy);
    }
  }

  clearInsert(): void {
    this.insertPayload = null;
    this.viewport.setInsert(null);
    this.store.update((s) => {
      s.insert.generated = false;
      s.insert.label = '';
    });
  }

  importStl(file: File): void {
    const reader = new FileReader();
    reader.onerror = () => this.status('Could not read that file.', 'error');
    reader.onload = () => {
      try {
        const parsed = parseSTL(reader.result as ArrayBuffer);
        const bounds = centerOnPlate(parsed.positions);
        setStlPositions(parsed.positions);

        this.store.update((s) => {
          s.base.type = 'stl';
          s.base.stlName = file.name;
          s.base.stlW = bounds.maxX - bounds.minX;
          s.base.stlD = bounds.maxZ - bounds.minZ;
          s.base.stlH = bounds.maxY;
          s.base.stlTris = parsed.triangles;
          if (parsed.triangles > BIG_MESH_TRIS) s.autoPreview = false;
        });

        if (parsed.triangles > BIG_MESH_TRIS) {
          this.status(
            `${parsed.triangles.toLocaleString()} triangles — live preview switched off. ` +
              `Use “Apply cuts now”.`,
          );
        }

        const s = this.store.state;
        this.viewport.frame(baseSpanX(s.base), baseSpanZ(s.base), baseHeight(s.base));
        void this.engine.setStl(parsed.positions).then(() => this.computeNow());
      } catch (err) {
        this.status(
          `Could not read this STL: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    };
    reader.readAsArrayBuffer(file);
  }

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
    this.status(`Exported kerf-insert.stl · ${this.insertPayload.triangles.toLocaleString()} triangles`);
  }

  saveProject(): void {
    downloadProject(this.store.state, getStlPositions(), 'model.kerf.json');
    this.status('Saved model.kerf.json');
  }

  loadProject(file: File): void {
    const reader = new FileReader();
    reader.onerror = () => this.status('Could not read that file.', 'error');
    reader.onload = () => {
      try {
        const { state, stl } = deserializeProject(String(reader.result));
        setStlPositions(stl);
        this.store.replace(state);
        this.insertPayload = null;
        this.viewport.setInsert(null);
        this.viewport.frame(baseSpanX(state.base), baseSpanZ(state.base), baseHeight(state.base));
        const ready = stl ? this.engine.setStl(stl) : this.engine.clearStl();
        void ready.then(() => this.computeNow());
        this.status(`Loaded ${file.name}`);
      } catch (err) {
        this.status(
          `Could not open this project: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    };
    reader.readAsText(file);
  }

  newProject(): void {
    setStlPositions(null);
    clearAutosave();
    this.store.replace(initialState());
    this.insertPayload = null;
    this.viewport.setInsert(null);
    void this.engine.clearStl().then(() => this.computeNow());
    this.status('New project');
  }

  hasInsert(): boolean {
    return this.insertPayload !== null;
  }

  status(message: string, tone: 'info' | 'error' = 'info'): void {
    this.statusEl.textContent = message;
    this.statusEl.classList.toggle('error', tone === 'error');
  }

  /* ---------------- plumbing ---------------- */

  private setBusy(on: boolean): void {
    this.busyEl.style.display = on ? 'block' : 'none';
  }

  private scheduleAutosave(): void {
    if (this.autosaveTimer !== null) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      saveAutosave(this.store.state, getStlPositions());
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      const moved = e.shiftKey ? this.store.redo() : this.store.undo();
      if (moved) this.requestBody();
    });
  }
}
