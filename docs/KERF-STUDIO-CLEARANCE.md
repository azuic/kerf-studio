> **Status: implemented, with the deviations below.** This spec was written to be
> applied *before* the Phase 1 CSG migration; that migration had already shipped, so it
> was adapted rather than applied verbatim. What is built:
>
> - **§2 schema, §3 resolution, §4 per-axis application** — implemented in
>   `src/model/clearance.ts`, mapped onto the real cutter types (`cyl | box | hex | gap |
>   groove`, numeric ids) rather than the spec's `round | rect | wallGap`.
> - **§5 presets** — shipped, but **every value is doubled**. The spec states a total-gap
>   convention while listing the familiar *per-side* FDM numbers; read as totals they
>   would halve every fit, making the "slip fit" a press fit. Doubling keeps the fit
>   names honest and leaves `pla-slip` identical to what the app shipped before.
> - **§8 UI contract** — preset picker, total-gap field and mode selector on the project;
>   an inherited/overridden row per cutter. The per-axis fields are not yet exposed in the
>   UI, though the model and the file format carry them.
>
> Deviations worth knowing:
>
> - **The default is `mode: 'insert'`, not `'socket'`.** The deciding factor is what the
>   hole mates with. A *generated* mate (a plain hole with a Kerf-made insert, a bayonet
>   pin) uses `insert`, because both halves are ours and shrinking the insert keeps the
>   red cutter ghost equal to what is actually subtracted — which matters now that cutters
>   are positioned by dragging that ghost. An *external* mate (an M3 nut, a heat-set
>   insert, a bearing) must use `socket`, because the nominal number is the real part's
>   spec and there is no insert to shrink. `defaultModeForCutter` holds that mapping;
>   every cutter type that exists today takes a generated mate, and the P1 fastener
>   presets are the ones that will return `'socket'`.
> - **Bayonets are not a cutter type.** They remain three cutters sharing a group id, with
>   the set's parameters in `AppState.groups`. A set inherits clearance from whichever of
>   its members carries an override.
> - **Migration preserves geometry exactly.** The old code was not self-consistent —
>   radially it subtracted the value from each side (`dia − 2c`), axially only once
>   (`depth − c`). A single number cannot express both under a total-gap convention, so a
>   v1 project migrates to an explicit `axes: { radial: 2c, tangential: 2c, axial: c }`.
>   Asserted in `test/csg.test.ts`: a migrated insert matches the v1 geometry to 0.000%.
> - **§6 (tolerance coupon)** and **§7 (bed-opening warning)** are not built. They remain
>   P3 and the FDM-validation item respectively in `KERF-STUDIO-DEV.md`.
> - **Through-holes still take axial clearance.** §4 says they should ignore it; detecting
>   a through-hole means measuring the material along an arbitrarily rotated cut axis, so
>   it is deferred rather than faked.
> - `derived.key` caching is not implemented — inserts are regenerated on demand, which is
>   fast enough that the cache would be unused complexity today.

# Kerf Studio — Clearance Model Addendum

Companion to `KERF-STUDIO-DEV.md`. Apply **before** the Phase 1 CSG migration so
the `three-bvh-csg` insert generator is written against this data model.

## 1. Design principles

1. **Clearance is a derivation parameter, not geometry.** Inserts are never
   edited directly. They are a pure function of `(cutter, resolvedClearance)`
   and are regenerated whenever either changes. This removes the
   insert/group desync class of bugs.
2. **One number by default.** The user sees a single `clearance` value (or a
   named preset). Per-axis values exist but are opt-in.
3. **Nominal side follows FDM physics.** By default the cutter's drawn
   dimensions are the *insert's* dimensions; the *socket* is inflated. Holes
   print undersized, pegs print oversized, so growing the hole is the
   correct default (matches PrusaSlicer / Bambu Studio cut-connector
   behaviour).
4. **Global default, per-cutter override.** Mirrors the slicer
   global-settings vs per-object pattern users already know.

## 2. Schema

