# Kerf Studio — Developer Handoff Doc

Web tool for cutting holes, wall gaps, and twist-lock (bayonet) joints into 3D models,
generating mating insert parts, and exporting binary STL for FDM slicers
(Bambu Studio / OrcaSlicer). Target printer context: Bambu Lab P1S, 0.4 mm nozzle, mm units.

**Current state:** ported off the single-file prototype. Vite + TypeScript, modules split
per §6, booleans via `three-bvh-csg` in a Web Worker, snapshot store with undo/redo and
`.kerf.json` project files. The v1 prototype is kept verbatim at
`legacy/kerf-studio.html` for reference.

---

## 1. Tech stack

| Concern            | Implementation |
|--------------------|----------------|
| Build              | Vite 8 (rolldown) + TypeScript 5 (strict) |
| Rendering          | three 0.180 (npm), `WebGLRenderer`, custom orbit controls (no OrbitControls dependency) |
| Booleans (CSG)     | `three-bvh-csg` + `three-mesh-bvh`, running in a Web Worker |
| STL import         | Hand-rolled parser, binary + ASCII autodetect (ported verbatim) |
| STL export         | Hand-rolled binary STL writer (mm) (ported verbatim) |
| UI                 | React 19 + Shark UI (Ark UI + Tailwind v4). Left sidebar + WebGL viewport |
| State              | Snapshot store with undo/redo, autosave to localStorage, `.kerf.json` files |

Design tokens (CSS vars): `--paper #EDEFF1`, `--panel #F7F8F9`, `--ink #171B1E`,
`--accent #00963B` (Bambu-ish green), `--cut #E5484D` (cutter ghosts),
`--insert #2467D6` (insert preview), monospace for all numeric fields.
Viewport shows a 256×256 grid = P1S build plate reference.

---

## 2. Data model

Everything in `AppState` is plain JSON, which is what makes snapshot undo, `.kerf.json`
and the worker protocol all fall out for free. See `src/types.ts`.

```ts
AppState = {
  base: BaseSpec,
  cutters: Cutter[],
  groups: Record<string, BayonetParams>,   // groupId like "G1"
  nextId, nextGroup,
  selected: number | null,
  insert: { source, withCap, generated, label },
  clearance: ClearanceSpec,          // project default; cutters may override
  presets: ClearancePreset[],
  autoPreview: boolean,
  showGizmo: boolean,
  xray: boolean,
}

BaseSpec = {
  type: 'box' | 'hbox' | 'cyl' | 'cup' | 'stl',
  w, d, h,          // box dims (mm)
  r,                // cylinder radius
  wall, floor,      // hollow types
  stlName, stlW, stlD, stlH, stlTris,   // descriptive only — see below
  stlUpAxis: 'z' | 'y',                 // how to read the imported file's axes
}

Cutter = {
  id, type: 'cyl' | 'box' | 'hex' | 'gap' | 'groove',
  name, enabled,
  group: string | null,          // bayonet set membership
  params: {
    dia,          // cyl, groove — diameter
    af,           // hex — across flats
    w, l,         // box, gap — X width, Z length
    depth,        // how far the cut runs from its entry point (mm)
    overshoot,    // how far it extends back past the entry face (mm)
    x, y, z,      // entry point in world space
    rotX, rotY, rotZ,   // degrees, XYZ order
  },
  clearance?: ClearanceSpec,   // omitted = inherit the project default
}

BayonetParams = { dia, lugW, lugLen, lugTh, grooveH, depth, x, z }
```

**The imported STL mesh is deliberately *not* in the state.** A 30k-triangle model is
~1 MB of floats and JSON-snapshotting that on every slider tick would make undo
unusable. The buffer lives in `state/assets.ts`; the state keeps only the descriptive
fields. `.kerf.json` carries the mesh as base64 alongside the state.

**STL orientation.** STL stores no units and no orientation, but every CAD tool and
slicer writes **Z-up**, while three.js is Y-up. The v1 prototype read the file's Y as up
(`geom.translate(-cx, -bb.min.y, -cz)` with no rotation), so a normal STL imported tipped
90° onto its back. Imports are now rotated Z-up → Y-up — `(x, y, z) → (x, z, −y)`, a
proper rotation so winding is preserved — then centred and dropped onto the plate.
`assets.ts` keeps the file **exactly as parsed** and derives the seated copy on demand,
so flipping `stlUpAxis` re-seats the mesh without a re-import and never compounds
rotations. `.kerf.json` stores the raw file plus the axis, keeping load idempotent.

**Cutter positioning convention.** A cutter is anchored at its **entry point** — the
centre of the face where the cut breaks the surface — and runs `depth` along its own −Y
axis from there, with free rotation about all three world axes. Rotation pivots about the
entry point, so aiming a hole never moves where it enters; that is what makes side-entry
and angled cuts usable, and it is why the rotation gizmo drives a proxy parked at the
entry point rather than a ghost mesh (a ghost's origin is the solid's *centre*). The
`overshoot` extends the solid back past the entry face — 1 mm for a surface cut — so the
boolean never has to resolve faces coplanar with the surface. `'gap'` is a `'box'` with
wide defaults (width = footprint + 10 so it punches both side walls; depth < height so it
never reaches the floor). `'groove'` is a cylinder cutter used as the buried wide ring of
a bayonet, anchored `depth_of_shaft − grooveH` below the top.

