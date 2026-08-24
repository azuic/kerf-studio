import type { Store } from '../state/store';
import type { AppState, UpAxis } from '../types';

/** What panels are allowed to ask the app to do. Implemented in ui/app.ts. */
export interface UiContext {
  store: Store;
  /** Debounced: refresh ghosts now, recompute the boolean shortly (if auto-preview is on). */
  requestBody(): void;
  /** Run the boolean immediately, regardless of the auto-preview setting. */
  computeNow(): void;
  generateInsert(): void;
  clearInsert(): void;
  importStl(file: File): void;
  /** Re-interpret which axis of the imported file points up, and reseat it on the plate. */
  setStlUpAxis(axis: UpAxis): void;
  exportBody(): void;
  exportInsert(): void;
  saveProject(): void;
  loadProject(file: File): void;
  newProject(): void;
  hasInsert(): boolean;
  status(message: string, tone?: 'info' | 'error'): void;
}

export interface Panel {
  el: HTMLElement;
  update(state: AppState): void;
}
