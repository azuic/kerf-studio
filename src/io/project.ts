import type { AppState } from '../types';
import { initialState } from '../types';
import { downloadBlob } from './stl';

/**
 * `.kerf.json` project files.
 *
 * The state is already plain JSON; the only thing needing special handling is the
 * imported STL, which is carried as a base64 float buffer alongside it.
 */

export const PROJECT_FORMAT = 'kerf-studio';
export const PROJECT_VERSION = 1;

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  savedAt: string;
  state: AppState;
  /** base64 of the Float32Array triangle soup, present only for an STL base. */
  stl?: string;
}

const AUTOSAVE_KEY = 'kerf-studio:autosave';

function toBase64(buf: ArrayBufferLike): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function fromBase64(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function serializeProject(state: AppState, stl: Float32Array | null): ProjectFile {
  const file: ProjectFile = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    state: structuredClone(state),
  };
  if (state.base.type === 'stl' && stl && stl.length) file.stl = toBase64(stl.buffer);
  return file;
}

export interface LoadedProject {
  state: AppState;
  stl: Float32Array | null;
}

export function deserializeProject(text: string): LoadedProject {
  const raw = JSON.parse(text) as Partial<ProjectFile>;
  if (raw.format !== PROJECT_FORMAT) throw new Error('not a Kerf Studio project file');
  if (typeof raw.version !== 'number' || raw.version > PROJECT_VERSION) {
    throw new Error(`project version ${String(raw.version)} is newer than this build understands`);
  }
  if (!raw.state || typeof raw.state !== 'object') throw new Error('project has no state');

  // Merge over defaults so files written by an older build still load cleanly.
  const base = initialState();
  const state: AppState = {
    ...base,
    ...raw.state,
    base: { ...base.base, ...raw.state.base },
    insert: { ...base.insert, ...raw.state.insert },
  };
  return { state, stl: raw.stl ? fromBase64(raw.stl) : null };
}

export function downloadProject(state: AppState, stl: Float32Array | null, filename: string): void {
  const json = JSON.stringify(serializeProject(state, stl));
  downloadBlob(new Blob([json], { type: 'application/json' }), filename);
}

/* --- localStorage autosave, so a refresh does not lose the model --- */

export function saveAutosave(state: AppState, stl: Float32Array | null): void {
  try {
    // Skip the mesh: a large STL blows past the ~5 MB localStorage quota. On reload the
    // base falls back to its parametric fields and the user re-imports.
    const file = serializeProject(state, stl && stl.length < 200_000 ? stl : null);
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(file));
  } catch {
    /* quota exceeded or storage disabled — autosave is best-effort */
  }
}

export function loadAutosave(): LoadedProject | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    if (!text) return null;
    return deserializeProject(text);
  } catch {
    return null;
  }
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    /* ignore */
  }
}
