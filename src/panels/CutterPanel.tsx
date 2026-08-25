import { Hint, Row, Section } from '@/components/Field';
import { ScrubInput } from '@/components/ScrubInput';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, CheckboxIndicator } from '@/components/ui/checkbox';
import { useAppState, useKerf } from '@/kerf-context';
import type { KerfController } from '@/controller';
import {
  BURIED_OVERSHOOT,
  SURFACE_OVERSHOOT,
  defaultName,
  defaultParams,
} from '@/model/geometry';
import type { Cutter, CutterParams, CutterType } from '@/types';
import { baseHeight } from '@/types';
import { cn } from '@/lib/utils';

const ADD_BUTTONS: { type: CutterType; label: string }[] = [
  { type: 'cyl', label: '+ Round hole' },
  { type: 'box', label: '+ Rect hole' },
  { type: 'hex', label: '+ Hex hole' },
  { type: 'gap', label: '+ Wall gap' },
];

export function CutterPanel() {
  const kerf = useKerf();
  const state = useAppState();
  const selected = state.cutters.find((c) => c.id === state.selected) ?? null;

  return (
    <Section title="Cutters">
      <div className="mb-2 flex flex-col gap-1">
        {state.cutters.length === 0 ? (
          <Hint>No cutters yet — add a hole below.</Hint>
        ) : (
          state.cutters.map((c) => (
            <CutterRow key={c.id} cutter={c} selected={c.id === state.selected} />
          ))
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {ADD_BUTTONS.map((b) => (
          <Button key={b.type} variant="outline" size="sm" onClick={() => addCutter(kerf, b.type)}>
            {b.label}
          </Button>
        ))}
      </div>

      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => addBayonet(kerf)}>
          + Twist-lock (bayonet) set
        </Button>
      </div>

      <Hint>
        A wall gap is a long narrow slot that punches through both side walls but stops above the
        floor. A bayonet set stacks a shaft hole, a lug entry notch and a wider groove below — the
        matching pin drops in and twists 90° to lock.
      </Hint>

      {selected && <CutterProps cutter={selected} />}
    </Section>
  );
}

function CutterRow({ cutter, selected }: { cutter: Cutter; selected: boolean }) {
  const kerf = useKerf();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() =>
        kerf.edit((s) => {
          s.selected = cutter.id;
        })
      }
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          kerf.edit((s) => {
            s.selected = cutter.id;
          });
        }
      }}
      className={cn(
        'border-border bg-card flex items-center gap-2 rounded-md border px-2 py-1.5 text-[12.5px]',
        selected && 'border-primary ring-primary/40 ring-1',
      )}
    >
      <Checkbox
        checked={cutter.enabled}
        onCheckedChange={(d) =>
          kerf.edit((s) => {
            const t = s.cutters.find((x) => x.id === cutter.id);
            if (t) t.enabled = d.checked === true;
          })
        }
        onClick={(e) => e.stopPropagation()}
        aria-label={`Enable ${cutter.name}`}
      >
        <CheckboxIndicator />
      </Checkbox>
      <Badge variant={cutter.group ? 'info' : 'destructive'} className="font-mono text-[10px]">
        {cutter.group ?? 'cut'}
      </Badge>
      <span className="min-w-0 flex-1 truncate">{cutter.name}</span>
    </div>
  );
}

