import { useRef } from 'react';
import { Hint, Section } from '@/components/Field';
import { Button } from '@/components/ui/button';
import { Checkbox, CheckboxIndicator } from '@/components/ui/checkbox';
import { useAppState, useKerf, useViewState } from '@/kerf-context';

export function ExportPanel() {
  const kerf = useKerf();
  const state = useAppState();
  const view = useViewState();

  return (
    <Section title="Compute & export">
      <label className="mb-2 flex items-center gap-2 text-[12.5px]">
        <Checkbox
          checked={state.autoPreview}
          onCheckedChange={(d) => {
            kerf.store.update(
              (s) => {
                s.autoPreview = d.checked === true;
              },
              { transient: true },
            );
            if (d.checked === true) kerf.requestBody();
          }}
        >
          <CheckboxIndicator />
        </Checkbox>
        Auto-preview cuts (live boolean)
      </label>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => kerf.computeNow()}>
          Apply cuts now
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => kerf.exportBody()}>
          Download body STL
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!view.hasInsert}
          onClick={() => kerf.exportInsert()}
        >
          Download insert STL
        </Button>
      </div>

      <Hint>
        Binary STL in millimetres — drop straight into Bambu Studio / OrcaSlicer. The cut result
        you see is exactly what exports.
      </Hint>
    </Section>
  );
}

export function ProjectPanel() {
  const kerf = useKerf();
  const view = useViewState();
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <Section title="Project" className="border-b-0">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!view.canUndo} onClick={() => kerf.undo()}>
          Undo
        </Button>
        <Button variant="outline" size="sm" disabled={!view.canRedo} onClick={() => kerf.redo()}>
          Redo
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => kerf.saveProject()}>
          Save .kerf.json
        </Button>
        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
          Open…
        </Button>
        <Button variant="outline" size="sm" onClick={() => kerf.newProject()}>
          New
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.kerf.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) kerf.loadProject(f);
            e.target.value = '';
          }}
        />
      </div>

      <Hint>Work autosaves to this browser. ⌘/Ctrl+Z undoes, ⌘/Ctrl+Shift+Z redoes.</Hint>
    </Section>
  );
}
