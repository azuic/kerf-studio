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

# browser checks — need `npm run dev` running in another shell
node test/ui-check.mjs       # scrub, 3D cutter controls, drag-and-drop
node test/import-check.mjs   # feeds a real Z-up STL through the file input
node test/browser-run.mjs    # worker plumbing
```

## What it does

- **Base model** — solid or hollow box, solid cylinder or cup, or an imported STL.
  STL carries no orientation metadata, so imports are read as **Z-up** (what CAD tools
  and slicers write), rotated upright, centred in XZ and dropped onto the plate; an
  **Up axis** control re-seats the mesh without a re-import for the rarer Y-up files.
  Imported meshes are checked for open and non-manifold edges on load, because a boolean
  against a mesh that is not watertight produces wrong results in any CSG engine.
  A floating action bar offers **Reset** (default proportions, and for an STL the Z-up
  reading and a re-seat on the plate) and **Delete** (back to the default box, unloading
  the mesh). Both keep your cutters, and both are undoable.
- **Cutters** — round, rectangular and hex holes, wall gaps, and lock grooves. Each is
  anchored at its **entry point** — where the cut breaks the surface — and runs `depth`
  mm from there along its own axis, with free rotation about all three axes and a free
  XYZ position. Rotation pivots about the entry point, so aiming a hole never moves where
  it enters; that is what makes side-entry and angled holes practical. `Overshoot`
  extends the cutter back past its entry face (1 mm by default) so the boolean never has
  to resolve faces coplanar with the surface.
- **Scrubbing** — every numeric field is draggable. Drag its label to scrub, hold shift
  for ten times finer, alt for ten times coarser; arrow keys step by the same amounts, and
  the field still types normally.
- **Dragging in the viewport** — grab a cutter to slide it across the bed at its current
  height, alt-drag to raise and lower it, and hold ⌘/ctrl to snap to whole millimetres.
  A drag is one undo step, not one per pointer event. Pressing anywhere that isn't a
  cutter still orbits.
- **Twist-lock sets** — three stacked cutters sharing a group id: a shaft hole, a lug
  entry notch, and a wider groove buried at the bottom. The matching pin drops through
  the shaft and notch, its lugs land in the groove, and a 90° twist locks it.
- **Mating inserts** — the selected hole's profile shrunk by a per-side clearance, with
  an optional cap or knob. 0.20 mm suits a P1S with a 0.4 mm nozzle; 0.10–0.15 for press
  fits, 0.30 for free rotation.
- **Export** — binary STL in millimetres. What you see in the viewport is what exports.
- **Projects** — undo/redo, autosave to the browser, and `.kerf.json` save/load.

## Architecture

The UI is React + [Shark UI](https://shark.vini.one) (Ark UI + Tailwind v4); everything
below `ui` is framework-agnostic and knows nothing about React.

```
src/
  main.tsx            boot, theme sync
  app.tsx             layout, viewport host, drag-and-drop
  controller.ts       everything that is not React: worker, viewport, actions
  kerf-context.tsx    React bindings over the store and the controller's view state
  types.ts            state shape + derived dimensions (plain JSON throughout)
  state/store.ts      snapshot store, undo/redo with coalescing
  state/assets.ts     the imported STL buffer, held outside undo history
  state/migrate.ts    upgrades states written by older builds
  model/geometry.ts   geometry factories, shared by the ghost renderer and the worker
  csg/booleans.ts     the boolean core (three-bvh-csg), free of worker plumbing
  csg/worker.ts       message shell around booleans.ts
  csg/engine.ts       worker client: request superseding, timing
  csg/protocol.ts     worker message types
  io/stl.ts           STL parse (ASCII + binary), binary writer, mesh checks
  io/project.ts       .kerf.json save/load, localStorage autosave
  scene/viewport.ts   renderer, orbit camera, body/insert/ghost meshes
  components/         ScrubInput, layout helpers, and ui/ from the Shark registry
  panels/             the sidebar
test/
  csg.test.ts         geometry checks — volumes against hand-computed values
  ui-check.mjs        scrub, 3D cutter controls and drag-and-drop, over CDP
  import-check.mjs    a real Z-up STL through the app's file input
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
selector to point it at the app itself. `node test/import-check.mjs` feeds a real Z-up
binary STL through the running app's file input and asserts the dimensions it reports —
both need `npm run dev` in another shell.

## Known gaps

See `docs/KERF-STUDIO-DEV.md` for the full roadmap. The notable ones:

- Cylinder and hex holes are sized by one dimension, so there are no elliptical holes;
  box and gap cutters already size independently in all three directions.
- The bayonet pin is generated from the set's stored parameters, not from manual edits
  to the three cutters it created.
- Cutters are dragged, but not rotated, in the viewport — rotation is numeric only.
- No coplanar-face merging or vertex welding before export, so STLs are larger than
  necessary and carry the T-junctions described above.
- No rounded corners on slots; sharp inside corners are stress risers in print.

## Licence

The CSG approach and the original prototype's BSP implementation derive from
[csg.js](https://github.com/evanw/csg.js) by Evan Wallace (MIT). The prototype is kept
at `legacy/kerf-studio.html` for reference.
