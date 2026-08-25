import { useEffect, useMemo } from 'react';
import { Hint, LabeledSelect, Row, Section, type Option } from '@/components/Field';
import { ScrubInput } from '@/components/ScrubInput';
import { Button } from '@/components/ui/button';
import { Checkbox, CheckboxIndicator } from '@/components/ui/checkbox';
import { useAppState, useKerf, useViewState } from '@/kerf-context';
import type { AppState, InsertSource } from '@/types';

function encode(src: InsertSource): string {
  return src.kind === 'group' ? `grp:${src.groupId}` : `cut:${src.cutterId}`;
}

function decode(v: string): InsertSource | null {
  if (v.startsWith('grp:')) return { kind: 'group', groupId: v.slice(4) };
  if (v.startsWith('cut:')) return { kind: 'cutter', cutterId: Number(v.slice(4)) };
  return null;
}

/** Groups first, then loose cutters whose shape has a meaningful mating part. */
function sourceOptions(state: AppState): Option<string>[] {
  const opts: Option<string>[] = [];
  for (const gid of Object.keys(state.groups)) {
    opts.push({ value: `grp:${gid}`, label: `Twist-lock set ${gid} → pin` });
  }
  for (const c of state.cutters) {
    if (c.group) continue;
    if (c.type !== 'cyl' && c.type !== 'box' && c.type !== 'hex') continue;
    opts.push({ value: `cut:${c.id}`, label: `${c.name} #${c.id}` });
  }
  return opts;
}

export function InsertPanel() {
  const kerf = useKerf();
  const state = useAppState();
  const view = useViewState();

  const options = useMemo(() => sourceOptions(state), [state.groups, state.cutters]);
  const wanted = state.insert.source ? encode(state.insert.source) : '';
  const valid = options.some((o) => o.value === wanted);

  // The chosen source can vanish (cutter deleted, project loaded) — adopt the first.
  useEffect(() => {
    if (valid || options.length === 0) return;
    const next = decode(options[0].value);
    if (next) {
      kerf.store.update(
        (s) => {
          s.insert.source = next;
        },
        { transient: true },
      );
    }
  }, [valid, options, kerf]);

  const current = valid ? wanted : (options[0]?.value ?? '');

  return (
    <Section title="Mating insert">
      <Row>
        <LabeledSelect
          label="Build from"
          value={current}
          options={options.length ? options : [{ value: '', label: 'No holes yet' }]}
          onChange={(v) => {
            const next = decode(v);
            if (next) {
              kerf.store.update((s) => {
                s.insert.source = next;
              });
            }
          }}
        />
        <ScrubInput
          label="Clearance / side"
          unit="mm"
          value={state.insert.clearance}
          onChange={(v) =>
            kerf.store.update(
              (s) => {
                s.insert.clearance = Math.max(0, v);
              },
              { coalesce: 'insert:clearance' },
            )
          }
          step={0.01}
          min={0}
        />
      </Row>

      <label className="mb-2 flex items-center gap-2 text-[12.5px]">
        <Checkbox
          checked={state.insert.withCap}
          onCheckedChange={(d) =>
            kerf.store.update((s) => {
              s.insert.withCap = d.checked === true;
            })
          }
        >
          <CheckboxIndicator />
        </Checkbox>
        Add cap / knob on top
      </label>

      <div className="flex gap-2">
        <Button size="sm" disabled={options.length === 0} onClick={() => void kerf.generateInsert()}>
          Generate insert
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!view.hasInsert}
          onClick={() => kerf.clearInsert()}
        >
          Remove
        </Button>
      </div>

      <Hint>
        The insert copies the selected hole&rsquo;s shape shrunk by the clearance on every side, so
        it snaps or twist-locks into the printed cavity. 0.20 mm suits a P1S with a 0.4 mm nozzle;
        use 0.10–0.15 for press fits, 0.30 for free rotation.
      </Hint>
    </Section>
  );
}