function CutterProps({ cutter }: { cutter: Cutter }) {
  const kerf = useKerf();
  const P = cutter.params;

  const set =
    (key: keyof CutterParams, clampMin?: number) =>
    (v: number): void =>
      kerf.edit((s) => {
        const t = s.cutters.find((x) => x.id === cutter.id);
        if (t) t.params[key] = clampMin === undefined ? v : Math.max(clampMin, v);
      }, `cutter:${cutter.id}:${String(key)}`);

  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <strong className="truncate text-[13px]">{cutter.name}</strong>
        <span className="text-muted-foreground font-mono text-[10px]">#{cutter.id}</span>
      </div>

      {(cutter.type === 'cyl' || cutter.type === 'groove') && (
        <Row>
          <ScrubInput
            label="Diameter"
            unit="mm"
            value={P.dia ?? 10}
            onChange={set('dia', 0.1)}
            step={0.25}
            min={0.1}
          />
        </Row>
      )}
      {cutter.type === 'hex' && (
        <Row>
          <ScrubInput
            label="Across flats"
            unit="mm"
            value={P.af ?? 10}
            onChange={set('af', 0.1)}
            step={0.25}
            min={0.1}
          />
        </Row>
      )}
      {(cutter.type === 'box' || cutter.type === 'gap') && (
        <Row>
          <ScrubInput
            label="Width X"
            unit="mm"
            value={P.w ?? 10}
            onChange={set('w', 0.1)}
            step={0.25}
            min={0.1}
          />
          <ScrubInput
            label="Length Z"
            unit="mm"
            value={P.l ?? 10}
            onChange={set('l', 0.1)}
            step={0.25}
            min={0.1}
          />
        </Row>
      )}

      <Row>
        <ScrubInput
          label="Depth"
          unit="mm"
          value={P.depth}
          onChange={set('depth', 0.1)}
          step={0.25}
          min={0.1}
        />
        <ScrubInput
          label="Overshoot"
          unit="mm"
          value={P.overshoot}
          onChange={set('overshoot', 0)}
          step={0.1}
          min={0}
        />
      </Row>

      <p className="text-muted-foreground mb-1 mt-1 text-[10px] font-medium tracking-wider uppercase">
        Entry point
      </p>
      <Row>
        <ScrubInput label="X" unit="mm" value={P.x} onChange={set('x')} step={0.25} />
        <ScrubInput label="Y" unit="mm" value={P.y} onChange={set('y')} step={0.25} />
        <ScrubInput label="Z" unit="mm" value={P.z} onChange={set('z')} step={0.25} />
      </Row>

      <div className="mb-1 flex items-baseline justify-between gap-2">
        <p className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
          Rotation
        </p>
        <GizmoToggle />
      </div>
      <Row>
        <ScrubInput label="Rot X" unit="°" value={P.rotX} onChange={set('rotX')} step={1} />
        <ScrubInput label="Rot Y" unit="°" value={P.rotY} onChange={set('rotY')} step={1} />
        <ScrubInput label="Rot Z" unit="°" value={P.rotZ} onChange={set('rotZ')} step={1} />
      </Row>

      <div className="mt-1 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => snapToTop(kerf, cutter.id)}>
          Snap to top
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={P.rotX === 0 && P.rotY === 0 && P.rotZ === 0}
          onClick={() => resetRotation(kerf, cutter.id)}
        >
          Reset rotation
        </Button>
        <Button variant="outline" size="sm" onClick={() => duplicate(kerf, cutter.id)}>
          Duplicate
        </Button>
        <Button variant="outline" size="sm" onClick={() => remove(kerf, cutter.id)}>
          <span className="text-destructive-foreground">Delete</span>
        </Button>
      </div>

      {cutter.group && (
        <Hint>
          Part of twist-lock set {cutter.group}. Keep shaft, entry and groove on the same X/Z. The
          insert generator builds the matching pin from the set&rsquo;s stored parameters, not from
          manual edits to these three cutters.
        </Hint>
      )}
    </div>
  );
}

function GizmoToggle() {
  const kerf = useKerf();
  const on = useAppState().showGizmo;
  return (
    <button
      type="button"
      aria-pressed={on}
      className="text-muted-foreground hover:text-foreground text-[10px] font-medium tracking-wider uppercase underline-offset-2 hover:underline"
      onClick={() =>
        kerf.edit((s) => {
          s.showGizmo = !s.showGizmo;
        })
      }
    >
      {on ? 'Hide gizmo' : 'Show gizmo'}
    </button>
  );
}

/* ---------------- actions ---------------- */