Superseded: v1 used `topOffset` (a distance below the model top) and `rotY` only.
`state/migrate.ts` converts it, mapping `y = modelTop − topOffset` and inferring the
overshoot from whether the cut started at the surface.

**Bayonet set = 3 stacked cutters sharing a group id:**
1. `cyl` shaft hole (dia, full depth)
2. `box` lug entry notch (w = dia + 2·lugLen, l = lugW, full depth)
3. `groove` — wider cylinder (dia + 2·lugLen) only `grooveH` tall, buried at the bottom

Pin drops through shaft + notch, lug lands in the groove, twist 90° → locked.

---

## 3. Module reference

### `model/geometry.ts` — the shared factories
Imported by both the main thread (red ghost previews) and the worker (booleans), so the
two can never disagree about where a cutter sits.

| Export | Purpose |
|---|---|
| `Solid` | `{ geom, matrix }` — geometry in local space plus its placement |
| `normalizeForCSG(geom)` | Strips everything but position + normal. three-bvh-csg requires every operand to carry the same attribute set |
| `baseSolids(base, stlPositions)` | `{ outer, inner }` — the inner void of a hollow type is subtracted by the caller |
| `cutterSolid(cutter, base, clearance)` | A positioned cutter. In `socket` mode the resolved clearance inflates it here, so the ghost keeps showing exactly what is subtracted |
| `cutterMatrix(params, depthGrow)` | The entry-point-anchored transform |
| `bayonetPinSolids` / `cutterInsertSolids` | The pieces of a mating insert, to be unioned |
| `defaultParams` / `defaultName` | New-cutter defaults, scaled to the current model |

### `csg/` — booleans
| File | Purpose |
|---|---|
| `booleans.ts` | `buildBody`, `buildInsert`. The boolean core, free of worker plumbing so it can be exercised headlessly |
| `worker.ts` | Message shell around `booleans.ts` |
| `protocol.ts` | Request/response types. Only plain JSON and transferable buffers cross the boundary |
| `engine.ts` | Worker client. Supersedes in-flight body requests (`StaleRequestError`) so a fast slider drag cannot race two results to the viewport |

Geometry is never serialised across the boundary — the worker gets parameter specs and
rebuilds the solids itself. The imported STL is transferred once via `setStl` and cached
for the worker's lifetime.

### `model/clearance.ts`
`resolveClearance(cutter, state)` folds the project default and any per-cutter override
into `{ mode, axes, socketGrow, insertShrink }`. Every value is a **total** gap.
`defaultModeForCutter` holds the generated-vs-external mate rule that decides which side
absorbs it. See `KERF-STUDIO-CLEARANCE.md`.

Clearance is resolved **once, on the main thread**, and the result is handed to the
worker — never the spec. That is what stops the ghosts and the boolean disagreeing.

### `state/`
| File | Purpose |
|---|---|
| `store.ts` | Snapshot undo/redo. `update(fn, { coalesce })` collapses successive edits sharing a key within 700 ms into one undo step, so undo steps back a whole slider drag rather than one keystroke. Mutates state **in place** and exposes a `version` counter — React subscribes to that, and identity-keyed `useMemo` over `state.cutters` is a bug |
| `assets.ts` | The imported STL buffer, outside undo history |
| `migrate.ts` | Upgrades v1 cutters (`topOffset` → entry point) and v1 clearance (one per-side number → an explicit per-axis total-gap spec) |

### `io/`
| Export | Purpose |
|---|---|
| `parseSTL(buf)` | ASCII detect: starts with "solid" AND contains "facet"; else binary (validates 84 + n·50 length) |
| `orientToYUp(positions, up)` | Rotates a Z-up file upright; returns a new buffer, never mutates the input |
| `centerOnPlate(positions)` | Centres in XZ, drops min-Y to 0 |
| `checkMesh(positions)` | Open / non-manifold / degenerate counts. For **imported** meshes only — see §4 |
| `encodeBinarySTL` / `downloadSTL` | Binary STL, little-endian, per-face normals recomputed, mm |
| `serializeProject` / `deserializeProject` | `.kerf.json`, merged over defaults so older files still load |
| `saveAutosave` / `loadAutosave` | localStorage, debounced. Skips meshes over ~200k floats to stay inside quota |

### `panels/` and `components/`
React, subscribing to the store's `version` through `useSyncExternalStore`. Because the
store mutates in place, **never memoise on `state.cutters` or `state.groups` identity** —
pushing a cutter keeps the same array, so the memo never invalidates. That bug silently
emptied the insert source list for a while.

---

## 4. Mesh quality — read this before trusting a watertightness check

