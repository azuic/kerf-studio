import type { AppState } from '../types';
import { initialState } from '../types';

export interface CommitOptions {
  /**
   * Successive commits sharing a key inside COALESCE_MS collapse into one undo step.
   * Use it for anything driven by a number input or drag, so undo steps back a whole
   * edit rather than one keystroke.
   */
  coalesce?: string;
  /** Skip the undo stack entirely (selection, view-only toggles). */
  transient?: boolean;
}

const COALESCE_MS = 700;
const MAX_HISTORY = 100;

export type Listener = (state: AppState) => void;

/**
 * Snapshot-based store. The state is small plain JSON — the imported STL mesh
 * deliberately lives outside it (see state/assets.ts) so snapshots stay cheap.
 */
export class Store {
  private current: AppState;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();
  private lastCoalesceKey: string | null = null;
  private lastCommitAt = 0;
  /**
   * Bumped on every emit. The state is mutated in place, so its identity never changes
   * and React's useSyncExternalStore has nothing to compare — this counter is the
   * snapshot it watches instead.
   */
  private rev = 0;

  constructor(initial: AppState = initialState()) {
    this.current = initial;
  }

  get state(): AppState {
    return this.current;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Monotonic revision, for change detection by identity-blind consumers. */
  get version(): number {
    return this.rev;
  }

  private emit(): void {
    this.rev++;
    for (const fn of this.listeners) fn(this.current);
  }

  /** Mutate the state in place; the mutation is recorded for undo unless transient. */
  update(mutate: (s: AppState) => void, opts: CommitOptions = {}): void {
    if (!opts.transient) this.pushHistory(opts.coalesce);
    mutate(this.current);
    this.emit();
  }

  private pushHistory(coalesce?: string): void {
    const now = Date.now();
    const continues =
      coalesce != null && coalesce === this.lastCoalesceKey && now - this.lastCommitAt < COALESCE_MS;

    this.lastCoalesceKey = coalesce ?? null;
    this.lastCommitAt = now;

    if (continues) return;

    this.undoStack.push(JSON.stringify(this.current));
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Replace the whole state (project load). Recorded as one undo step. */
  replace(next: AppState): void {
    this.undoStack.push(JSON.stringify(this.current));
    this.redoStack.length = 0;
    this.lastCoalesceKey = null;
    this.current = next;
    this.emit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (prev === undefined) return false;
    this.redoStack.push(JSON.stringify(this.current));
    this.current = JSON.parse(prev) as AppState;
    this.lastCoalesceKey = null;
    this.emit();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (next === undefined) return false;
    this.undoStack.push(JSON.stringify(this.current));
    this.current = JSON.parse(next) as AppState;
    this.lastCoalesceKey = null;
    this.emit();
    return true;
  }
}
