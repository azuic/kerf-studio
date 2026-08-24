# Kerf Studio

Web tool for cutting holes, wall gaps and twist-lock (bayonet) joints into 3D models,
generating the mating insert parts, and exporting binary STL for FDM slicers
(Bambu Studio / OrcaSlicer). Units are millimetres; the viewport grid is a
256 × 256 Bambu Lab P1S build plate.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production bundle into dist/
npm test           # headless geometry checks
```

## What it does

- **Base model** — solid or hollow box, solid cylinder or cup, or an imported STL
  (centred in XZ and dropped onto the plate). Imported meshes are checked for open and
  non-manifold edges on load, because a boolean against a mesh that is not watertight
  produces wrong results in any CSG engine.
- **Cutters** — round, rectangular and hex holes, wall gaps, and lock grooves. Each has
  a depth, a start offset below the top surface, an XZ position and a Y rotation. Cuts
  always run downward; a cut starting at the surface is extended 1 mm above it so the
  boolean never has to resolve coplanar faces.
- **Twist-lock sets** — three stacked cutters sharing a group id: a shaft hole, a lug
  entry notch, and a wider groove buried at the bottom. The matching pin drops through
  the shaft and notch, its lugs land in the groove, and a 90° twist locks it.
- **Mating inserts** — the selected hole's profile shrunk by a per-side clearance, with
  an optional cap or knob. 0.20 mm suits a P1S with a 0.4 mm nozzle; 0.10–0.15 for press
  fits, 0.30 for free rotation.
- **Export** — binary STL in millimetres. What you see in the viewport is what exports.
- **Projects** — undo/redo, autosave to the browser, and `.kerf.json` save/load.

## Architecture

```
src/
  main.ts             boot
  types.ts            state shape + derived dimensions (plain JSON throughout)
  state/store.ts      snapshot store, undo/redo with coalescing
  state/assets.ts     the imported STL buffer, held outside undo history
  model/geometry.ts   geometry factories, shared by the ghost renderer and the worker
  csg/booleans.ts     the boolean core (three-bvh-csg), free of worker plumbing
  csg/worker.ts       message shell around booleans.ts
  csg/engine.ts       worker client: request superseding, timing
  csg/protocol.ts     worker message types
  io/stl.ts           STL parse (ASCII + binary), binary writer, mesh checks
  io/project.ts       .kerf.json save/load, localStorage autosave
  scene/viewport.ts   renderer, orbit camera, body/insert/ghost meshes
  ui/                 panels; each rebuilds its DOM only when structure changes
test/
  csg.test.ts         geometry checks — volumes against hand-computed values
  worker-check.ts     browser-side check of the worker plumbing
  browser-run.mjs     drives worker-check.html in headless Chrome over CDP
```

Booleans run in a Web Worker, so a slow cut never freezes the viewport. Geometry is
never serialised across the boundary — the worker receives parameter specs and rebuilds
the solids with the same factories the main thread uses for the red cutter ghosts. The
imported STL is transferred once and cached in the worker.

## Testing

`npm test` asserts geometric facts rather than shapes of objects: signed volume against
hand-computed values (a solid box minus a 48-facet cylinder, a hollow shell, a wall gap
that spares the floor), and surface closure.

Closure is checked as Σ (area-weighted normals) ≈ 0 rather than by pairing up edges.
three-bvh-csg re-triangulates clipped faces in a way that leaves **T-junctions**, so its
output is not edge-manifold — a bare box-minus-box through the library has them too. The
result is still closed and volume-exact, which is what matters for slicing. The strict
edge-pairing check (`checkMesh`) is therefore reserved for imported STLs, where an
unmatched edge is a genuine defect worth warning about.

`node test/browser-run.mjs` runs the worker checks in headless Chrome; pass a URL and a
selector to point it at the app itself.

## Known gaps

See `docs/KERF-STUDIO-DEV.md` for the full roadmap. The notable ones:

- Cutters are vertical only — no tilt, no side entry.
- The bayonet pin is generated from the set's stored parameters, not from manual edits
  to the three cutters it created.
- No coplanar-face merging or vertex welding before export, so STLs are larger than
  necessary and carry the T-junctions described above.
- No rounded corners on slots; sharp inside corners are stress risers in print.

## Licence

The CSG approach and the original prototype's BSP implementation derive from
[csg.js](https://github.com/evanw/csg.js) by Evan Wallace (MIT). The prototype is kept
at `legacy/kerf-studio.html` for reference.
