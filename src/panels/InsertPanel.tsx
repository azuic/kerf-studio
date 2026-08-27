import { useEffect } from 'react';
import { Hint, LabeledSelect, Row, Section, type Option } from '@/components/Field';
import { Button } from '@/components/ui/button';
import { Checkbox, CheckboxIndicator } from '@/components/ui/checkbox';
import { useAppState, useKerf, useViewState } from '@/kerf-context';
import { ProjectClearance } from '@/panels/ClearanceControls';
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

  // Deliberately not memoised on `state.cutters` / `state.groups`. The store mutates in
  // place — `cutters.push(...)` keeps the same array identity — so an identity-keyed memo
  // never invalidates and the list silently stays empty. The computation is two maps.
  const options = sourceOptions(state);
  const wanted = state.insert.source ? encode(state.insert.source) : '';
  const valid = options.some((o) => o.value === wanted);
  const signature = options.map((o) => o.value).join(',');

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
    // Keyed on the option *values*, not the freshly-built array's identity.
  }, [valid, signature, kerf]);

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
      </Row>

      <ProjectClearance />

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
        Clearance is the <em>total</em> gap between hole and insert, so 0.40 mm leaves 0.20 mm
        on each side of a round hole. &ldquo;Applied by&rdquo; chooses which side absorbs it:
        shrinking the insert leaves your hole exactly as drawn, growing the hole is what a
        real nut or bearing needs. Individual cutters can override this.
      </Hint>
    </Section>
  );
}