```ts
// ---- Clearance ----------------------------------------------------------

/** Which side absorbs the gap. */
type ClearanceMode =
  | 'socket'   // default: insert = nominal, socket inflated by clearance
  | 'insert'   // socket = nominal, insert deflated by clearance
  | 'split';   // half each way

/** Per-axis clearance in mm. All values are TOTAL gap, not per-side. */
interface ClearanceAxes {
  radial: number;      // diameter / width growth, perpendicular to cutter axis
  tangential: number;  // bayonet lug width vs slot width (rotation slop)
  axial: number;       // depth / lug thickness vs slot height
}

interface ClearanceSpec {
  /** Primary user-facing value, mm. Drives all axes unless `axes` is set. */
  value: number;
  mode: ClearanceMode;
  /** Optional per-axis override. Any axis omitted falls back to `value`. */
  axes?: Partial<ClearanceAxes>;
  /** Optional preset id this spec was derived from (for UI labelling only). */
  presetId?: string;
}

// ---- Project level ------------------------------------------------------

interface ClearancePreset {
  id: string;           // e.g. 'pla-slip'
  label: string;        // e.g. 'PLA · Slip fit'
  material: string;     // free text: 'PLA Matte', 'PETG', 'TPU 95A'
  fit: 'press' | 'slip' | 'rotating' | 'loose';
  spec: ClearanceSpec;
  /** Populated by the tolerance coupon workflow when the user calibrates. */
  calibrated?: { date: string; nozzle: number; layerHeight: number; note?: string };
}

interface ProjectSettings {
  defaultClearance: ClearanceSpec;
  presets: ClearancePreset[];
  // ...existing project fields
}

// ---- Cutter level -------------------------------------------------------

interface CutterBase {
  id: string;
  type: 'round' | 'rect' | 'hex' | 'wallGap' | 'groove' | 'bayonet';
  // ...existing positional / dimensional fields

  /**
   * undefined  -> inherit ProjectSettings.defaultClearance
   * ClearanceSpec -> override (UI shows an "overridden" badge)
   */
  clearance?: ClearanceSpec;

  /** Cached derived data. Never authored by the user. */
  derived?: {
    /** Hash of (dimensional fields + resolved clearance). */
    key: string;
    insertGeometryId?: string;
    socketGeometryId?: string;
  };
}

// Bayonet sets inherit the same field; individual lugs do not carry their own.
interface BayonetSet extends CutterBase {
  type: 'bayonet';
  lugCount: number;
  lugWidth: number;        // tangential, mm (nominal = insert lug)
  lugThickness: number;    // axial, mm
  lugProtrusion: number;   // radial, mm
  slotTravel: number;      // degrees of twist to lock
  // ...
}
```

### Migration from v1

* Every existing cutter: `clearance = undefined` (inherit).
* `ProjectSettings.defaultClearance = { value: 0.2, mode: 'socket' }`.
* Existing `insertClearance` field (if any) on cutters -> move to
  `clearance.value`, mode `'socket'`.
* Ship the built-in presets from §5 into `presets` on first load; user
  presets append after them.

## 3. Resolution

```ts
function resolveClearance(cutter: CutterBase, project: ProjectSettings): {
  mode: ClearanceMode; axes: ClearanceAxes;
} {
  const spec = cutter.clearance ?? project.defaultClearance;
  const v = spec.value;
  return {
    mode: spec.mode,
    axes: {
      radial:     spec.axes?.radial     ?? v,
      tangential: spec.axes?.tangential ?? v,
      axial:      spec.axes?.axial      ?? v,
    },
  };
}
```

Then split by mode:

```ts
function splitGap(total: number, mode: ClearanceMode) {
  // returns { socketGrow, insertShrink } in mm (total gap, not per side)
  switch (mode) {
    case 'socket': return { socketGrow: total,     insertShrink: 0 };
    case 'insert': return { socketGrow: 0,         insertShrink: total };
    case 'split':  return { socketGrow: total / 2, insertShrink: total / 2 };
  }
}
```

## 4. Per-cutter-type application

"Grow by X" always means the total dimension increases by X (i.e. X/2 per side).
Depth adjustments use the `axial` value.

| Cutter    | radial applies to            | tangential applies to        | axial applies to                    |
|-----------|------------------------------|------------------------------|-------------------------------------|
| round     | diameter                     | —                            | depth (blind holes only)            |
| rect      | width **and** height         | —                            | depth (blind only)                  |
| hex       | across-flats                 | —                            | depth (blind only)                  |
| wallGap   | gap width                    | —                            | gap depth (partial-depth gaps)      |
| groove    | groove width                 | —                            | groove depth                        |
| bayonet   | collar OD vs bore ID         | slot width vs lug width      | slot height vs lug thickness; entry channel height |

