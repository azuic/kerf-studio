import type { BaseSpec, BayonetParams, Cutter } from '../types';

/**
 * Worker protocol. Only plain JSON and transferable buffers cross the boundary —
 * geometry is never serialised, the worker rebuilds it from these specs using the
 * same factories the main thread uses for ghosts (src/model/geometry.ts).
 */

export interface SetStlRequest {
  id: number;
  kind: 'setStl';
  positions: Float32Array;
}

export interface BodyRequest {
  id: number;
  kind: 'body';
  base: BaseSpec;
  cutters: Cutter[];
}

export type InsertRecipe =
  | { kind: 'group'; params: BayonetParams }
  | { kind: 'cutter'; cutter: Cutter };

export interface InsertRequest {
  id: number;
  kind: 'insert';
  recipe: InsertRecipe;
  clearance: number;
  withCap: boolean;
  /** X offset that parks the preview clear of the body. */
  px: number;
}

export type CsgRequest = SetStlRequest | BodyRequest | InsertRequest;

export interface GeometryPayload {
  position: Float32Array;
  normal: Float32Array;
  triangles: number;
}

export type CsgResponse =
  | { id: number; ok: true; kind: 'setStl' }
  | { id: number; ok: true; kind: 'geometry'; payload: GeometryPayload; ms: number }
  | { id: number; ok: false; error: string };
