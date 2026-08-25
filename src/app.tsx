import { useEffect, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useKerf, useViewState } from '@/kerf-context';
import { BasePanel } from '@/panels/BasePanel';
import { CutterPanel } from '@/panels/CutterPanel';
import { ExportPanel, ProjectPanel } from '@/panels/ExportPanel';
import { InsertPanel } from '@/panels/InsertPanel';
import { cn } from '@/lib/utils';

export function App() {
  return (
    <>
      <Header />
      {/* min-h-0 + overflow-hidden stop the sidebar's content height from growing the
          row; without them the viewport canvas is sized to the scroll height. */}
      <main className="flex min-h-0 flex-1 flex-row overflow-hidden max-md:flex-col">
        <ScrollArea className="border-border bg-sidebar h-full w-[340px] shrink-0 border-r max-md:h-[46%] max-md:w-full max-md:border-r-0 max-md:border-b">
          <div className="pb-10">
            <BasePanel />
            <CutterPanel />
            <InsertPanel />
            <ExportPanel />
            <ProjectPanel />
          </div>
        </ScrollArea>
        <Viewport />
      </main>
    </>
  );
}

function Header() {
  return (
    <header className="border-border bg-sidebar flex shrink-0 items-baseline gap-3.5 border-b px-4 py-2.5">
      <h1 className="text-[17px] font-extrabold tracking-[0.08em] uppercase">
        Kerf<span className="text-success"> Studio</span>
      </h1>
      <p className="text-muted-foreground text-xs max-sm:hidden">
        holes · gaps · twist-locks · mating inserts — for FDM printing
      </p>
      <p className="border-border text-muted-foreground bg-card ms-auto rounded-md border px-2 py-0.5 font-mono text-[11px] max-lg:hidden">
        units: mm · plate ref: 256×256 (Bambu P1S)
      </p>
    </header>
  );
}

function Viewport() {
  const kerf = useKerf();
  const view = useViewState();
  const host = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  // Drag events fire per-element, so a naive boolean flickers as the pointer crosses
  // children. Counting enter/leave pairs is what keeps the overlay steady.
  const dragDepth = useRef(0);

  useEffect(() => {
    if (host.current) kerf.attachViewport(host.current);
  }, [kerf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) kerf.redo();
      else kerf.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kerf]);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (/\.kerf\.json$|\.json$/i.test(file.name)) kerf.loadProject(file);
    else if (/\.stl$/i.test(file.name)) kerf.importStl(file);
    else kerf.status(`${file.name} is not an .stl or .kerf.json file`, 'error');
  };

  return (
    <div
      className="relative min-w-0 flex-1 bg-[radial-gradient(1200px_700px_at_60%_30%,var(--color-neutral-50)_0%,var(--color-neutral-200)_60%,var(--color-neutral-300)_100%)] dark:bg-[radial-gradient(1200px_700px_at_60%_30%,var(--color-neutral-800)_0%,var(--color-neutral-900)_60%,var(--color-neutral-950)_100%)]"
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current++;
        if (e.dataTransfer.types.includes('Files')) setDropping(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <div ref={host} className="absolute inset-0 [&>canvas]:block" />

      <div className="border-border bg-sidebar/85 text-muted-foreground pointer-events-none absolute start-3 top-3 flex gap-3 rounded-md border px-2.5 py-1.5 text-[11px] backdrop-blur">
        <Swatch color="#9AA3AA" label="body" />
        <Swatch color="#E5484D" label="cutters" />
        <Swatch color="#2467D6" label="insert" />
      </div>

      {view.busy && (
        <div className="bg-primary text-primary-foreground pointer-events-none absolute end-3 top-3 rounded-md px-2.5 py-1.5 font-mono text-[11px]">
          computing boolean…
        </div>
      )}

      <div className="border-border bg-sidebar/85 text-muted-foreground pointer-events-none absolute bottom-2.5 start-3 rounded-md border px-2.5 py-1.5 font-mono text-[11px] backdrop-blur max-sm:hidden">
        drag rotate · wheel zoom · shift/right-drag pan · drop an .stl to import
      </div>

      {view.status && (
        <div
          id="status"
          className={cn(
            'border-border bg-sidebar/85 pointer-events-none absolute end-3 bottom-2.5 max-w-[60%] rounded-md border px-2.5 py-1.5 font-mono text-[11px] backdrop-blur',
            view.tone === 'error' ? 'text-destructive-foreground' : 'text-muted-foreground',
          )}
        >
          {view.status}
        </div>
      )}

      {dropping && (
        <div className="border-primary bg-primary/10 pointer-events-none absolute inset-3 flex items-center justify-center rounded-xl border-2 border-dashed backdrop-blur-[1px]">
          <p className="bg-sidebar border-border rounded-lg border px-4 py-2 text-sm font-medium shadow-sm">
            Drop an <span className="font-mono">.stl</span> or{' '}
            <span className="font-mono">.kerf.json</span>
          </p>
        </div>
      )}
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <i className="size-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}