Notes:

* Through-holes ignore `axial`.
* For bayonets the **entry channel** (the straight vertical drop before the
  twist) uses `tangential` for its width and `axial` for its height — it is
  the tightest point in practice and should not get less clearance than the
  locked position.
* The lug's leading edge should keep the chamfer from the Phase 3 roadmap;
  clearance is applied to the un-chamfered profile, then the chamfer is cut.

## 5. Built-in presets

Starting values for a 0.4 mm nozzle on the P1S. All are `mode: 'socket'`.
Users are expected to replace these via the coupon workflow.

| id            | label               | value (mm) | notes                                  |
|---------------|---------------------|-----------:|----------------------------------------|
| pla-press     | PLA · Press fit     | 0.10       | needs force; permanent-ish             |
| pla-slip      | PLA · Slip fit      | 0.20       | **default**                            |
| pla-rotating  | PLA · Rotating fit  | 0.30       | bayonet collars, lids                  |
| pla-loose     | PLA · Loose         | 0.40       | dust caps, sleeves                     |
| petg-slip     | PETG · Slip fit     | 0.25       | PETG strings and blobs more            |
| petg-rotating | PETG · Rotating fit | 0.35       |                                        |
| tpu-slip      | TPU 95A · Slip fit  | 0.35       | flexible; over-extrudes on curves      |

Silk PLA behaves like standard PLA for fit; Marble/Wood PLA prints slightly
oversized on small features — nudge +0.05 mm if a coupon says so.

## 6. Tolerance coupon (pull forward from Phase 3)

Minimum viable coupon:

* One plate object: a bar of N sockets (default 7) stepped from
  `start` to `start + step*(N-1)` (default 0.05 mm to 0.35 mm, step 0.05).
* One matching insert peg at nominal size.
* Each socket embossed with its clearance value (text can be deferred; a
  notch count works as a fallback).
* After printing, the user picks the socket that matched the desired fit;
  Kerf Studio writes a new `ClearancePreset` with `calibrated` populated.

The coupon uses the same `round` cutter path as production cutters so the
calibration reflects real generator behaviour.

## 7. Bed-opening warning

Bambu Studio applies elephant-foot compensation (default ≈0.15 mm) to the
first layer, which shrinks outlines inward and effectively eats a slip-fit
clearance at a socket that opens onto the build plate.

Detection: a cutter whose socket opening face lies within `firstLayerHeight`
(default 0.2 mm) of the base's minimum Z. Emit a non-blocking warning in the
cutter panel:

> Socket opens on the build plate. Elephant-foot compensation will tighten
> this fit; consider a chamfered entry or +0.1 mm clearance.

Do not auto-adjust — the user may be compensating already in the slicer.

## 8. UI contract

* Toolbar: global clearance control — preset dropdown + numeric field.
* Cutter panel: "Clearance" row showing inherited value greyed out with an
  "Override" toggle. Overridden cutters show a small badge in the object
  list.
* Advanced disclosure (collapsed by default): `mode` selector and three
  per-axis fields. Tangential/axial fields are disabled for cutters where
  they don't apply (see §4).
* Viewport: when a cutter is selected, render the derived insert as a
  translucent ghost inside the socket. Optional "gap view" renders only the
  clearance shell (socket minus insert) in a highlight colour.

## 9. Acceptance tests

1. Changing `project.defaultClearance` regenerates every non-overridden
   cutter's insert; overridden cutters are untouched.
2. Setting `mode: 'insert'` on a round cutter yields a socket at nominal
   diameter and an insert at `nominal - value`, measured on the exported STL.
3. A bayonet with `axes.tangential = 0.1` and `value = 0.3` produces slot
   width = lugWidth + 0.1 and bore ID = collar OD + 0.3.
4. Deleting and re-creating a cutter with identical parameters produces an
   identical `derived.key`.
5. Insert export in mm passes the watertight check (Phase 1) at every preset.
6. A cutter placed with its opening on Z=0 triggers the §7 warning; the same
   cutter raised 1 mm does not.
