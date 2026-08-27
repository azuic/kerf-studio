import { LabeledSelect, Row, type Option } from '@/components/Field';
import { ScrubInput } from '@/components/ScrubInput';
import { Button } from '@/components/ui/button';
import { useAppState, useKerf } from '@/kerf-context';
import { resolveClearance } from '@/model/clearance';
import type { ClearanceMode, ClearanceSpec, Cutter } from '@/types';

const MODES: readonly Option<ClearanceMode>[] = [
  { value: 'insert', label: 'Shrink the insert' },
  { value: 'socket', label: 'Grow the hole' },
  { value: 'split', label: 'Split evenly' },
];

const CUSTOM = '__custom';

/**
 * The project-wide clearance control: a preset picker plus the single total-gap number.
 *
 * Every value is a TOTAL gap — the whole difference between hole and insert — so 0.4 mm
 * leaves 0.2 mm on each side of a round hole. That is deliberately not "per side"; the
 * old field was labelled per-side but only behaved that way radially.
 */
export function ProjectClearance() {
  const kerf = useKerf();
  const state = useAppState();
  const spec = state.clearance;

  const options: Option<string>[] = [
    ...state.presets.map((p) => ({ value: p.id, label: p.label })),
    { value: CUSTOM, label: 'Custom' },
  ];
  const selected = state.presets.some((p) => p.id === spec.presetId && p.spec.value === spec.value)
    ? (spec.presetId ?? CUSTOM)
    : CUSTOM;

  const setSpec = (patch: Partial<ClearanceSpec>, coalesce?: string) =>
    kerf.edit((s) => {
      s.clearance = { ...s.clearance, ...patch };
    }, coalesce);

  return (
    <>
      <Row>
        <LabeledSelect
          label="Fit preset"
          testId="clearance-preset"
          value={selected}
          options={options}
          onChange={(id) => {
            if (id === CUSTOM) {
              setSpec({ presetId: undefined });
              return;
            }
            const preset = state.presets.find((p) => p.id === id);
            if (preset) setSpec({ ...preset.spec, axes: undefined });
          }}
        />
        <ScrubInput
          label="Total gap"
          unit="mm"
          value={spec.value}
          onChange={(v) => setSpec({ value: Math.max(0, v), presetId: undefined }, 'clearance')}
          step={0.01}
          min={0}
        />
      </Row>
      <Row>
        <LabeledSelect
          label="Applied by"
          testId="clearance-mode"
          value={spec.mode}
          options={MODES}
          onChange={(mode) => setSpec({ mode })}
        />
      </Row>
    </>
  );
}

/**
 * The per-cutter row: shows the inherited value greyed out until the user overrides it.
 * An override is seeded from the resolved inherited value, so toggling it never changes
 * the geometry on its own.
 */
export function CutterClearance({ cutter }: { cutter: Cutter }) {
  const kerf = useKerf();
  const state = useAppState();
  const resolved = resolveClearance(cutter, state);
  const overridden = cutter.clearance !== undefined;

  const setOwn = (patch: Partial<ClearanceSpec>, coalesce?: string) =>
    kerf.edit((s) => {
      const c = s.cutters.find((x) => x.id === cutter.id);
      if (!c?.clearance) return;
      c.clearance = { ...c.clearance, ...patch };
    }, coalesce);

  return (
    <div className="mt-2" data-testid="cutter-clearance">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <p className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
          Clearance{' '}
          {overridden ? (
            <span className="text-warning-foreground normal-case">overridden</span>
          ) : (
            <span className="normal-case">inherited</span>
          )}
        </p>
        <Button
          variant="ghost"
          size="xs"
          data-testid="clearance-override"
          onClick={() =>
            kerf.edit((s) => {
              const c = s.cutters.find((x) => x.id === cutter.id);
              if (!c) return;
              // Seed from the resolved inherited spec so the shape does not jump.
              c.clearance = overridden
                ? undefined
                : { value: resolved.axes.radial, mode: resolved.mode };
            })
          }
        >
          {overridden ? 'Use project default' : 'Override'}
        </Button>
      </div>

      <Row>
        <ScrubInput
          label="Total gap"
          unit="mm"
          value={cutter.clearance?.value ?? resolved.axes.radial}
          disabled={!overridden}
          onChange={(v) => setOwn({ value: Math.max(0, v), presetId: undefined }, 'cut-clearance')}
          step={0.01}
          min={0}
        />
        <LabeledSelect
          label="Applied by"
          value={cutter.clearance?.mode ?? resolved.mode}
          options={MODES}
          disabled={!overridden}
          onChange={(mode) => setOwn({ mode })}
        />
      </Row>
    </div>
  );
}
