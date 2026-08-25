import { useMemo, useRef } from 'react';
import { Hint, LabeledSelect, Row, Section, type Option } from '@/components/Field';
import { ScrubInput } from '@/components/ScrubInput';
import { Button } from '@/components/ui/button';
import { useAppState, useKerf } from '@/kerf-context';
import { checkMesh } from '@/io/stl';
import { getStlRaw } from '@/state/assets';
import type { BaseType, UpAxis } from '@/types';
import { baseHeight, baseSpanX, baseSpanZ } from '@/types';

const BASE_TYPES: readonly Option<BaseType>[] = [
  { value: 'box', label: 'Solid box' },
  { value: 'hbox', label: 'Hollow box (open top)' },
  { value: 'cyl', label: 'Solid cylinder' },
  { value: 'cup', label: 'Cup (hollow cylinder)' },
  { value: 'stl', label: 'Imported STL' },
];

const UP_AXES: readonly Option<UpAxis>[] = [
  { value: 'z', label: 'Z up (CAD default)' },
  { value: 'y', label: 'Y up' },
];

export function BasePanel() {
  const kerf = useKerf();
  const state = useAppState();
  const b = state.base;
  const fileRef = useRef<HTMLInputElement>(null);

  const dim = (key: 'w' | 'd' | 'h' | 'r' | 'wall' | 'floor') => (v: number) =>
    kerf.edit((s) => {
      s.base[key] = v;
    }, `base:${key}`);

  const meshWarning = useMemo(() => {
    if (b.type !== 'stl' || !b.stlName) return null;
    const positions = getStlRaw();
    if (!positions) return null;
    const c = checkMesh(positions);
    if (c.ok) return null;
    return (
      `${c.openEdges} open edge${c.openEdges === 1 ? '' : 's'}, ${c.nonManifoldEdges} ` +
      `non-manifold, ${c.degenerate} degenerate. Booleans on a mesh that is not watertight ` +
      `can produce wrong results — repair it before cutting.`
    );
    // Re-check only when the loaded file changes.
  }, [b.type, b.stlName, b.stlTris]);

  return (
    <Section title="Base model">
      <Row>
        <LabeledSelect
          label="Type"
          value={b.type}
          options={BASE_TYPES}
          onChange={(v) =>
            kerf.edit((s) => {
              s.base.type = v;
            })
          }
        />
      </Row>

      {(b.type === 'box' || b.type === 'hbox') && (
        <Row>
          <ScrubInput label="W (X)" unit="mm" value={b.w} onChange={dim('w')} step={0.5} min={2} />
          <ScrubInput label="D (Z)" unit="mm" value={b.d} onChange={dim('d')} step={0.5} min={2} />
          <ScrubInput label="H (Y)" unit="mm" value={b.h} onChange={dim('h')} step={0.5} min={2} />
        </Row>
      )}

      {(b.type === 'cyl' || b.type === 'cup') && (
        <Row>
          <ScrubInput label="Radius" unit="mm" value={b.r} onChange={dim('r')} step={0.5} min={1} />
          <ScrubInput label="H (Y)" unit="mm" value={b.h} onChange={dim('h')} step={0.5} min={2} />
        </Row>
      )}

      {(b.type === 'hbox' || b.type === 'cup') && (
        <Row>
          <ScrubInput
            label="Wall"
            unit="mm"
            value={b.wall}
            onChange={dim('wall')}
            step={0.1}
            min={0.8}
          />
          <ScrubInput
            label="Floor"
            unit="mm"
            value={b.floor}
            onChange={dim('floor')}
            step={0.1}
            min={0.4}
          />
        </Row>
      )}

      {b.type === 'stl' && b.stlName && (
        <Row>
          <LabeledSelect
            label="Up axis in file"
            testId="up-axis"
            value={b.stlUpAxis}
            options={UP_AXES}
            onChange={(v) => kerf.setStlUpAxis(v)}
          />
        </Row>
      )}

      <div className="mt-1.5 flex gap-2">
        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
          Import STL…
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".stl"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) kerf.importStl(f);
            e.target.value = '';
          }}
        />
      </div>

      <p
        data-testid="base-readout"
        className="border-border text-muted-foreground mt-2.5 rounded-md border border-dashed px-2 py-1.5 font-mono text-[11px] leading-relaxed"
      >
        footprint {baseSpanX(b).toFixed(1)} × {baseSpanZ(b).toFixed(1)} mm · height{' '}
        {baseHeight(b).toFixed(1)} mm
        {b.type === 'stl' && b.stlTris ? ` · ${b.stlTris.toLocaleString()} tris` : ''}
      </p>

      {b.type === 'stl' && !b.stlName && (
        <Hint>
          Drop an STL anywhere on the viewport, or use the button. Files are read as Z-up (the
          CAD convention), stood upright, centred in XZ and dropped onto the plate.
        </Hint>
      )}

      {meshWarning && (
        <p className="text-destructive-foreground mt-1.5 text-[11.5px] leading-snug">
          Mesh warning: {meshWarning}
        </p>
      )}
    </Section>
  );
}