function addCutter(kerf: KerfController, type: CutterType): void {
  kerf.edit((s) => {
    const c: Cutter = {
      id: s.nextId++,
      type,
      name: defaultName(type),
      enabled: true,
      group: null,
      params: defaultParams(type, s.base),
    };
    s.cutters.push(c);
    s.selected = c.id;
  });
}

/**
 * A twist-lock set is three stacked cutters sharing a group id: a shaft hole, a lug entry
 * notch, and a wider groove buried at the bottom. The pin drops through the shaft and
 * notch, its lugs land in the groove, and a 90° twist locks it.
 */
function addBayonet(kerf: KerfController): void {
  kerf.edit((s) => {
    const gid = 'G' + s.nextGroup++;
    const h = baseHeight(s.base) || 20;
    const P = {
      dia: 12,
      lugW: 4,
      lugLen: 3.2,
      lugTh: 3,
      depth: Math.min(Math.max(8, h * 0.4), Math.max(2, h - 2)),
      x: 0,
      z: 0,
      grooveH: 3.6,
    };
    P.grooveH = P.lugTh + 0.6;
    s.groups[gid] = P;

    const surface = {
      x: P.x,
      y: h,
      z: P.z,
      rotX: 0,
      rotY: 0,
      rotZ: 0,
      overshoot: SURFACE_OVERSHOOT,
    };
    const mk = (type: CutterType, name: string, params: CutterParams): void => {
      s.cutters.push({ id: s.nextId++, type, name, enabled: true, group: gid, params });
      s.selected = s.nextId - 1;
    };
    mk('cyl', 'Bayonet · shaft', { ...surface, dia: P.dia, depth: P.depth });
    mk('box', 'Bayonet · lug entry', {
      ...surface,
      w: P.dia + 2 * P.lugLen,
      l: P.lugW,
      depth: P.depth,
    });
    mk('groove', 'Bayonet · groove', {
      ...surface,
      y: h - Math.max(0, P.depth - P.grooveH),
      dia: P.dia + 2 * P.lugLen,
      depth: P.grooveH,
      overshoot: BURIED_OVERSHOOT,
    });
    s.insert.source = { kind: 'group', groupId: gid };
  });
}

/** Put the entry point back on the model's top face without disturbing X/Z. */
function snapToTop(kerf: KerfController, id: number): void {
  kerf.edit((s) => {
    const c = s.cutters.find((x) => x.id === id);
    if (c) c.params.y = baseHeight(s.base);
  });
}

/** Square the cutter back to the bed — all three axes, not just the tilt. */
function resetRotation(kerf: KerfController, id: number): void {
  kerf.edit((s) => {
    const c = s.cutters.find((x) => x.id === id);
    if (!c) return;
    c.params.rotX = 0;
    c.params.rotY = 0;
    c.params.rotZ = 0;
  });
}

function duplicate(kerf: KerfController, id: number): void {
  kerf.edit((s) => {
    const c = s.cutters.find((x) => x.id === id);
    if (!c) return;
    const copy: Cutter = { ...structuredClone(c), id: s.nextId++, name: c.name + ' copy' };
    copy.params.x += 8;
    s.cutters.push(copy);
    s.selected = copy.id;
  });
}

function remove(kerf: KerfController, id: number): void {
  kerf.edit((s) => {
    const c = s.cutters.find((x) => x.id === id);
    if (!c) return;
    s.cutters = s.cutters.filter((x) => x.id !== id);
    if (c.group && !s.cutters.some((x) => x.group === c.group)) {
      delete s.groups[c.group];
      if (s.insert.source?.kind === 'group' && s.insert.source.groupId === c.group) {
        s.insert.source = null;
      }
    }
    if (s.insert.source?.kind === 'cutter' && s.insert.source.cutterId === id) {
      s.insert.source = null;
    }
    s.selected = s.cutters.length ? s.cutters[s.cutters.length - 1].id : null;
  });
}