`three-bvh-csg` re-triangulates clipped faces in a way that leaves **T-junctions**. Its
output is therefore *not* edge-manifold: a plain box-minus-box straight through the
library produces ~70 unmatched edges, and our box-minus-cylinder produces 365. This is a
property of the library, not of this pipeline.

The output **is** closed, and volume-exact — every volume assertion in `test/csg.test.ts`
matches its hand-computed value to 0.000%. So:

- Boolean results are verified with **Σ (area-weighted normals) ≈ 0**, which is zero on
  any closed surface whatever its triangulation and is unaffected by T-junctions.
  Residuals come out around 1e-9.
- `checkMesh`'s strict edge pairing is reserved for **imported STLs**, where an unmatched
  edge is a genuine defect worth warning the user about.

Slicers tolerate T-junctions, so this does not block printing. Welding them is the
P3 "coplanar face merge / vertex weld" item, which would also shrink exported files.

---

## 5. Known limitations

Resolved by the port: BSP performance and robustness, main-thread blocking, no mesh
validation on import, no undo/redo, no save/load.

Still open:

1. **Cutters are vertical only** (rotY only). No side-entry holes, no tilt (rotX/rotZ).
2. **Insert ignores manual edits to grouped cutters.** The bayonet pin is generated from
   the stored `BayonetParams`, not from the (possibly user-edited) three cutters. The
   clearance model treats inserts as a pure derivation, which is the groundwork for
   fixing this, but the pin's *dimensions* still come from the stored set.
3. **No rounded corners** on slots (sharp inside corners are stress risers in print).
4. **Exported STL is an unmerged triangle soup** — valid and slicer-friendly, but
   coplanar faces are not merged and T-junctions are not welded, so files are larger
   than necessary.
5. **No FDM design-rule warnings** yet (see §6).
6. **The worker is single-threaded.** Requests queue there rather than running in
   parallel. Fine for the current workload; a pool would help on dense meshes.

---

## 6. Roadmap

### P0 — port to a real project ✅ done
- ~~Vite + TypeScript, split modules~~
- ~~Replace inline BSP with `three-bvh-csg`~~
- ~~Move booleans into a Web Worker~~
- ~~Store + undo/redo, localStorage, `.kerf.json`~~

### P1 — cutter features
- ~~rotX/rotZ + side-entry orientation~~ ✅ cutters carry full rotX/rotY/rotZ and a free
  XYZ entry point; rotation pivots about the entry point.
- ~~Drag cutters in the viewport instead of numeric-only~~ ✅ raycast onto a plane through
  the entry point: ground drags slide across XZ, alt-drags run on a camera-facing vertical
  plane, ⌘/ctrl snaps to 1 mm. One undo step per drag.
- Rounded-rect slots (capsule cross-section) and corner-radius param on box cutters.
- ~~Rotate cutters in the viewport (a gizmo)~~ ✅ three's `TransformControls` in rotate
  mode, attached to a proxy `Object3D` parked at the cutter's entry point — a ghost's own
  origin is the solid's centre, which would swing the hole off its entry.
- Chamfer/countersink option at hole entry (cone frustum unioned onto cutter top)
  — kills elephant-foot binding on first layers.
- Heat-set insert pocket preset (M2/M2.5/M3/M4 tables: pilot dia, depth).
- Hex preset tied to standard nut sizes (M3 AF 5.5, M4 AF 7, M5 AF 8) + nut-trap depth.
- Counterbore preset (stacked cyl: screw shaft + head recess) — reuse group mechanic.

### P2 — joints & inserts
- ~~Per-axis clearance (XY vs Z fit differ on FDM)~~ ✅ shipped early as the clearance
  model — see `KERF-STUDIO-CLEARANCE.md`. Radial / tangential / axial, project default
  with per-cutter override, socket / insert / split modes.
- Regenerate bayonet pin from live cutter params (single source of truth).
- Cantilever snap-fit preset (arm + hook + matching window) with printable-angle checks.
- Dovetail / sliding rail joint preset.
- Print-in-place mode: emit body + insert as one STL, pre-assembled with clearance gap.

### P3 — output quality
- Optional export formats: 3MF (keeps units + multiple objects in one file), ASCII STL.
- Coplanar face merge / vertex weld before export (also fixes the T-junctions in §4).
- "Tolerance coupon" generator: 1-click test plate with the selected hole at
  0.10/0.15/0.20/0.25/0.30 clearance, labeled, for a 10-minute calibration print.
- Section view (clip plane) to inspect buried grooves.

### FDM design rules to encode (validation warnings)
- Wall gap floor: warn if `depth ≥ baseHeight − floorThickness` (gap would breach floor).
- Min feature width < 0.8 mm (2 perimeters @ 0.4 nozzle) → warn.
- Bayonet lug thickness < 3 layers (0.6 mm @ 0.2) → warn.
- Groove ceiling is an unsupported bridge of width `2·lugLen` — warn above ~8 mm,
  suggest 45° chamfered groove roof variant.
- Horizontal (side-entry, future) holes: auto-add +0.15 mm dia compensation toggle.
